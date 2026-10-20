-- Execution builds can evolve independently of immutable image recipes and saved-image keys.
create table public.render_library_worker_builds (
  worker_build_sha256 text primary key check (worker_build_sha256 ~ '^[a-f0-9]{64}$'),
  release_id text not null references public.render_library_recipes(release_id),
  revision text not null unique check (length(revision) between 1 and 200),
  registration jsonb not null,
  max_active_jobs_per_session smallint not null check (max_active_jobs_per_session between 1 and 2),
  parent_worker_build_sha256 text,
  compatibility_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (worker_build_sha256, release_id),
  foreign key (parent_worker_build_sha256, release_id)
    references public.render_library_worker_builds(worker_build_sha256, release_id),
  check (registration->>'workerBuildSha256' is not null
    and registration->>'workerBuildSha256'=worker_build_sha256),
  check (registration->>'releaseId' is not null and registration->>'releaseId'=release_id),
  check (registration->>'recipeBundleSha256' is not null and registration->>'recipeBundleSha256' ~ '^[a-f0-9]{64}$')
);
insert into public.render_library_worker_builds
  (worker_build_sha256,release_id,revision,registration,max_active_jobs_per_session)
  select registration->>'workerBuildSha256',release_id,release_id||':original',registration,1
  from public.render_library_recipes;
create trigger render_library_worker_build_immutable
  before update or delete on public.render_library_worker_builds
  for each row execute function public.render_library_immutable();
alter table public.render_library_worker_builds enable row level security;
revoke all on public.render_library_worker_builds from public,anon,authenticated,service_role;
grant select,insert on public.render_library_worker_builds to service_role;

-- Null preserves legacy worker behavior. Neither the approval's recipe nor its balances change.
alter table public.render_library_approvals add column active_worker_build_sha256 text
  references public.render_library_worker_builds(worker_build_sha256);

create or replace function public.render_library_claim_dispatch("dispatcherId" text, lane text default 'foreground') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; token uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(73941020261019);
  if "dispatcherId" is null or length("dispatcherId") not between 1 and 200 or lane is null or lane not in ('foreground','background') then
    raise exception 'invalid dispatcher lane';
  end if;
  if (select count(*) from public.render_library_outbox b join public.render_library_reservations r on r.job_id=b.job_id
      where b.claimed_at is not null and r.status='reserved')>=2
    or exists(select 1 from public.render_library_outbox b join public.render_library_reservations r on r.job_id=b.job_id
      where b.claimed_at is not null and r.status='reserved' and b.lane=render_library_claim_dispatch.lane) then
    return null;
  end if;
  select b.* into o from public.render_library_outbox b
    join public.render_library_jobs j on j.id=b.job_id
    join public.render_library_reservations r on r.job_id=b.job_id
    join public.render_library_approvals a on a.id=r.approval_id
    left join public.render_library_worker_builds w on w.worker_build_sha256=
      coalesce(a.active_worker_build_sha256,a.policy->'recipe'->>'workerBuildSha256')
    where b.state='pending' and a.enabled and not a.dispatcher_halted and a.expires_at>now() and r.status='reserved'
      and (render_library_claim_dispatch.lane='background' or exists(select 1 from public.render_library_sessions s
        where s.foreground_job_id=j.id))
      and (select count(*) from public.render_library_outbox busy
        join public.render_library_jobs running on running.id=busy.job_id
        join public.render_library_reservations liability on liability.job_id=busy.job_id
        where busy.claimed_at is not null and liability.status='reserved'
          and running.session_hash=j.session_hash) < coalesce(w.max_active_jobs_per_session,1)
    order by j.created_at,j.id limit 1 for update of b;
  if o.dispatch_id is null then return null; end if;
  update public.render_library_outbox set state='dispatching',claim_token=token,dispatcher_id="dispatcherId",
    lane=render_library_claim_dispatch.lane,claimed_at=now() where dispatch_id=o.dispatch_id;
  update public.render_library_jobs set stage='dispatch-uncertain',error=public.render_library_error('dispatch-uncertain'),updated_at=now() where id=o.job_id;
  return jsonb_build_object('dispatch',jsonb_build_object('contractVersion','fury.render-library@1','jobId',o.job_id,'dispatchId',o.dispatch_id),'claimToken',token);
end $$;

create or replace function public.render_library_claim_worker(dispatch jsonb,"workerBuildSha256" text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; j public.render_library_jobs; s public.render_library_sets;
  reg jsonb; c jsonb; views jsonb; expected_build text; session_limit integer;
  attempt uuid:=gen_random_uuid(); deadline timestamptz;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select * into o from public.render_library_outbox where dispatch_id=(dispatch->>'dispatchId')::uuid and job_id=(dispatch->>'jobId')::uuid for update;
  if dispatch->>'contractVersion'<>'fury.render-library@1' or o.dispatch_id is null or o.state not in ('dispatching','accepted') or o.worker_claimed_at is not null then return null; end if;
  select * into j from public.render_library_jobs where id=o.job_id;
  if j.stage not in ('queued','dispatch-uncertain') then return null; end if;
  select coalesce(a.active_worker_build_sha256,a.policy->'recipe'->>'workerBuildSha256') into expected_build
    from public.render_library_reservations r join public.render_library_approvals a on a.id=r.approval_id
    where r.job_id=j.id and r.status='reserved' and a.enabled and a.expires_at>now();
  if expected_build is null then return null; end if;
  if expected_build is distinct from "workerBuildSha256" then raise exception 'inactive worker build'; end if;
  select * into s from public.render_library_sets where set_key=j.set_key;
  select registration,max_active_jobs_per_session into reg,session_limit
    from public.render_library_worker_builds where worker_build_sha256=expected_build and release_id=s.release_id;
  if reg is null then
    select registration into reg from public.render_library_recipes where release_id=s.release_id;
    session_limit:=1;
  end if;
  if reg->>'workerBuildSha256' is distinct from "workerBuildSha256" then raise exception 'worker release mismatch'; end if;
  if (select count(*) from public.render_library_jobs running
      join public.render_library_reservations r on r.job_id=running.id
      where running.session_hash=j.session_hash and running.id<>j.id
        and running.worker_claim is not null and r.status='reserved') >= session_limit then return null; end if;
  select jsonb_agg(jsonb_build_object('cameraRef',ji.camera_ref,'imageKey',ji.image_key) order by (ji.camera_ref=j.priority_camera) desc,array_position(array['front-left-draft@1','front-draft@1','left-draft@1','rear-left-draft@1','entry-draft@1'],ji.camera_ref))
    into views from public.render_library_job_images ji where ji.job_id=j.id and ji.status='queued' and not exists(select 1 from public.render_library_images i where i.image_key=ji.image_key);
  if views is null then return null; end if;
  deadline:=now()+interval '2280 seconds';
  c:=jsonb_build_object('contractVersion','fury.render-library@1','jobId',j.id,'dispatchId',o.dispatch_id,'attemptId',attempt,'fence',j.fence+1,
    'design',jsonb_set(s.design,'{presentation,cameraRef}',to_jsonb(j.priority_camera)),'identity',s.identity,'workerBuildSha256',"workerBuildSha256",'recipeBundleSha256',reg->>'recipeBundleSha256',
    'views',views,'deadlineAt',public.render_library_iso(deadline),'limits',
    jsonb_set('{"imagesPerJob":5,"startupSeconds":180,"preparationSeconds":120,"imageSeconds":300,"jobSeconds":2100,"maxContainers":2,"concurrencyPerContainer":1,"maxActiveJobsPerSession":1,"maxCreatesPerSessionPerHour":3,"minContainers":0,"providerRetries":0}'::jsonb,
      '{maxActiveJobsPerSession}',to_jsonb(session_limit)));
  update public.render_library_outbox set worker_claimed_at=now() where dispatch_id=o.dispatch_id;
  update public.render_library_jobs set attempt_id=attempt,fence=fence+1,deadline_at=deadline,worker_claim=c,updated_at=now() where id=j.id;
  return c;
end $$;

notify pgrst,'reload schema';

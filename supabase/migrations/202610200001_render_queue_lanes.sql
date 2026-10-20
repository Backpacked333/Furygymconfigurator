-- Admission reserves money, not a GPU. No activation or budget increase.
alter table public.render_library_sessions
  add column foreground_job_id uuid references public.render_library_jobs(id),
  add column foreground_requested_at timestamptz;
alter table public.render_library_outbox
  add column lane text not null default 'foreground' check (lane in ('foreground','background'));
alter table public.render_library_approvals add column dispatcher_halted boolean not null default false;

create or replace function public.render_library_reserve_internal(command jsonb, retry_job uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.render_library_approvals; sess public.render_library_sessions; idem public.render_library_idempotency;
  prior public.render_library_jobs; j uuid; missing integer; liability bigint; d jsonb := command->'request'->'design';
  ident jsonb := command->'identity'; policy jsonb := command->'policy'; ctx jsonb := command->'context';
  sk text := ident->>'setKey'; sh text := ctx->>'sessionHash'; nh text := ctx->>'networkHash';
  key uuid := (command->'request'->>'idempotencyKey')::uuid; fingerprint text; seed jsonb; camera text; ik text; outcome text;
begin
  -- One lock order across ALL mutations, including callbacks and reconciliation. No TTL reclaim.
  perform pg_advisory_xact_lock(73941020261019);
  fingerprint := jsonb_build_object('request',(command->'request')-'idempotencyKey','retry',retry_job)::text;
  select * into sess from public.render_library_sessions where session_hash=sh for update;
  if sess.session_hash is null or sess.expires_at<=now() or sess.network_hash is distinct from nh or ctx->>'sameOriginVerified' is distinct from 'true' or ctx->>'csrfVerified' is distinct from 'true' then return public.render_library_denied('csrf-invalid'); end if;
  select * into idem from public.render_library_idempotency where session_hash=sh and idempotency_key=key;
  if idem.session_hash is not null then
    if idem.request_digest<>fingerprint then return public.render_library_denied('idempotency-conflict'); end if;
    return jsonb_build_object('status',case when idem.job_id is null then 'cached' else 'joined' end,'snapshot',public.render_library_snapshot(ident,idem.job_id));
  end if;
  select * into a from public.render_library_approvals for update;
  if a.id is null or not a.enabled or a.dispatcher_halted or a.expires_at<=now() then return public.render_library_denied('budget-unavailable'); end if;
  if policy is distinct from a.policy or policy->>'approvalId' is distinct from a.id::text or policy->>'enabled'<>'true'
    or (policy->>'globalBudgetMicroUsd')::bigint<>a.budget_micro_usd or (policy->>'expiresAt')::timestamptz<>a.expires_at then return public.render_library_denied('budget-unavailable'); end if;
  if not exists(select 1 from public.render_library_recipes r where r.release_id=ident->'recipeRelease'->>'id' and r.registration=policy->'recipe') then return public.render_library_denied('rendering-disabled'); end if;
  if command->'request'->>'contractVersion'<>'fury.render-library@1' or command->'request'->>'intent'<>'render-missing'
    or (select count(*) from jsonb_object_keys(ident->'imageKeys'))<>5 then return public.render_library_denied('invalid-request'); end if;
  insert into public.render_library_sets(set_key,design,identity,release_id) values(sk,d,ident,ident->'recipeRelease'->>'id') on conflict do nothing;
  if not exists(select 1 from public.render_library_sets s where s.set_key=sk and s.identity=ident and (s.design #- '{presentation,cameraRef}')=(d #- '{presentation,cameraRef}')) then raise exception 'identity conflict'; end if;
  for seed in select value from jsonb_array_elements(command->'seedImages') loop
    camera:=seed->'design'->'presentation'->>'cameraRef'; ik:=seed->>'imageKey';
    if seed->>'setKey'<>sk or ident->'imageKeys'->>camera is distinct from ik or seed->'provenance'->>'kind'<>'seed-cache'
      or seed->'provenance'->>'compatibilityRule'<>'native-library-400-exact@1' then raise exception 'invalid seed'; end if;
    insert into public.render_library_images(image_key,set_key,camera_ref,descriptor,receipt) values(ik,sk,camera,seed,seed->'provenance') on conflict do nothing;
    if not exists(select 1 from public.render_library_images where image_key=ik and descriptor=seed) then raise exception 'seed conflict'; end if;
  end loop;
  select count(*) into missing from jsonb_each_text(ident->'imageKeys') e where not exists(select 1 from public.render_library_images i where i.image_key=e.value);
  if missing=0 then
    update public.render_library_sessions set foreground_job_id=null,foreground_requested_at=null where session_hash=sh;
    insert into public.render_library_idempotency values(sh,key,fingerprint,null,sk);
    return jsonb_build_object('status','cached','snapshot',public.render_library_snapshot(ident));
  end if;
  select * into prior from public.render_library_jobs where set_key=sk and superseded_by is null order by created_at desc,id desc limit 1;
  if retry_job is null and prior.id is not null then
    update public.render_library_sessions set foreground_job_id=prior.id,foreground_requested_at=now() where session_hash=sh;
    if prior.stage='queued' then
      update public.render_library_jobs set priority_camera=d->'presentation'->>'cameraRef' where id=prior.id and worker_claim is null;
    end if;
    insert into public.render_library_idempotency values(sh,key,fingerprint,prior.id,sk);
    return jsonb_build_object('status','joined','snapshot',public.render_library_snapshot(ident,prior.id));
  end if;
  if retry_job is not null and (prior.id is distinct from retry_job or prior.stage<>'failed' or not prior.retry_safe) then return public.render_library_denied('unsafe-retry'); end if;
  if sess.window_start<=now()-interval '1 hour' then
    update public.render_library_sessions set window_start=now(),admitted_count=0 where session_hash=sh;
    sess.admitted_count:=0;
  end if;
  if sess.admitted_count>=3 or (select count(*) from public.render_library_jobs where network_hash=nh and created_at>now()-interval '1 hour')>=6
    or (select count(*) from public.render_library_jobs where created_at>now()-interval '1 hour')>=12 then return public.render_library_denied('rate-limited'); end if;
  if coalesce((policy->>'startupLiabilityMicroUsd')::bigint,0)<=0 or coalesce((policy->>'maxImageLiabilityMicroUsd')::bigint,0)<=0 or coalesce((policy->>'maxJobLiabilityMicroUsd')::bigint,0)<=0 then return public.render_library_denied('budget-unavailable'); end if;
  liability := (policy->>'startupLiabilityMicroUsd')::bigint+missing*(policy->>'maxImageLiabilityMicroUsd')::bigint;
  if liability>(policy->>'maxJobLiabilityMicroUsd')::bigint then return public.render_library_denied('budget-unavailable'); end if;
  if a.reserved_micro_usd+a.charged_micro_usd+liability+a.dispatcher_headroom_micro_usd>a.budget_micro_usd then return public.render_library_denied('budget-exhausted'); end if;
  insert into public.render_library_jobs(set_key,session_hash,network_hash,stage,priority_camera) values(sk,sh,nh,'queued',d->'presentation'->>'cameraRef') returning id into j;
  insert into public.render_library_job_images(job_id,image_key,camera_ref,status)
    select j,e.value,e.key,'queued' from jsonb_each_text(ident->'imageKeys') e where not exists(select 1 from public.render_library_images i where i.image_key=e.value);
  insert into public.render_library_reservations(approval_id,job_id,amount_micro_usd,status) values(a.id,j,liability,'reserved');
  update public.render_library_approvals set reserved_micro_usd=reserved_micro_usd+liability where id=a.id;
  insert into public.render_library_outbox(job_id,state) values(j,'pending');
  insert into public.render_library_idempotency values(sh,key,fingerprint,j,sk);
  update public.render_library_sessions set admitted_count=admitted_count+1,foreground_job_id=j,foreground_requested_at=now() where session_hash=sh;
  if retry_job is not null then update public.render_library_jobs set superseded_by=j,retry_safe=false where id=retry_job; end if;
  outcome:='admitted';
  return jsonb_build_object('status',outcome,'snapshot',public.render_library_snapshot(ident,j));
end $$;

-- Existing callers remain foreground dispatchers; hosted background dispatch uses the optional lane.
drop function public.render_library_claim_dispatch(text);
create function public.render_library_claim_dispatch("dispatcherId" text, lane text default 'foreground') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; token uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(73941020261019);
  if "dispatcherId" is null or length("dispatcherId") not between 1 and 200 or lane is null or lane not in ('foreground','background') then
    raise exception 'invalid dispatcher lane';
  end if;
  -- Unknown creation/termination still occupies its slot. Never reclaim on job stage or age.
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
    where b.state='pending' and a.enabled and not a.dispatcher_halted and a.expires_at>now() and r.status='reserved'
      and (render_library_claim_dispatch.lane='background' or exists(select 1 from public.render_library_sessions s
        where s.foreground_job_id=j.id))
    order by j.created_at,j.id limit 1 for update of b;
  if o.dispatch_id is null then return null; end if;
  update public.render_library_outbox set state='dispatching',claim_token=token,dispatcher_id="dispatcherId",
    lane=render_library_claim_dispatch.lane,claimed_at=now() where dispatch_id=o.dispatch_id;
  update public.render_library_jobs set stage='dispatch-uncertain',error=public.render_library_error('dispatch-uncertain'),updated_at=now() where id=o.job_id;
  return jsonb_build_object('dispatch',jsonb_build_object('contractVersion','fury.render-library@1','jobId',o.job_id,'dispatchId',o.dispatch_id),'claimToken',token);
end $$;

create or replace function public.render_library_claim_worker(dispatch jsonb,"workerBuildSha256" text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; j public.render_library_jobs; s public.render_library_sets; reg jsonb; c jsonb; views jsonb; attempt uuid:=gen_random_uuid(); deadline timestamptz;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select * into o from public.render_library_outbox where dispatch_id=(dispatch->>'dispatchId')::uuid and job_id=(dispatch->>'jobId')::uuid for update;
  if dispatch->>'contractVersion'<>'fury.render-library@1' or o.dispatch_id is null or o.state not in ('dispatching','accepted') or o.worker_claimed_at is not null then return null; end if;
  select * into j from public.render_library_jobs where id=o.job_id;
  if j.stage not in ('queued','dispatch-uncertain') then return null; end if;
  if not exists(select 1 from public.render_library_reservations r join public.render_library_approvals a on a.id=r.approval_id where r.job_id=j.id and r.status='reserved' and a.enabled and a.expires_at>now()) then return null; end if;
  select * into s from public.render_library_sets where set_key=j.set_key;
  select registration into reg from public.render_library_recipes where release_id=s.release_id;
  if reg->>'workerBuildSha256' is distinct from "workerBuildSha256" then raise exception 'worker release mismatch'; end if;
  select jsonb_agg(jsonb_build_object('cameraRef',ji.camera_ref,'imageKey',ji.image_key) order by (ji.camera_ref=j.priority_camera) desc,array_position(array['front-left-draft@1','front-draft@1','left-draft@1','rear-left-draft@1','entry-draft@1'],ji.camera_ref))
    into views from public.render_library_job_images ji where ji.job_id=j.id and ji.status='queued' and not exists(select 1 from public.render_library_images i where i.image_key=ji.image_key);
  if views is null then return null; end if;
  deadline:=now()+interval '2280 seconds';
  c:=jsonb_build_object('contractVersion','fury.render-library@1','jobId',j.id,'dispatchId',o.dispatch_id,'attemptId',attempt,'fence',j.fence+1,
    'design',jsonb_set(s.design,'{presentation,cameraRef}',to_jsonb(j.priority_camera)),'identity',s.identity,'workerBuildSha256',"workerBuildSha256",'recipeBundleSha256',reg->>'recipeBundleSha256',
    'views',views,'deadlineAt',public.render_library_iso(deadline),'limits','{"imagesPerJob":5,"startupSeconds":180,"preparationSeconds":120,"imageSeconds":300,"jobSeconds":2100,"maxContainers":2,"concurrencyPerContainer":1,"maxActiveJobsPerSession":2,"maxCreatesPerSessionPerHour":3,"minContainers":0,"providerRetries":0}'::jsonb);
  update public.render_library_outbox set worker_claimed_at=now() where dispatch_id=o.dispatch_id;
  update public.render_library_jobs set attempt_id=attempt,fence=fence+1,deadline_at=deadline,worker_claim=c,updated_at=now() where id=j.id;
  return c;
end $$;


revoke all on function public.render_library_claim_dispatch(text,text) from public, anon, authenticated;
grant execute on function public.render_library_claim_dispatch(text,text) to service_role;

-- A lane may run out of CPU headroom while its sibling is still processing a GPU job.
-- Fence new cycles before stopping the shared app; never kill the other lane to free budget.
create or replace function public.render_library_start_cpu_cycle("cycleId" uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.render_library_approvals;
begin
  select * into a from public.render_library_approvals where singleton for update;
  if a.id is null or a.dispatcher_halted or a.charged_micro_usd + a.reserved_micro_usd + 250000 > a.budget_micro_usd then
    return false;
  end if;
  if exists (select 1 from public.render_library_dispatcher_cycles where id = "cycleId") then return false; end if;
  insert into public.render_library_dispatcher_cycles(id, approval_id, charged_micro_usd)
    values ("cycleId", a.id, 250000);
  update public.render_library_approvals set charged_micro_usd = charged_micro_usd + 250000 where id = a.id;
  return true;
end $$;

create function public.render_library_halt_dispatcher_if_exhausted() returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.render_library_approvals;
begin
  select * into a from public.render_library_approvals where singleton for update;
  if a.id is null then return false; end if;
  if a.dispatcher_halted then return true; end if;
  if a.charged_micro_usd + a.reserved_micro_usd + 250000 <= a.budget_micro_usd then return false; end if;
  -- Hosted invocations have a hard 3600s timeout. A crashed CPU cycle keeps its charge;
  -- this bound never releases GPU reservations or makes a provider creation retryable.
  if exists (select 1 from public.render_library_dispatcher_cycles where approval_id=a.id
      and completed_at is null and started_at > now()-interval '1 hour') then return false; end if;
  update public.render_library_approvals set dispatcher_halted=true where id=a.id;
  return true;
end $$;

revoke all on function public.render_library_halt_dispatcher_if_exhausted() from public, anon, authenticated;
grant execute on function public.render_library_halt_dispatcher_if_exhausted() to service_role;
notify pgrst, 'reload schema';

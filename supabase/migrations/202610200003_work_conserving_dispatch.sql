-- Prioritize current explicit requests, then use otherwise idle capacity for older admitted work.
create index render_library_sessions_foreground
  on public.render_library_sessions(foreground_job_id,foreground_requested_at desc)
  where foreground_job_id is not null;

create or replace function public.render_library_claim_dispatch("dispatcherId" text, lane text default 'foreground', "workerBuildSha256" text default null) returns jsonb
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
      and coalesce("workerBuildSha256",a.policy->'recipe'->>'workerBuildSha256')=
        coalesce(a.active_worker_build_sha256,a.policy->'recipe'->>'workerBuildSha256')
      and (select count(*) from public.render_library_outbox busy
        join public.render_library_jobs running on running.id=busy.job_id
        join public.render_library_reservations liability on liability.job_id=busy.job_id
        where busy.claimed_at is not null and liability.status='reserved'
          and running.session_hash=j.session_hash) < coalesce(w.max_active_jobs_per_session,1)
    order by case when render_library_claim_dispatch.lane='foreground' then
      (select max(s.foreground_requested_at) from public.render_library_sessions s where s.foreground_job_id=j.id)
      end desc nulls last, j.created_at,j.id
    limit 1 for update of b;
  if o.dispatch_id is null then return null; end if;
  update public.render_library_outbox set state='dispatching',claim_token=token,dispatcher_id="dispatcherId",
    lane=render_library_claim_dispatch.lane,claimed_at=now() where dispatch_id=o.dispatch_id;
  update public.render_library_jobs set stage='dispatch-uncertain',error=public.render_library_error('dispatch-uncertain'),updated_at=now() where id=o.job_id;
  return jsonb_build_object('dispatch',jsonb_build_object('contractVersion','fury.render-library@1','jobId',o.job_id,'dispatchId',o.dispatch_id),'claimToken',token);
end $$;

notify pgrst,'reload schema';

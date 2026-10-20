-- Ephemeral telemetry is separate from durable artifact events, billing, and job sequencing.
create table public.render_library_samples (
  job_id uuid primary key references public.render_library_jobs(id) on delete cascade,
  attempt_id uuid not null,
  fence bigint not null check (fence > 0),
  camera_ref text not null,
  image_key text not null,
  completed integer not null check (completed between 0 and 1024),
  observed_at timestamptz not null,
  received_at timestamptz not null default now()
);
alter table public.render_library_samples enable row level security;
revoke all on public.render_library_samples from public, anon, authenticated;
grant select,insert,update,delete on public.render_library_samples to service_role;

create function public.render_library_record_samples(observation jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.render_library_jobs;
  observed timestamptz := (observation->>'observedAt')::timestamptz;
  samples integer := (observation->>'completed')::integer;
begin
  if observed < now() - interval '15 seconds' or observed > now() + interval '3 seconds'
    or samples not between 0 and 1024 or observation->>'total' is distinct from '1024'
    or samples is null or observed is null then return false; end if;
  select * into j from public.render_library_jobs where id=(observation->>'jobId')::uuid;
  if j.id is null or j.stage <> 'rendering' or j.superseded_by is not null
    or j.attempt_id is distinct from (observation->>'attemptId')::uuid
    or j.fence is distinct from (observation->>'fence')::bigint
    or j.current_camera is distinct from observation->>'cameraRef'
    or not exists(select 1 from public.render_library_job_images ji
      where ji.job_id=j.id and ji.camera_ref=j.current_camera
        and ji.image_key=observation->>'imageKey' and ji.status='rendering')
  then return false; end if;
  insert into public.render_library_samples as old(job_id,attempt_id,fence,camera_ref,image_key,completed,observed_at)
    values(j.id,j.attempt_id,j.fence,j.current_camera,observation->>'imageKey',samples,observed)
    on conflict(job_id) do update set attempt_id=excluded.attempt_id,fence=excluded.fence,
      camera_ref=excluded.camera_ref,image_key=excluded.image_key,completed=excluded.completed,
      observed_at=excluded.observed_at,received_at=now()
    where excluded.observed_at > old.observed_at
      and (old.attempt_id<>excluded.attempt_id or old.fence<>excluded.fence
        or old.image_key<>excluded.image_key or excluded.completed>=old.completed);
  return found;
end $$;

create function public.render_library_get_samples("jobId" uuid, "sessionHash" text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object('jobId',p.job_id,'attemptId',p.attempt_id,'fence',p.fence,
    'cameraRef',p.camera_ref,'imageKey',p.image_key,'completed',p.completed,'total',1024,
    'observedAt',public.render_library_iso(p.observed_at))
  from public.render_library_samples p join public.render_library_jobs j on j.id=p.job_id
    join public.render_library_job_images ji on ji.job_id=j.id and ji.camera_ref=p.camera_ref and ji.image_key=p.image_key
  where j.id="jobId" and j.stage='rendering' and ji.status='rendering' and j.superseded_by is null
    and j.current_camera=p.camera_ref and j.attempt_id=p.attempt_id and j.fence=p.fence
    and p.observed_at>now()-interval '15 seconds' and p.received_at>now()-interval '15 seconds'
    and exists(select 1 from public.render_library_idempotency k where k.job_id=j.id and k.session_hash="sessionHash")
$$;
revoke all on function public.render_library_record_samples(jsonb), public.render_library_get_samples(uuid,text) from public,anon,authenticated;
grant execute on function public.render_library_record_samples(jsonb), public.render_library_get_samples(uuid,text) to service_role;

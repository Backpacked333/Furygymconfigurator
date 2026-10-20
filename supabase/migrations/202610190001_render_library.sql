-- No activation, recipe registration or spend authority is created by this migration.
create table public.render_library_recipes (
  release_id text primary key,
  registration jsonb not null,
  created_at timestamptz not null default now()
);
create table public.render_library_approvals (
  id uuid primary key,
  singleton boolean not null default true unique check (singleton),
  enabled boolean not null default false,
  expires_at timestamptz not null,
  budget_micro_usd bigint not null check (budget_micro_usd > 0),
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  charged_micro_usd bigint not null default 0 check (charged_micro_usd >= 0),
  policy jsonb not null,
  check (reserved_micro_usd + charged_micro_usd <= budget_micro_usd)
);
create table public.render_library_sets (
  set_key text primary key check (set_key ~ '^set_[a-f0-9]{64}$'),
  design jsonb not null,
  identity jsonb not null,
  release_id text not null references public.render_library_recipes(release_id)
);
create table public.render_library_images (
  image_key text primary key check (image_key ~ '^img_[a-f0-9]{64}$'),
  set_key text not null references public.render_library_sets(set_key),
  camera_ref text not null,
  descriptor jsonb not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  unique (set_key, camera_ref)
);
create table public.render_library_sessions (
  session_hash text primary key,
  network_hash text not null,
  expires_at timestamptz not null,
  window_start timestamptz not null default now(),
  admitted_count integer not null default 0 check (admitted_count >= 0)
);
create table public.render_library_jobs (
  id uuid primary key default gen_random_uuid(),
  set_key text not null references public.render_library_sets(set_key),
  session_hash text not null references public.render_library_sessions(session_hash),
  network_hash text not null,
  stage text not null check (stage in ('queued','preparing','rendering','saving','verifying','complete','failed','blocked','dispatch-uncertain')),
  priority_camera text not null,
  attempt_id uuid,
  fence bigint not null default 0,
  retry_safe boolean not null default false,
  error jsonb,
  deadline_at timestamptz,
  worker_claim jsonb,
  current_camera text,
  last_sequence bigint not null default 0,
  superseded_by uuid references public.render_library_jobs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index render_library_one_active_set on public.render_library_jobs(set_key)
  where stage in ('queued','preparing','rendering','saving','verifying','dispatch-uncertain');
create index render_library_jobs_session on public.render_library_jobs(session_hash, created_at);
create index render_library_jobs_network on public.render_library_jobs(network_hash, created_at);
create table public.render_library_job_images (
  job_id uuid not null references public.render_library_jobs(id),
  image_key text not null,
  camera_ref text not null,
  status text not null check (status in ('queued','preparing','rendering','saving','verifying','ready','failed')),
  retry_safe boolean not null default false,
  error jsonb,
  primary key (job_id, image_key),
  unique (job_id, camera_ref)
);
create table public.render_library_reservations (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.render_library_approvals(id),
  job_id uuid not null unique references public.render_library_jobs(id),
  amount_micro_usd bigint not null check (amount_micro_usd > 0),
  status text not null check (status in ('reserved','settled')),
  termination_evidence jsonb,
  charged_micro_usd bigint check (charged_micro_usd >= 0)
);
create table public.render_library_outbox (
  dispatch_id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.render_library_jobs(id),
  state text not null check (state in ('pending','dispatching','accepted','uncertain','not-submitted','terminal')),
  claim_token uuid,
  dispatcher_id text,
  provider_call_id text,
  result jsonb,
  claimed_at timestamptz,
  worker_claimed_at timestamptz
);
create table public.render_library_events (
  event_id uuid primary key,
  job_id uuid not null references public.render_library_jobs(id),
  attempt_id uuid not null,
  fence bigint not null,
  sequence bigint not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (attempt_id, sequence)
);
create table public.render_library_idempotency (
  session_hash text not null references public.render_library_sessions(session_hash),
  idempotency_key uuid not null,
  request_digest text not null,
  -- Cache-only responses have no job; they still bind the idempotency key.
  job_id uuid references public.render_library_jobs(id),
  set_key text not null references public.render_library_sets(set_key),
  primary key (session_hash, idempotency_key)
);
create table public.render_library_artifact_intents (
  event_id uuid primary key,
  job_id uuid not null references public.render_library_jobs(id),
  attempt_id uuid not null,
  image_key text not null,
  payload jsonb not null,
  unique (job_id, attempt_id, image_key)
);

create function public.render_library_error(code text) returns jsonb
language sql immutable set search_path = pg_catalog, public as $$
  select jsonb_build_object('code', code, 'retryable', false, 'message',
    case code
      when 'rendering-disabled' then 'Rendering is not enabled. Existing images remain available.'
      when 'budget-unavailable' then 'Rendering is awaiting operator approval.'
      when 'budget-exhausted' then 'The approved rendering budget is currently unavailable.'
      when 'rate-limited' then 'Too many render requests. Please try again later.'
      when 'capacity-full' then 'All render slots are currently in use.'
      when 'csrf-invalid' then 'Your session needs to be refreshed before requesting a render.'
      when 'idempotency-conflict' then 'This request identifier was already used for another request.'
      when 'unsafe-retry' then 'This job cannot safely be retried yet.'
      when 'dispatch-uncertain' then 'We are checking whether rendering started. Please do not submit again.'
      when 'worker-failed' then 'Rendering stopped. Completed images remain available.'
      when 'verification-failed' then 'An image did not pass verification and was not published.'
      else 'This design request could not be accepted.' end)
$$;
create function public.render_library_denied(code text) returns jsonb
language sql immutable set search_path = pg_catalog, public as $$
  select jsonb_build_object('status','denied','error',public.render_library_error(code))
$$;
create function public.render_library_iso(value timestamptz) returns text
language sql immutable set search_path = pg_catalog as $$
  select to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function public.render_library_immutable() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin raise exception 'immutable render library evidence'; end
$$;
create trigger render_library_recipe_immutable before update or delete on public.render_library_recipes
  for each row execute function public.render_library_immutable();
create trigger render_library_image_immutable before update or delete on public.render_library_images
  for each row execute function public.render_library_immutable();
create trigger render_library_set_immutable before update or delete on public.render_library_sets
  for each row execute function public.render_library_immutable();

-- Read-only: neither this nor the HTTP lookup can create work or reserve money.
create function public.render_library_snapshot(identity jsonb, "jobId" uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare j public.render_library_jobs; views jsonb; ready integer; summary jsonb := 'null';
begin
  if "jobId" is not null then select * into j from public.render_library_jobs where id="jobId" and set_key=identity->>'setKey';
  else select * into j from public.render_library_jobs where set_key=identity->>'setKey' order by created_at desc,id desc limit 1; end if;
  select jsonb_agg(jsonb_build_object('cameraRef',c.camera,'imageKey',identity->'imageKeys'->>c.camera) ||
    case when i.image_key is not null then jsonb_build_object('status','ready','image',i.descriptor)
      when ji.status='failed' then jsonb_build_object('status','failed','error',coalesce(ji.error,public.render_library_error('worker-failed')),'retrySafe',ji.retry_safe)
      when ji.status in ('queued','preparing','rendering','saving','verifying') then jsonb_build_object('status','pending','stage',ji.status)
      else jsonb_build_object('status','missing') end order by c.n), count(i.image_key)
  into views,ready
  from unnest(array['front-left-draft@1','front-draft@1','left-draft@1','rear-left-draft@1','entry-draft@1']) with ordinality c(camera,n)
  left join public.render_library_images i on i.image_key=identity->'imageKeys'->>c.camera and i.set_key=identity->>'setKey'
  left join public.render_library_job_images ji on ji.job_id=j.id and ji.image_key=identity->'imageKeys'->>c.camera;
  if j.id is not null then
    summary := jsonb_build_object('id',j.id,'stage',j.stage,'completedImages',ready,'totalImages',5,
      'currentCamera',j.current_camera,'retrySafe',j.retry_safe,'error',j.error,'updatedAt',public.render_library_iso(j.updated_at));
  end if;
  return jsonb_build_object('contractVersion','fury.render-library@1','status','ok','identity',identity,
    'coverage',case when ready=5 then 'complete' when ready=0 then 'missing' else 'partial' end,
    'views',views,'job',summary,'rendering',jsonb_build_object('status','unavailable','reason',public.render_library_error('rendering-disabled')));
end $$;

create function public.render_library_touch_session("sessionHash" text,"networkHash" text,"expiresAt" timestamptz) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if "sessionHash" !~ '^[a-f0-9]{64}$' or "networkHash" !~ '^[a-f0-9]{64}$' or "expiresAt" <= now() or "expiresAt" > now()+interval '25 hours' then raise exception 'invalid session'; end if;
  insert into public.render_library_sessions(session_hash,network_hash,expires_at) values("sessionHash","networkHash","expiresAt") on conflict do nothing;
end $$;

create function public.render_library_get_job("jobId" uuid,"sessionHash" text default null) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
  select public.render_library_snapshot(s.identity,j.id) from public.render_library_jobs j join public.render_library_sets s on s.set_key=j.set_key
  where j.id="jobId" and ("sessionHash" is null or exists(select 1 from public.render_library_idempotency k where k.job_id=j.id and k.session_hash="sessionHash"))
$$;

create function public.render_library_reserve_internal(command jsonb, retry_job uuid default null) returns jsonb
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
  if a.id is null or not a.enabled or a.expires_at<=now() then return public.render_library_denied('budget-unavailable'); end if;
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
    insert into public.render_library_idempotency values(sh,key,fingerprint,null,sk);
    return jsonb_build_object('status','cached','snapshot',public.render_library_snapshot(ident));
  end if;
  select * into prior from public.render_library_jobs where set_key=sk and superseded_by is null order by created_at desc,id desc limit 1;
  if retry_job is null and prior.id is not null then
    insert into public.render_library_idempotency values(sh,key,fingerprint,prior.id,sk);
    return jsonb_build_object('status','joined','snapshot',public.render_library_snapshot(ident,prior.id));
  end if;
  if retry_job is not null and (prior.id is distinct from retry_job or prior.stage<>'failed' or not prior.retry_safe) then return public.render_library_denied('unsafe-retry'); end if;
  if (select count(*) from public.render_library_reservations where status='reserved')>=2 then return public.render_library_denied('capacity-full'); end if;
  if exists(select 1 from public.render_library_jobs x join public.render_library_reservations r on r.job_id=x.id where r.status='reserved' and x.session_hash=sh) then return public.render_library_denied('capacity-full'); end if;
  if sess.window_start<=now()-interval '1 hour' then
    update public.render_library_sessions set window_start=now(),admitted_count=0 where session_hash=sh;
    sess.admitted_count:=0;
  end if;
  if sess.admitted_count>=3 or (select count(*) from public.render_library_jobs where network_hash=nh and created_at>now()-interval '1 hour')>=6
    or (select count(*) from public.render_library_jobs where created_at>now()-interval '1 hour')>=12 then return public.render_library_denied('rate-limited'); end if;
  if coalesce((policy->>'startupLiabilityMicroUsd')::bigint,0)<=0 or coalesce((policy->>'maxImageLiabilityMicroUsd')::bigint,0)<=0 or coalesce((policy->>'maxJobLiabilityMicroUsd')::bigint,0)<=0 then return public.render_library_denied('budget-unavailable'); end if;
  liability := (policy->>'startupLiabilityMicroUsd')::bigint+missing*(policy->>'maxImageLiabilityMicroUsd')::bigint;
  if liability>(policy->>'maxJobLiabilityMicroUsd')::bigint then return public.render_library_denied('budget-unavailable'); end if;
  if a.reserved_micro_usd+a.charged_micro_usd+liability>a.budget_micro_usd then return public.render_library_denied('budget-exhausted'); end if;
  insert into public.render_library_jobs(set_key,session_hash,network_hash,stage,priority_camera) values(sk,sh,nh,'queued',d->'presentation'->>'cameraRef') returning id into j;
  insert into public.render_library_job_images(job_id,image_key,camera_ref,status)
    select j,e.value,e.key,'queued' from jsonb_each_text(ident->'imageKeys') e where not exists(select 1 from public.render_library_images i where i.image_key=e.value);
  insert into public.render_library_reservations(approval_id,job_id,amount_micro_usd,status) values(a.id,j,liability,'reserved');
  update public.render_library_approvals set reserved_micro_usd=reserved_micro_usd+liability where id=a.id;
  insert into public.render_library_outbox(job_id,state) values(j,'pending');
  insert into public.render_library_idempotency values(sh,key,fingerprint,j,sk);
  update public.render_library_sessions set admitted_count=admitted_count+1 where session_hash=sh;
  if retry_job is not null then update public.render_library_jobs set superseded_by=j,retry_safe=false where id=retry_job; end if;
  outcome:='admitted';
  return jsonb_build_object('status',outcome,'snapshot',public.render_library_snapshot(ident,j));
end $$;

-- Trusted offline importer only. The server verifies the pinned manifest AND every decoded image.
create function public.render_library_import_seed(design jsonb,identity jsonb,images jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare seed jsonb; camera text; ik text; sk text:=identity->>'setKey';
begin
  perform pg_advisory_xact_lock(73941020261019);
  insert into public.render_library_sets(set_key,design,identity,release_id) values(sk,design,identity,identity->'recipeRelease'->>'id') on conflict do nothing;
  if not exists(select 1 from public.render_library_sets s where s.set_key=sk and s.identity=render_library_import_seed.identity and (s.design #- '{presentation,cameraRef}')=(render_library_import_seed.design #- '{presentation,cameraRef}')) then raise exception 'identity conflict'; end if;
  for seed in select value from jsonb_array_elements(images) loop
    camera:=seed->'design'->'presentation'->>'cameraRef'; ik:=seed->>'imageKey';
    if seed->>'setKey' is distinct from sk or identity->'imageKeys'->>camera is distinct from ik
      or seed->'provenance'->>'kind' is distinct from 'seed-cache' or seed->'provenance'->>'compatibilityRule' is distinct from 'native-library-400-exact@1'
      or seed->'provenance'->>'manifestSha256' is distinct from 'f56574f571761b2ed3357e369d784c37318c900f0e2dc0a973a3d7a3c0a83e54'
      then raise exception 'invalid seed'; end if;
    insert into public.render_library_images(image_key,set_key,camera_ref,descriptor,receipt) values(ik,sk,camera,seed,seed->'provenance') on conflict do nothing;
    if not exists(select 1 from public.render_library_images where image_key=ik and descriptor=seed) then raise exception 'seed conflict'; end if;
  end loop;
end $$;

create function public.render_library_reserve_set(command jsonb) returns jsonb
language sql security definer set search_path = pg_catalog, public as $$
  select public.render_library_reserve_internal(command)
$$;

create function public.render_library_retry_failed("jobId" uuid,request jsonb,context jsonb,policy jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.render_library_sets; j public.render_library_jobs;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select * into j from public.render_library_jobs where id="jobId";
  if j.id is null or not exists(select 1 from public.render_library_idempotency k where k.job_id=j.id and k.session_hash=context->>'sessionHash') then return public.render_library_denied('unsafe-retry'); end if;
  select * into s from public.render_library_sets where set_key=j.set_key;
  if request->>'intent'<>'retry-failed-missing' then return public.render_library_denied('invalid-request'); end if;
  return public.render_library_reserve_internal(jsonb_build_object('request',jsonb_build_object('contractVersion',request->>'contractVersion','intent','render-missing','idempotencyKey',request->>'idempotencyKey','design',jsonb_set(s.design,'{presentation,cameraRef}',to_jsonb(j.priority_camera))),
    'identity',s.identity,'context',context,'policy',policy,'seedImages','[]'::jsonb),"jobId");
end $$;

create function public.render_library_claim_dispatch("dispatcherId" text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; token uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(73941020261019);
  if length("dispatcherId") not between 1 and 200 then raise exception 'invalid dispatcher'; end if;
  select b.* into o from public.render_library_outbox b join public.render_library_reservations r on r.job_id=b.job_id
    join public.render_library_approvals a on a.id=r.approval_id where b.state='pending' and a.enabled and a.expires_at>now() and r.status='reserved'
    order by b.dispatch_id limit 1 for update of b;
  if o.dispatch_id is null then return null; end if;
  update public.render_library_outbox set state='dispatching',claim_token=token,dispatcher_id="dispatcherId",claimed_at=now() where dispatch_id=o.dispatch_id;
  -- Until accepted is durably recorded, a lost dispatcher is visibly uncertain, not stuck queued.
  update public.render_library_jobs set stage='dispatch-uncertain',error=public.render_library_error('dispatch-uncertain'),updated_at=now() where id=o.job_id;
  return jsonb_build_object('dispatch',jsonb_build_object('contractVersion','fury.render-library@1','jobId',o.job_id,'dispatchId',o.dispatch_id),'claimToken',token);
end $$;

create function public.render_library_record_dispatch("dispatchId" uuid,"claimToken" uuid,result jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; payload jsonb:=result;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select * into o from public.render_library_outbox where dispatch_id="dispatchId" for update;
  if o.claim_token is distinct from "claimToken" or o.claim_token is null then raise exception 'dispatch fence'; end if;
  if o.result=payload then return; end if;
  if o.result is not null or o.state not in ('dispatching') then raise exception 'dispatch already recorded'; end if;
  if payload->>'status'='accepted' and length(payload->>'providerCallId') between 1 and 200 then
    update public.render_library_outbox set state='accepted',provider_call_id=payload->>'providerCallId',result=payload where dispatch_id="dispatchId";
    update public.render_library_jobs set stage=case when worker_claim is null then 'queued' else 'preparing' end,error=null,updated_at=now() where id=o.job_id and stage='dispatch-uncertain';
  elsif payload->>'status'='definitely-not-submitted' then
    update public.render_library_outbox set state='not-submitted',result=payload where dispatch_id="dispatchId";
    update public.render_library_jobs set stage='failed',error=public.render_library_error('worker-failed'),updated_at=now() where id=o.job_id;
    update public.render_library_job_images set status='failed',error=public.render_library_error('worker-failed') where job_id=o.job_id and status<>'ready';
  elsif payload->>'status'='uncertain' then
    update public.render_library_outbox set state='uncertain',result=payload where dispatch_id="dispatchId";
    update public.render_library_jobs set stage='dispatch-uncertain',error=public.render_library_error('dispatch-uncertain'),updated_at=now() where id=o.job_id and stage not in ('complete','failed');
  else raise exception 'invalid dispatch result'; end if;
end $$;

create function public.render_library_claim_worker(dispatch jsonb,"workerBuildSha256" text) returns jsonb
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
    'views',views,'deadlineAt',public.render_library_iso(deadline),'limits','{"imagesPerJob":5,"startupSeconds":180,"preparationSeconds":120,"imageSeconds":300,"jobSeconds":2100,"maxContainers":2,"concurrencyPerContainer":1,"maxActiveJobsPerSession":1,"maxCreatesPerSessionPerHour":3,"minContainers":0,"providerRetries":0}'::jsonb);
  update public.render_library_outbox set worker_claimed_at=now() where dispatch_id=o.dispatch_id;
  update public.render_library_jobs set attempt_id=attempt,fence=fence+1,deadline_at=deadline,worker_claim=c,updated_at=now() where id=j.id;
  return c;
end $$;

create function public.render_library_record_event(event jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.render_library_jobs; old jsonb; seq bigint:=(event->>'sequence')::bigint; camera text:=event->>'cameraRef';
begin
  perform pg_advisory_xact_lock(73941020261019);
  select payload into old from public.render_library_events where event_id=(event->>'eventId')::uuid;
  if old is not null then
    if old<>event then raise exception 'conflicting event'; end if;
    return '{"accepted":true}';
  end if;
  select * into j from public.render_library_jobs where id=(event->>'jobId')::uuid;
  if j.id is null or j.attempt_id is distinct from (event->>'attemptId')::uuid or j.fence<>(event->>'fence')::bigint or j.last_sequence>=seq or j.superseded_by is not null
    or exists(select 1 from public.render_library_reservations where job_id=j.id and status='settled') then return '{"accepted":false}'; end if;
  if j.stage in ('complete','failed','blocked') then return '{"accepted":false}'; end if;
  if event->>'kind'='progress' then
    if not exists(select 1 from public.render_library_job_images where job_id=j.id and camera_ref=camera and status<>'ready') then return '{"accepted":false}'; end if;
    if event->>'stage' not in ('preparing','rendering','saving','verifying') then raise exception 'invalid stage'; end if;
    -- A delayed progress message cannot regress a specific camera's phase.
    update public.render_library_job_images set status=event->>'stage' where job_id=j.id and camera_ref=camera
      and array_position(array['queued','preparing','rendering','saving','verifying'],status)<=array_position(array['queued','preparing','rendering','saving','verifying'],event->>'stage');
    if found then update public.render_library_jobs set stage=event->>'stage',current_camera=camera,error=null,updated_at=now() where id=j.id; end if;
  elsif event->>'kind'='artifact' then
    -- The service publishes verified bytes FIRST. An event cannot manufacture readiness.
    if not exists(select 1 from public.render_library_images where image_key=event->'receipt'->>'imageKey' and receipt=event->'receipt') then return '{"accepted":false}'; end if;
  elsif event->>'kind'='terminal' then
    if event->>'outcome'='complete' then
      if (select count(*) from public.render_library_images where set_key=j.set_key)<>5 then return '{"accepted":false}'; end if;
      update public.render_library_jobs set stage='complete',error=null,current_camera=null,updated_at=now() where id=j.id;
    elsif event->>'outcome'='failed' then
      update public.render_library_jobs set stage='failed',error=coalesce(nullif(event->'error','null'::jsonb),public.render_library_error('worker-failed')),current_camera=null,updated_at=now() where id=j.id;
      update public.render_library_job_images set status='failed',error=coalesce(nullif(event->'error','null'::jsonb),public.render_library_error('worker-failed')) where job_id=j.id and status<>'ready';
    else raise exception 'invalid outcome'; end if;
  else raise exception 'invalid event'; end if;
  insert into public.render_library_events(event_id,job_id,attempt_id,fence,sequence,payload) values((event->>'eventId')::uuid,j.id,j.attempt_id,j.fence,seq,event);
  update public.render_library_jobs set last_sequence=seq where id=j.id;
  return '{"accepted":true}';
end $$;

create function public.render_library_publish_asset("jobId" uuid,"attemptId" uuid,fence bigint,artifact jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.render_library_jobs; s public.render_library_sets; img jsonb:=artifact->'image'; receipt jsonb:=artifact->'receipt'; camera text:=img->'design'->'presentation'->>'cameraRef'; old public.render_library_images; intent jsonb; accepted jsonb;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select * into j from public.render_library_jobs where id="jobId";
  select * into old from public.render_library_images where image_key=img->>'imageKey';
  if old.image_key is not null then
    if old.descriptor=img and old.receipt=receipt and receipt->>'jobId'="jobId"::text and receipt->>'attemptId'="attemptId"::text and j.fence=render_library_publish_asset.fence then return '{"published":true}'; end if;
    raise exception 'immutable artifact conflict';
  end if;
  if j.id is null or j.attempt_id is distinct from "attemptId" or j.fence<>render_library_publish_asset.fence or j.worker_claim is null or j.superseded_by is not null or j.deadline_at<=now()
    or j.stage in ('complete','failed','blocked') or exists(select 1 from public.render_library_reservations where job_id=j.id and status='settled') then return '{"published":false}'; end if;
  select payload into intent from public.render_library_artifact_intents ai where ai.job_id=j.id and ai.attempt_id=j.attempt_id and ai.image_key=img->>'imageKey';
  if intent is null or intent->'receipt'<>receipt or (intent->>'sequence')::bigint<=j.last_sequence then return '{"published":false}'; end if;
  select * into s from public.render_library_sets where set_key=j.set_key;
  if img->>'setKey' is distinct from s.set_key or s.identity->'imageKeys'->>camera is distinct from img->>'imageKey' or receipt->>'imageKey' is distinct from img->>'imageKey'
    or receipt->>'jobId' is distinct from j.id::text or receipt->>'attemptId' is distinct from j.attempt_id::text or receipt->'design' is distinct from img->'design'
    or ((receipt->'design') #- '{presentation,cameraRef}') is distinct from (s.design #- '{presentation,cameraRef}')
    or receipt->'recipeRelease' is distinct from s.identity->'recipeRelease' or img->'recipeRelease' is distinct from s.identity->'recipeRelease'
    or receipt->>'sha256' is distinct from img->>'sha256' or receipt->>'workerBuildSha256' is distinct from j.worker_claim->>'workerBuildSha256'
    or receipt->>'recipeBundleSha256' is distinct from j.worker_claim->>'recipeBundleSha256'
    or img->'provenance'->>'kind' is distinct from 'native-worker' or img->'provenance'->>'receiptSha256' is distinct from artifact->>'receiptSha256'
    or img->>'bytes' is distinct from receipt->>'bytes' or img->>'width' is distinct from receipt->>'width' or img->>'height' is distinct from receipt->>'height'
    or not exists(select 1 from public.render_library_job_images where job_id=j.id and image_key=img->>'imageKey') then raise exception 'artifact binding'; end if;
  insert into public.render_library_images(image_key,set_key,camera_ref,descriptor,receipt) values(img->>'imageKey',s.set_key,camera,img,receipt);
  accepted:=public.render_library_record_event(intent);
  if accepted->>'accepted'<>'true' then raise exception 'artifact event rejected'; end if;
  update public.render_library_job_images set status='ready',error=null where job_id=j.id and image_key=img->>'imageKey';
  update public.render_library_jobs set updated_at=now() where id=j.id;
  return '{"published":true}';
end $$;

create function public.render_library_prepare_artifact(event jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.render_library_jobs; old jsonb;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select payload into old from public.render_library_events where event_id=(event->>'eventId')::uuid;
  if old is not null then
    if old<>event then raise exception 'conflicting event'; end if;
    return '{"accepted":true}';
  end if;
  select * into j from public.render_library_jobs where id=(event->>'jobId')::uuid;
  if j.id is null or j.attempt_id is distinct from (event->>'attemptId')::uuid or j.fence<>(event->>'fence')::bigint or j.last_sequence>=(event->>'sequence')::bigint
    or j.stage in ('complete','failed','blocked') or j.superseded_by is not null or j.deadline_at<=now()
    or exists(select 1 from public.render_library_reservations where job_id=j.id and status='settled') then return '{"accepted":false}'; end if;
  if event->>'kind'<>'artifact' or not exists(select 1 from public.render_library_job_images where job_id=j.id and image_key=event->'receipt'->>'imageKey') then raise exception 'artifact binding'; end if;
  insert into public.render_library_artifact_intents values((event->>'eventId')::uuid,j.id,j.attempt_id,event->'receipt'->>'imageKey',event) on conflict do nothing;
  if not exists(select 1 from public.render_library_artifact_intents where event_id=(event->>'eventId')::uuid and payload=event) then raise exception 'conflicting artifact intent'; end if;
  return '{"accepted":true}';
end $$;

-- Callable ONLY by the independently authenticated reconciliation operator, not worker HTTP.
create function public.render_library_reconcile_terminal("jobId" uuid,evidence jsonb,"chargedMicroUsd" bigint) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.render_library_reservations; o public.render_library_outbox; ready integer;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select * into r from public.render_library_reservations where job_id="jobId" for update;
  select * into o from public.render_library_outbox where job_id="jobId";
  if r.id is null or evidence->>'dispatchId' is distinct from o.dispatch_id::text or "chargedMicroUsd" is null or "chargedMicroUsd"<0 or "chargedMicroUsd">r.amount_micro_usd then raise exception 'invalid reconciliation'; end if;
  if r.status='settled' then
    if r.termination_evidence<>evidence or r.charged_micro_usd<>"chargedMicroUsd" then raise exception 'conflicting reconciliation'; end if;
    return jsonb_build_object('retrySafe',(select retry_safe from public.render_library_jobs where id="jobId"));
  end if;
  if evidence->>'kind'='never-submitted' then
    if o.state<>'not-submitted' or o.provider_call_id is not null or "chargedMicroUsd"<>0 then raise exception 'no proof of non submission'; end if;
  elsif evidence->>'kind'='provider-terminal' then
    if evidence->>'providerCallId' is null or evidence->>'evidenceSha256' is null or evidence->>'observedAt' is null or o.claimed_at is null
      or length(evidence->>'providerCallId') not between 1 and 200 or (o.provider_call_id is not null and evidence->>'providerCallId'<>o.provider_call_id)
      or evidence->>'evidenceSha256' !~ '^[a-f0-9]{64}$' or (evidence->>'observedAt')::timestamptz>now()+interval '1 minute'
      or (evidence->>'observedAt')::timestamptz<o.claimed_at then raise exception 'invalid provider evidence'; end if;
  else raise exception 'provider terminal evidence required'; end if;
  update public.render_library_approvals set reserved_micro_usd=reserved_micro_usd-r.amount_micro_usd,charged_micro_usd=charged_micro_usd+"chargedMicroUsd" where id=r.approval_id;
  update public.render_library_reservations set status='settled',termination_evidence=evidence,charged_micro_usd="chargedMicroUsd" where id=r.id;
  update public.render_library_outbox set state='terminal',provider_call_id=coalesce(provider_call_id,evidence->>'providerCallId') where dispatch_id=o.dispatch_id;
  select count(*) into ready from public.render_library_images where set_key=(select set_key from public.render_library_jobs where id="jobId");
  update public.render_library_jobs set stage=case when ready=5 then 'complete' else 'failed' end,retry_safe=ready<5,
    error=case when ready=5 then null else public.render_library_error('worker-failed') end,current_camera=null,updated_at=now() where id="jobId";
  update public.render_library_job_images set status='failed',retry_safe=true,error=public.render_library_error('worker-failed') where job_id="jobId" and status<>'ready';
  return jsonb_build_object('retrySafe',ready<5);
end $$;

-- Service-role boundary. No browser can read the ledger, mint sessions, mutate jobs or upload.
do $$ declare t text; f record; begin
  foreach t in array array['recipes','approvals','sets','images','jobs','job_images','reservations','outbox','events','sessions','idempotency','artifact_intents'] loop
    execute format('alter table public.render_library_%I enable row level security',t);
    execute format('revoke all on public.render_library_%I from public, anon, authenticated',t);
    execute format('grant select, insert, update, delete on public.render_library_%I to service_role',t);
  end loop;
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'render_library_%' loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

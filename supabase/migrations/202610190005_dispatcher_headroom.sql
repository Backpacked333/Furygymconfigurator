alter table public.render_library_approvals add column dispatcher_headroom_micro_usd bigint not null default 0 check (dispatcher_headroom_micro_usd >= 0);

-- Keep CPU recovery funded when a new GPU reservation approaches the cap.
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
  if a.reserved_micro_usd+a.charged_micro_usd+liability+a.dispatcher_headroom_micro_usd>a.budget_micro_usd then return public.render_library_denied('budget-exhausted'); end if;
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

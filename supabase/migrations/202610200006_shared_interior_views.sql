-- Interior views are keyed only by what the room camera sees (interior-visible@1), so one saved
-- interior image is shared by every set that differs only in exterior choices. Images stay bound
-- to the set that published them; readers find them by image key from any set.
create or replace function public.render_library_snapshot(identity jsonb, "jobId" uuid default null) returns jsonb
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
  left join public.render_library_images i on i.image_key=identity->'imageKeys'->>c.camera
  left join public.render_library_job_images ji on ji.job_id=j.id and ji.image_key=identity->'imageKeys'->>c.camera;
  if j.id is not null then
    summary := jsonb_build_object('id',j.id,'stage',j.stage,'completedImages',ready,'totalImages',5,
      'currentCamera',j.current_camera,'retrySafe',j.retry_safe,'error',j.error,'updatedAt',public.render_library_iso(j.updated_at));
  end if;
  return jsonb_build_object('contractVersion','fury.render-library@1','status','ok','identity',identity,
    'coverage',case when ready=5 then 'complete' when ready=0 then 'missing' else 'partial' end,
    'views',views,'job',summary,'rendering',jsonb_build_object('status','unavailable','reason',public.render_library_error('rendering-disabled')));
end $$;

-- A job is complete when every image key of its set exists, wherever it was published.
create function public.render_library_set_ready(sk text) returns integer
language sql stable security definer set search_path = pg_catalog, public as $$
  select count(*)::integer from public.render_library_sets s cross join jsonb_each_text(s.identity->'imageKeys') e
  where s.set_key=sk and exists(select 1 from public.render_library_images i where i.image_key=e.value)
$$;
revoke all on function public.render_library_set_ready(text) from public, anon, authenticated;

create or replace function public.render_library_record_event(event jsonb) returns jsonb
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
    update public.render_library_job_images set status=event->>'stage' where job_id=j.id and camera_ref=camera
      and array_position(array['queued','preparing','rendering','saving','verifying'],status)<=array_position(array['queued','preparing','rendering','saving','verifying'],event->>'stage');
    if found then update public.render_library_jobs set stage=event->>'stage',current_camera=camera,error=null,updated_at=now() where id=j.id; end if;
  elsif event->>'kind'='artifact' then
    if not exists(select 1 from public.render_library_images where image_key=event->'receipt'->>'imageKey' and receipt=event->'receipt') then return '{"accepted":false}'; end if;
  elsif event->>'kind'='terminal' then
    if event->>'outcome'='complete' then
      if public.render_library_set_ready(j.set_key)<>5 then return '{"accepted":false}'; end if;
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

-- The interior receipt carries the interior-visible design: the set's design with exterior-only
-- choices collapsed to the neutral representative and the interior camera selected.
create function public.render_library_view_design(design jsonb, camera text) returns jsonb
language sql immutable as $$
  select case when camera='entry-draft@1' then
    jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(design,'{presentation,cameraRef}',to_jsonb(camera)),
      '{config,structure,addons}','[]'::jsonb),'{config,structure,railing}','"glass"'::jsonb),
      '{config,appearance,finish}','"obsidian"'::jsonb),'{config,appearance,accent}','false'::jsonb)
    else jsonb_set(design,'{presentation,cameraRef}',to_jsonb(camera)) end
$$;
revoke all on function public.render_library_view_design(jsonb, text) from public, anon, authenticated;

create or replace function public.render_library_publish_asset("jobId" uuid,"attemptId" uuid,fence bigint,artifact jsonb) returns jsonb
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
    or camera is null or receipt->'design' is distinct from public.render_library_view_design(s.design,camera)
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

create or replace function public.render_library_reconcile_terminal("jobId" uuid,evidence jsonb,"chargedMicroUsd" bigint) returns jsonb
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
  ready:=public.render_library_set_ready((select set_key from public.render_library_jobs where id="jobId"));
  update public.render_library_jobs set stage=case when ready=5 then 'complete' else 'failed' end,retry_safe=ready<5,
    error=case when ready=5 then null else public.render_library_error('worker-failed') end,current_camera=null,updated_at=now() where id="jobId";
  update public.render_library_job_images set status='failed',retry_safe=true,error=public.render_library_error('worker-failed') where job_id="jobId" and status<>'ready';
  return jsonb_build_object('retrySafe',ready<5);
end $$;

grant execute on function public.render_library_set_ready(text) to service_role;
grant execute on function public.render_library_view_design(jsonb, text) to service_role;

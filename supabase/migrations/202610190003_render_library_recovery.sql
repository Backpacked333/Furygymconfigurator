-- Resolve a discovered allocation without reopening dispatch or changing provider identity.
create or replace function public.render_library_record_dispatch("dispatchId" uuid,"claimToken" uuid,result jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; payload jsonb:=result;
begin
  perform pg_advisory_xact_lock(73941020261019);
  select * into o from public.render_library_outbox where dispatch_id="dispatchId" for update;
  if o.claim_token is distinct from "claimToken" or o.claim_token is null then raise exception 'dispatch fence'; end if;
  if o.result=payload then return; end if;
  if not (o.state='dispatching' and o.result is null) and not (
    o.state='uncertain' and o.result->>'status'='uncertain' and o.provider_call_id is null
    and payload->>'status'='accepted'
  ) then raise exception 'dispatch already recorded'; end if;
  if payload->>'status'='accepted' and jsonb_typeof(payload->'providerCallId')='string' and length(payload->>'providerCallId') between 1 and 200 then
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

-- Reservation amounts are fixed at admission; operator policy may change before recovery.
create function public.render_library_dispatch_reservation("dispatchId" uuid,"claimToken" uuid) returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $$
declare o public.render_library_outbox; amount bigint;
begin
  select * into o from public.render_library_outbox where dispatch_id="dispatchId";
  if o.claim_token is distinct from "claimToken" or o.claim_token is null then raise exception 'dispatch fence'; end if;
  select amount_micro_usd into amount from public.render_library_reservations where job_id=o.job_id;
  if amount is null or amount<=0 then raise exception 'reservation missing'; end if;
  return amount;
end $$;

revoke all on function public.render_library_dispatch_reservation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.render_library_dispatch_reservation(uuid,uuid) to service_role;

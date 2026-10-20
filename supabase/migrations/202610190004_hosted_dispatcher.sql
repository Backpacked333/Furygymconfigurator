-- CPU coordination shares the cumulative GPU budget; a crashed cycle keeps its full charge.
create table public.render_library_dispatcher_cycles (
  id uuid primary key,
  approval_id uuid not null references public.render_library_approvals(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  charged_micro_usd bigint not null check (charged_micro_usd between 100 and 250000),
  outcome text
);
alter table public.render_library_dispatcher_cycles enable row level security;
revoke all on public.render_library_dispatcher_cycles from anon, authenticated;
grant all on public.render_library_dispatcher_cycles to service_role;

create function public.render_library_start_cpu_cycle("cycleId" uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.render_library_approvals;
begin
  select * into a from public.render_library_approvals where singleton for update;
  if a.id is null or a.charged_micro_usd + a.reserved_micro_usd + 250000 > a.budget_micro_usd then
    return false;
  end if;
  -- Never repeat a cycle after an ambiguous acknowledgement.
  if exists (select 1 from public.render_library_dispatcher_cycles where id = "cycleId") then
    return false;
  end if;
  insert into public.render_library_dispatcher_cycles(id, approval_id, charged_micro_usd)
    values ("cycleId", a.id, 250000);
  update public.render_library_approvals set charged_micro_usd = charged_micro_usd + 250000 where id = a.id;
  return true;
end $$;

create function public.render_library_finish_cpu_cycle("cycleId" uuid, "result" text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.render_library_dispatcher_cycles; charge bigint;
begin
  -- Same approval-first lock order as GPU admission and CPU start.
  perform 1 from public.render_library_approvals where singleton for update;
  select * into c from public.render_library_dispatcher_cycles where id = "cycleId" for update;
  if c.id is null or c.completed_at is not null then return; end if;
  charge := least(250000, greatest(100, ceil(extract(epoch from (clock_timestamp() - c.started_at)) * 50)::bigint + 100));
  update public.render_library_approvals
    set charged_micro_usd = charged_micro_usd - (c.charged_micro_usd - charge)
    where id = c.approval_id;
  update public.render_library_dispatcher_cycles
    set completed_at = clock_timestamp(), charged_micro_usd = charge,
        outcome = case when "result" in ('idle','processed','recovery-pending','unavailable') then "result" else 'unavailable' end
    where id = c.id;
end $$;

revoke all on function public.render_library_start_cpu_cycle(uuid) from public, anon, authenticated;
revoke all on function public.render_library_finish_cpu_cycle(uuid,text) from public, anon, authenticated;
grant execute on function public.render_library_start_cpu_cycle(uuid) to service_role;
grant execute on function public.render_library_finish_cpu_cycle(uuid,text) to service_role;
notify pgrst, 'reload schema';

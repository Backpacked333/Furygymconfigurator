-- Deploy only with the matching API and immutable worker package after draining
-- old claims. This validates newly published canonical designs, not historical aliases.
create or replace function public.render_library_view_design(design jsonb, camera text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, public as $$
declare d jsonb := jsonb_set(design,'{presentation,cameraRef}',to_jsonb(camera));
begin
  if camera='entry-draft@1' then
    return jsonb_set(jsonb_set(jsonb_set(jsonb_set(d,
      '{config,structure,addons}','[]'::jsonb),'{config,structure,railing}','"glass"'::jsonb),
      '{config,appearance,finish}','"obsidian"'::jsonb),'{config,appearance,accent}','false'::jsonb);
  end if;
  if not (d->'config'->'structure'->'addons' ?| array['roof','stairs']) then
    d:=jsonb_set(d,'{config,structure,railing}','"glass"'::jsonb);
  end if;
  if camera='rear-left-draft@1' and jsonb_array_length(d->'config'->'structure'->'addons')=0
      and d->'presentation'->>'lookRef' in ('studio-day-draft@1','studio-night-draft@1') then
    d:=jsonb_set(jsonb_set(jsonb_set(d,'{config,appearance,interior}','"gallery"'::jsonb),
      '{config,appearance,floor}','"rubber"'::jsonb),'{config,appearance,mirror}','false'::jsonb);
  end if;
  return d;
end $$;
revoke all on function public.render_library_view_design(jsonb,text) from public, anon, authenticated;
grant execute on function public.render_library_view_design(jsonb,text) to service_role;
notify pgrst,'reload schema';

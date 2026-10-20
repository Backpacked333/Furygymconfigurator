-- Supabase Storage schema is provided by the platform, not by application migrations.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values
  ('render-library','render-library',true,8388608,array['image/webp']),
  ('render-library-staging','render-library-staging',false,8388608,array['image/webp'])
on conflict (id) do nothing;

do $$ begin
  if not exists(select 1 from storage.buckets where id='render-library' and public and file_size_limit=8388608 and allowed_mime_types=array['image/webp'])
    or not exists(select 1 from storage.buckets where id='render-library-staging' and not public and file_size_limit=8388608 and allowed_mime_types=array['image/webp']) then
    raise exception 'render library buckets already exist with incompatible security configuration';
  end if;
end $$;

-- Restrictive policies also fence pre-existing permissive project-wide policies.
-- Service-role and signed exact-object upload capability are the only writers.
create policy render_library_no_browser_insert on storage.objects as restrictive for insert to anon,authenticated
  with check (bucket_id not in ('render-library','render-library-staging'));
create policy render_library_no_browser_update on storage.objects as restrictive for update to anon,authenticated
  using (bucket_id not in ('render-library','render-library-staging'))
  with check (bucket_id not in ('render-library','render-library-staging'));
create policy render_library_no_browser_delete on storage.objects as restrictive for delete to anon,authenticated
  using (bucket_id not in ('render-library','render-library-staging'));
create policy render_library_no_browser_staging_read on storage.objects as restrictive for select to anon,authenticated
  using (bucket_id<>'render-library-staging');

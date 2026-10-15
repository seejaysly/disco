insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('disco-media', 'disco-media', false, 10485760, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

-- Files live under <user_id>/...; owners manage their own folder
create policy "disco-media owner read" on storage.objects for select to authenticated
  using (bucket_id = 'disco-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "disco-media owner upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'disco-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "disco-media owner update" on storage.objects for update to authenticated
  using (bucket_id = 'disco-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "disco-media owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'disco-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- People a disco is shared with can view its image (never public)
create policy "disco-media shared read" on storage.objects for select to authenticated
  using (
    bucket_id = 'disco-media'
    and exists (
      select 1 from public.disco_media m
      where m.storage_path = storage.objects.name and public.can_view_disco(m.disco_id)
    )
  );

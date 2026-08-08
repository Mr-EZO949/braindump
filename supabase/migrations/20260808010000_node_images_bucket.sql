-- Storage bucket for node-body images.
--
-- Public-READ on purpose: shared/public graphs (see the public-sharing feature)
-- must serve their images to logged-out visitors and crawlers, so a private
-- bucket with signed URLs won't do. Object paths are namespaced by user id and
-- carry a random UUID filename, so nothing is enumerable. WRITES are locked to
-- the owner's own top-level folder via RLS.
--
-- Path convention (enforced by the insert policy): <user_id>/<node_id>/<uuid>.webp
-- The API route (/api/images) always resizes + converts to webp before upload,
-- so only image/webp is accepted here as a second line of defense.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'node-images',
  'node-images',
  true,
  10485760, -- 10 MB ceiling on the stored (already-resized) object
  array['image/webp']
)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by Supabase; we just add policies.

drop policy if exists "node_images_read_public" on storage.objects;
create policy "node_images_read_public"
  on storage.objects
  for select
  to public
  using (bucket_id = 'node-images');

drop policy if exists "node_images_insert_own" on storage.objects;
create policy "node_images_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'node-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "node_images_update_own" on storage.objects;
create policy "node_images_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'node-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'node-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "node_images_delete_own" on storage.objects;
create policy "node_images_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'node-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

begin;

grant delete on public.portraits to authenticated;

drop policy if exists portraits_delete_own on public.portraits;
create policy portraits_delete_own on public.portraits
for delete to authenticated
using (user_id = (select auth.uid()) and status is distinct from 'rendering');

-- Storage removal requires SELECT and DELETE policies. Restrict both to
-- the signed-in user's top-level folder in the two project image buckets.
drop policy if exists project_images_read_own on storage.objects;
create policy project_images_read_own on storage.objects
for select to authenticated
using (
  bucket_id in ('pet-photos', 'portrait-renders')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists project_images_delete_own on storage.objects;
create policy project_images_delete_own on storage.objects
for delete to authenticated
using (
  bucket_id in ('pet-photos', 'portrait-renders')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

commit;

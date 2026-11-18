-- Owner-approved, scoped read access to private portal upload originals.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $guard$
begin
  if not exists (select 1 from storage.buckets where id = 'pa-portal-assets' and not public)
    or not exists (select 1 from pg_class where oid = 'storage.objects'::regclass and relrowsecurity)
  then
    raise exception 'PAUI-095 private portal storage baseline mismatch';
  end if;
end
$guard$;

create policy "PAUI-095 read saved portal uploads"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'pa-portal-assets'
  and (select public.is_work_admin())
  and name ~ '^(cases/[0-9a-f-]{36}|organizer/[0-9a-f]{36})/[0-9a-f-]{36}/[0-9a-f]{64}$'
  and exists (
    select 1
    from public.pa_portals portal
    join public.pa_inquiries inquiry on inquiry.id = portal.case_id and inquiry.deleted_at is null
    where (
      (split_part(storage.objects.name, '/', 1) = 'cases'
        and split_part(storage.objects.name, '/', 2) = portal.case_id::text)
      or (split_part(storage.objects.name, '/', 1) = 'organizer'
        and split_part(storage.objects.name, '/', 2) = portal.public_ref)
    )
    and (
      exists (
        select 1
        from public.pa_portal_document_cards card
        join public.pa_portal_document_versions version on version.card_id = card.id
        where card.portal_id = portal.id and card.archived_at is null and version.archived_at is null
          and version.source_type = 'portal_upload'
          and version.source_ref ->> 'storage_path' = storage.objects.name
          and version.source_ref ->> 'sha256' = split_part(storage.objects.name, '/', 4)
      )
      or exists (
        select 1
        from public.pa_portal_photo_items photo
        where photo.portal_id = portal.id and photo.archived_at is null
          and photo.source_type = 'portal_upload'
          and photo.source_ref ->> 'storage_path' = storage.objects.name
          and photo.source_ref ->> 'sha256' = split_part(storage.objects.name, '/', 4)
      )
    )
  )
);

commit;

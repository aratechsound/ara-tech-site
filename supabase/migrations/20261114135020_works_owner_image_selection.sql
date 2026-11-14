begin;

alter table public.work_posts
  add column if not exists image_owner_instruction_ref text
    check (image_owner_instruction_ref is null or length(btrim(image_owner_instruction_ref)) between 1 and 200);

comment on column public.work_posts.image_owner_instruction_ref is
  'Owner selection of the exact source and SHA-256. Third-party permission remains in image_usage_status.';

-- Keep hashes stable for candidates that predate the Owner selection field.
create or replace function public.work_candidate_content_hash(p_work public.work_posts)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select encode(
    extensions.digest(
      convert_to(
        (jsonb_build_object(
          'title', p_work.title, 'slug', p_work.slug, 'event_date', p_work.event_date,
          'open_time', p_work.open_time, 'start_time', p_work.start_time, 'close_time', p_work.close_time,
          'event_type', p_work.event_type, 'service_types', p_work.service_types,
          'lifecycle_status', p_work.lifecycle_status, 'performer_name', p_work.performer_name,
          'area', p_work.area, 'venue_address', p_work.venue_address, 'organizer_name', p_work.organizer_name,
          'official_announcement_url', p_work.official_announcement_url, 'service_plan', p_work.service_plan,
          'assignment_items', p_work.assignment_items, 'participant_groups', p_work.participant_groups,
          'system_setup', p_work.system_setup, 'role_type', p_work.role_type, 'role_types', p_work.role_types,
          'operation_artists', p_work.operation_artists, 'support_artists', p_work.support_artists,
          'artists', p_work.artists, 'venue', p_work.venue, 'description', p_work.description,
          'flyer_path', p_work.flyer_path, 'flyer_alt', p_work.flyer_alt,
          'review_image_url', p_work.review_image_url,
          'review_image_acquisition_method', p_work.review_image_acquisition_method,
          'image_usage_status', p_work.image_usage_status, 'use_image_on_public_page', p_work.use_image_on_public_page,
          'public_image_source_url', p_work.public_image_source_url, 'public_image_sha256', p_work.public_image_sha256,
          'seo_title', p_work.seo_title, 'meta_description', p_work.meta_description
        ) || case when p_work.image_owner_instruction_ref is null then '{}'::jsonb
                   else jsonb_build_object('image_owner_instruction_ref', p_work.image_owner_instruction_ref) end
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

-- The existing trigger resets usage, visibility and confirmation when image bytes or source change.
-- Retain an existing selection when only the Storage path changes and provenance and bytes match.
create or replace function public.reset_work_image_confirmation_on_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if nullif(btrim(new.flyer_path), '') is distinct from nullif(btrim(old.flyer_path), '')
    or new.public_image_source_url is distinct from old.public_image_source_url
    or new.public_image_sha256 is distinct from old.public_image_sha256
  then
    new.image_usage_status := 'unknown';
    new.use_image_on_public_page := false;
    new.image_publication_confirmed_at := null;
    new.image_publication_confirmed_by := null;
    if new.image_owner_instruction_ref is not distinct from old.image_owner_instruction_ref
      and (new.public_image_source_url is distinct from old.public_image_source_url
        or new.public_image_sha256 is distinct from old.public_image_sha256
        or old.public_image_sha256 is null)
    then
      new.image_owner_instruction_ref := null;
    end if;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.set_work_image_publication_confirmation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $body$
declare
  v_track_image boolean;
  v_selection_changed boolean;
  v_image_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_track_image := new.publication_review_status = 'publication_pending_approval';
    v_selection_changed := new.use_image_on_public_page;
    v_image_changed := false;
  else
    v_track_image := new.publication_review_status = 'publication_pending_approval'
      or old.publication_review_status = 'publication_pending_approval'
      or (old.is_published and new.is_published and new.image_owner_instruction_ref is not null);
    v_selection_changed := old.use_image_on_public_page is distinct from new.use_image_on_public_page;
    v_image_changed := new.use_image_on_public_page and (
      old.flyer_path is distinct from new.flyer_path
      or old.public_image_source_url is distinct from new.public_image_source_url
      or old.public_image_sha256 is distinct from new.public_image_sha256
      or old.image_owner_instruction_ref is distinct from new.image_owner_instruction_ref
      or old.image_usage_status is distinct from new.image_usage_status
    );
  end if;
  if not coalesce(v_track_image, false) then return new; end if;

  if v_selection_changed or v_image_changed then
    if new.use_image_on_public_page then
      if auth.uid() is null
        or not public.is_work_admin()
        or (
          new.image_usage_status is distinct from 'confirmed'
          and (new.image_usage_status is distinct from 'unknown'
            or nullif(btrim(new.image_owner_instruction_ref), '') is null
            or new.public_image_source_url is null or new.public_image_sha256 is null)
        )
        or coalesce(btrim(new.flyer_path), '') = ''
        or (new.public_image_source_url is not null and new.public_image_source_url !~ '^https://[^[:space:]]+$')
        or (new.public_image_sha256 is not null and new.public_image_sha256 !~ '^[0-9a-f]{64}$')
      then
        raise exception 'public image confirmation evidence is incomplete' using errcode = '23514';
      end if;
      new.image_publication_confirmed_at := now();
      new.image_publication_confirmed_by := auth.uid();
    else
      new.image_publication_confirmed_at := null;
      new.image_publication_confirmed_by := null;
    end if;
  end if;
  return new;
end;
$body$;

CREATE OR REPLACE FUNCTION public.audit_work_candidate_image_selection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $body$
declare
  v_track_image boolean;
  v_selection_changed boolean;
  v_image_changed boolean;
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_track_image := new.publication_review_status = 'publication_pending_approval';
    v_selection_changed := new.use_image_on_public_page;
    v_image_changed := false;
  else
    v_track_image := new.publication_review_status = 'publication_pending_approval'
      or old.publication_review_status = 'publication_pending_approval'
      or (old.is_published and new.is_published and (new.image_owner_instruction_ref is not null or old.image_owner_instruction_ref is not null));
    v_selection_changed := old.use_image_on_public_page is distinct from new.use_image_on_public_page;
    v_image_changed := new.use_image_on_public_page and (
      old.flyer_path is distinct from new.flyer_path
      or old.public_image_source_url is distinct from new.public_image_source_url
      or old.public_image_sha256 is distinct from new.public_image_sha256
      or old.image_owner_instruction_ref is distinct from new.image_owner_instruction_ref
      or old.image_usage_status is distinct from new.image_usage_status
    );
  end if;
  if not coalesce(v_track_image, false) then return new; end if;
  if not v_selection_changed and not v_image_changed then return new; end if;

  v_action := case
    when not new.use_image_on_public_page then 'public_image_deselected'
    when tg_op = 'UPDATE' and old.use_image_on_public_page then 'public_image_reconfirmed'
    else 'public_image_selected'
  end;

  insert into public.work_candidate_image_audit (
    work_id, actor_user_id, action, selected, candidate_hash,
    source_url, flyer_path, image_sha256, details
  ) values (
    new.id,
    auth.uid(),
    v_action,
    new.use_image_on_public_page,
    new.candidate_hash,
    case when new.use_image_on_public_page or tg_op = 'INSERT' then new.public_image_source_url else old.public_image_source_url end,
    case when new.use_image_on_public_page or tg_op = 'INSERT' then new.flyer_path else old.flyer_path end,
    case when new.use_image_on_public_page or tg_op = 'INSERT' then new.public_image_sha256 else old.public_image_sha256 end,
    jsonb_build_object(
      'review_image_url', coalesce(new.review_image_url, old.review_image_url),
      'image_usage_status', new.image_usage_status,
      'owner_instruction_ref', coalesce(new.image_owner_instruction_ref, old.image_owner_instruction_ref),
      'confirmation_at', new.image_publication_confirmed_at
    )
  );
  return new;
end;
$body$;

CREATE OR REPLACE FUNCTION public.publish_work_candidate(p_work_id bigint, p_candidate_hash text)
 RETURNS TABLE(result text, work_id bigint, public_slug text, approved_candidate_hash text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $body$
declare
  v_work public.work_posts%rowtype;
begin
  if not public.is_work_admin() then
    return query select 'not_authorized'::text, null::bigint, null::text, null::text;
    return;
  end if;

  select * into v_work from public.work_posts where id = p_work_id for update;
  if not found then
    return query select 'not_found'::text, null::bigint, null::text, null::text;
    return;
  end if;
  if v_work.publication_review_status is distinct from 'publication_pending_approval' or v_work.is_published then
    return query select 'invalid_state'::text, v_work.id, v_work.slug, v_work.candidate_hash;
    return;
  end if;
  if p_candidate_hash is null or p_candidate_hash <> v_work.candidate_hash then
    return query select 'candidate_changed'::text, v_work.id, v_work.slug, v_work.candidate_hash;
    return;
  end if;
  if v_work.lifecycle_status <> 'upcoming'
    or v_work.event_date is null
    or coalesce(btrim(v_work.title), '') = ''
    or coalesce(btrim(v_work.performer_name), '') = ''
    or coalesce(btrim(v_work.venue), '') = ''
    or coalesce(btrim(v_work.area), '') = ''
    or coalesce(btrim(v_work.official_announcement_url), '') !~ '^https://[^[:space:]]+$'
    or (
      cardinality(coalesce(v_work.assignment_items, '{}'::text[])) = 0
      and cardinality(coalesce(v_work.role_types, '{}'::text[])) = 0
      and v_work.role_type is null
    ) then
    return query select 'validation_failed'::text, v_work.id, v_work.slug, v_work.candidate_hash;
    return;
  end if;
  if v_work.event_date < current_date then
    return query select 'event_date_past'::text, v_work.id, v_work.slug, v_work.candidate_hash;
    return;
  end if;
  if v_work.image_owner_instruction_ref is not null and not v_work.use_image_on_public_page then
    return query select 'image_not_approved'::text, v_work.id, v_work.slug, v_work.candidate_hash;
    return;
  end if;
  if v_work.use_image_on_public_page and (
    (
      v_work.image_usage_status is distinct from 'confirmed'
      and (v_work.image_usage_status is distinct from 'unknown'
        or nullif(btrim(v_work.image_owner_instruction_ref), '') is null
        or v_work.public_image_source_url is null or v_work.public_image_sha256 is null)
    )
    or coalesce(btrim(v_work.flyer_path), '') = ''
    or v_work.image_publication_confirmed_at is null
    or v_work.image_publication_confirmed_by is null
  ) then
    return query select 'image_not_approved'::text, v_work.id, v_work.slug, v_work.candidate_hash;
    return;
  end if;

  update public.work_posts
  set approved_hash = v_work.candidate_hash,
      approved_at = now(),
      approved_by = auth.uid(),
      publication_review_status = null,
      announcement_confirmed_on = current_date,
      is_published = true,
      publish_at = null,
      rejected_at = null,
      rejected_by = null
  where id = v_work.id;

  return query select 'published'::text, v_work.id, v_work.slug, v_work.candidate_hash;
end;
$body$;

notify pgrst, 'reload schema';

commit;

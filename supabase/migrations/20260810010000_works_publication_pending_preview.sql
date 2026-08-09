begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.work_posts
  add column if not exists open_time time without time zone,
  add column if not exists start_time time without time zone,
  add column if not exists seo_title text,
  add column if not exists meta_description text,
  add column if not exists workflow_id text,
  add column if not exists source_candidate_hash text,
  add column if not exists candidate_hash text,
  add column if not exists approved_hash text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists publication_review_status text,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists review_image_url text,
  add column if not exists review_image_acquisition_method text,
  add column if not exists image_usage_status text,
  add column if not exists use_image_on_public_page boolean not null default true;

comment on column public.work_posts.publication_review_status is
  'NULL for ordinary/published rows, publication_pending_approval for an owner review candidate, rejected when explicitly declined.';
comment on column public.work_posts.review_image_url is
  'Admin-only review image URL. It is never used by the public WORKS renderer.';
comment on column public.work_posts.use_image_on_public_page is
  'Public flyer opt-in. A pending candidate can be published with an image only when this is true, image_usage_status is confirmed, and flyer_path exists.';
comment on column public.work_posts.candidate_hash is
  'SHA-256 of the exact pending publication content. Updated by trigger and bound to the publish approval.';

create unique index if not exists work_posts_workflow_id_unique
  on public.work_posts (workflow_id)
  where workflow_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.work_posts'::regclass
      and conname = 'work_posts_publication_preview_values'
  ) then
    alter table public.work_posts
      add constraint work_posts_publication_preview_values
      check (
        (publication_review_status is null or publication_review_status in ('publication_pending_approval', 'rejected'))
        and (image_usage_status is null or image_usage_status in ('unknown', 'confirmed', 'not_permitted'))
        and (seo_title is null or char_length(seo_title) <= 200)
        and (meta_description is null or char_length(meta_description) <= 500)
        and (workflow_id is null or char_length(workflow_id) between 1 and 180)
        and (source_candidate_hash is null or source_candidate_hash ~ '^[0-9a-f]{64}$')
        and (candidate_hash is null or candidate_hash ~ '^[0-9a-f]{64}$')
        and (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$')
        and (review_image_url is null or (char_length(review_image_url) <= 2000 and review_image_url ~ '^https://[^[:space:]]+$'))
        and (review_image_acquisition_method is null or char_length(review_image_acquisition_method) <= 120)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.work_posts'::regclass
      and conname = 'work_posts_publication_pending_is_private'
  ) then
    alter table public.work_posts
      add constraint work_posts_publication_pending_is_private
      check (publication_review_status <> 'publication_pending_approval' or not is_published);
  end if;
end;
$$;

create or replace function public.work_candidate_content_hash(p_work public.work_posts)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'title', p_work.title,
          'slug', p_work.slug,
          'event_date', p_work.event_date,
          'open_time', p_work.open_time,
          'start_time', p_work.start_time,
          'category', p_work.category,
          'lifecycle_status', p_work.lifecycle_status,
          'performer_name', p_work.performer_name,
          'area', p_work.area,
          'venue_address', p_work.venue_address,
          'organizer_name', p_work.organizer_name,
          'official_announcement_url', p_work.official_announcement_url,
          'service_plan', p_work.service_plan,
          'assignment_items', p_work.assignment_items,
          'participant_groups', p_work.participant_groups,
          'system_setup', p_work.system_setup,
          'role_type', p_work.role_type,
          'role_types', p_work.role_types,
          'operation_artists', p_work.operation_artists,
          'support_artists', p_work.support_artists,
          'artists', p_work.artists,
          'venue', p_work.venue,
          'description', p_work.description,
          'flyer_path', p_work.flyer_path,
          'flyer_alt', p_work.flyer_alt,
          'review_image_url', p_work.review_image_url,
          'review_image_acquisition_method', p_work.review_image_acquisition_method,
          'image_usage_status', p_work.image_usage_status,
          'use_image_on_public_page', p_work.use_image_on_public_page,
          'seo_title', p_work.seo_title,
          'meta_description', p_work.meta_description
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.set_work_candidate_hash()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  if new.publication_review_status = 'publication_pending_approval' then
    new.is_published := false;
    new.publish_at := null;
    v_hash := public.work_candidate_content_hash(new);
    if tg_op = 'INSERT' or old.candidate_hash is distinct from v_hash then
      new.approved_hash := null;
      new.approved_at := null;
      new.approved_by := null;
    end if;
    new.candidate_hash := v_hash;
  end if;
  return new;
end;
$$;

drop trigger if exists work_posts_set_candidate_hash on public.work_posts;
create trigger work_posts_set_candidate_hash
before insert or update on public.work_posts
for each row execute function public.set_work_candidate_hash();

create or replace function public.publish_work_candidate(
  p_work_id bigint,
  p_candidate_hash text
)
returns table(result text, work_id bigint, public_slug text, approved_candidate_hash text)
language plpgsql
security definer
set search_path = public
as $$
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
  if v_work.publication_review_status <> 'publication_pending_approval' or v_work.is_published then
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
  if v_work.use_image_on_public_page and (
    v_work.image_usage_status <> 'confirmed' or coalesce(btrim(v_work.flyer_path), '') = ''
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
$$;

create or replace function public.reject_work_candidate(p_work_id bigint)
returns table(result text, work_id bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_work public.work_posts%rowtype;
begin
  if not public.is_work_admin() then
    return query select 'not_authorized'::text, null::bigint;
    return;
  end if;
  select * into v_work from public.work_posts where id = p_work_id for update;
  if not found then
    return query select 'not_found'::text, null::bigint;
    return;
  end if;
  if v_work.publication_review_status <> 'publication_pending_approval' or v_work.is_published then
    return query select 'invalid_state'::text, v_work.id;
    return;
  end if;
  update public.work_posts
  set publication_review_status = 'rejected',
      is_published = false,
      publish_at = null,
      approved_hash = null,
      approved_at = null,
      approved_by = null,
      rejected_at = now(),
      rejected_by = auth.uid()
  where id = v_work.id;
  return query select 'rejected'::text, v_work.id;
end;
$$;

revoke all on function public.work_candidate_content_hash(public.work_posts) from public, anon, authenticated;
revoke all on function public.publish_work_candidate(bigint, text) from public, anon;
revoke all on function public.reject_work_candidate(bigint) from public, anon;
grant execute on function public.publish_work_candidate(bigint, text) to authenticated;
grant execute on function public.reject_work_candidate(bigint) to authenticated;

insert into public.work_posts (
  workflow_id, source_candidate_hash, publication_review_status, created_by,
  title, slug, event_date, open_time, start_time, category, lifecycle_status,
  performer_name, area, venue_address, organizer_name, official_announcement_url,
  announcement_confirmed_on, service_plan, assignment_items, role_type, role_types,
  operation_artists, support_artists, artists, venue, description,
  flyer_path, flyer_alt, review_image_url, review_image_acquisition_method,
  image_usage_status, use_image_on_public_page, seo_title, meta_description,
  is_published, publish_at
)
values
  (
    '2026-08-14-bark-lagoon-hiroshima',
    'bf3f757491537fc78090ec959dfe3b6246f717ce295feb7eb73c9b47005169fa',
    'publication_pending_approval',
    '5d06060d-73e5-4567-81b8-a776719d7691'::uuid,
    'BARK「Bling 2 Tape」CLUB TOUR 2026',
    '2026-bark-bling-2-tape-club-tour-2026-lagoon-hiroshima',
    date '2026-08-14', time '22:00', null, 'ライブ・アーティストPA', 'upcoming',
    'BARK', '広島県広島市', '広島県広島市中区流川町8-20 流川エイトビルB1F', 'LAGOON HIROSHIMA',
    'https://lagoon-hiroshima.com/bark_20260814/', null, null,
    array['pa_operation']::text[], 'artist_pa_operation', array['artist_pa_operation']::text[],
    'BARK', null, 'BARK', 'LAGOON HIROSHIMA',
    '2026年8月14日、LAGOON HIROSHIMAにて開催予定のBARK「Bling 2 Tape」CLUB TOUR 2026にて、ARA-TECHがPAオペレートを担当予定です。OPEN 22:00予定です。公演・チケット等の詳細は会場・主催者の公式情報をご確認ください。',
    '', 'BARK「Bling 2 Tape」CLUB TOUR 2026 LAGOON HIROSHIMA公演の公式フライヤー',
    'https://lagoon-hiroshima.com/wp-content/uploads/2026/07/20260814_bark_ogp.jpg', 'official_page_og_image',
    'unknown', false,
    'BARK「Bling 2 Tape」CLUB TOUR 2026｜2026年 LAGOON HIROSHIMA｜ARA-TECH 音響担当予定',
    '2026年8月14日、LAGOON HIROSHIMAにて開催予定のBARK「Bling 2 Tape」CLUB TOUR 2026で、ARA-TECHがPAオペレートを担当予定です。OPEN 22:00。詳細は公式情報をご確認ください。',
    false, null
  ),
  (
    '2026-08-28-cream-lagoon-hiroshima',
    '94301b1f2d07dbaf28f8e30f8cf8a058114a0b0378c432c2b7f1e5dd1554161c',
    'publication_pending_approval',
    '5d06060d-73e5-4567-81b8-a776719d7691'::uuid,
    'CREAM The World Club Tour 2026 in HIROSHIMA',
    '2026-cream-the-world-club-tour-2026-in-hiroshima-lagoon-hiroshima',
    date '2026-08-28', time '22:00', null, 'ライブ・アーティストPA', 'upcoming',
    'CREAM', '広島県広島市', '広島県広島市中区流川町8-20 流川エイトビルB1F', 'LAGOON HIROSHIMA',
    'https://lagoon-hiroshima.com/cream_20260828/', null, null,
    array['pa_operation']::text[], 'artist_pa_operation', array['artist_pa_operation']::text[],
    'CREAM', null, 'CREAM', 'LAGOON HIROSHIMA',
    '2026年8月28日、LAGOON HIROSHIMAにて開催予定の「CREAM The World Club Tour 2026 in HIROSHIMA」にて、ARA-TECHがPAオペレートを担当予定です。OPEN 22:00予定です。公演・チケット等の詳細は会場・主催者の公式情報をご確認ください。',
    '', 'CREAM The World Club Tour 2026 in HIROSHIMA LAGOON HIROSHIMA公演の公式フライヤー',
    'https://lagoon-hiroshima.com/wp-content/uploads/2026/07/20260828_cream_ogp.jpg', 'official_page_og_image',
    'unknown', false,
    'CREAM The World Club Tour 2026 in HIROSHIMA｜2026年 LAGOON HIROSHIMA｜ARA-TECH 音響担当予定',
    '2026年8月28日、LAGOON HIROSHIMAにて開催予定のCREAM The World Club Tour 2026 in HIROSHIMAで、ARA-TECHがPAオペレートを担当予定です。OPEN 22:00。詳細は公式情報をご確認ください。',
    false, null
  ),
  (
    '2026-09-11-ife-city-of-heaven-tour-lagoon-hiroshima',
    '254fd3057d2ca4b7195680cd1eac03304a437fd9a06abdae14d043335751076c',
    'publication_pending_approval',
    '5d06060d-73e5-4567-81b8-a776719d7691'::uuid,
    'IFE -City of Heaven Tour-',
    '2026-ife-city-of-heaven-tour-lagoon-hiroshima',
    date '2026-09-11', time '22:00', null, 'ライブ・アーティストPA', 'upcoming',
    'IFE', '広島県広島市', '広島県広島市中区流川町8-20 流川エイトビルB1F', 'LAGOON HIROSHIMA',
    'https://lagoon-hiroshima.com/ife_20260911/', null, null,
    array['pa_operation']::text[], 'artist_pa_operation', array['artist_pa_operation']::text[],
    'IFE', null, 'IFE', 'LAGOON HIROSHIMA',
    '2026年9月11日、LAGOON HIROSHIMAにて開催予定の「IFE -City of Heaven Tour-」にて、ARA-TECHがPAオペレートを担当予定です。OPEN 22:00予定です。公演・チケット等の詳細は会場・主催者の公式情報をご確認ください。',
    '', 'IFE -City of Heaven Tour- LAGOON HIROSHIMA公演の公式フライヤー',
    'https://lagoon-hiroshima.com/wp-content/uploads/2026/08/6dfa1668-1767-44dd-8ab1-e7b2d7b4aa13.jpg', 'official_page_og_image',
    'unknown', false,
    'IFE -City of Heaven Tour-｜2026年 LAGOON HIROSHIMA｜ARA-TECH 音響担当予定',
    '2026年9月11日、LAGOON HIROSHIMAにて開催予定のIFE -City of Heaven Tour-で、ARA-TECHがPAオペレートを担当予定です。OPEN 22:00。詳細は公式情報をご確認ください。',
    false, null
  )
on conflict (workflow_id) where workflow_id is not null do nothing;

notify pgrst, 'reload schema';

commit;

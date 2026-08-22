begin;

alter table public.work_posts
  add column if not exists event_type text,
  add column if not exists service_types text[];

-- The existing category constraint permits only legacy labels.  Remove it
-- before changing values, then install the formal event-type constraints below.
alter table public.work_posts
  drop constraint if exists work_posts_category_allowed,
  drop constraint if exists work_posts_event_type_allowed,
  drop constraint if exists work_posts_service_types_allowed;

-- The 58 registered WORKS records were reviewed before this migration.  Venue
-- alone is only authoritative for the owner-confirmed club venues below.
update public.work_posts
set
  event_type = case
    when category = 'お祭り・地域イベント音響' then '祭り・地域イベント'
    when venue in ('LAGOON HIROSHIMA', 'club G') or venue ilike '%CLUB L2%' then 'クラブ・DJイベント'
    else 'ライブ・コンサート'
  end,
  category = case
    when category = 'お祭り・地域イベント音響' then '祭り・地域イベント'
    when venue in ('LAGOON HIROSHIMA', 'club G') or venue ilike '%CLUB L2%' then 'クラブ・DJイベント'
    else 'ライブ・コンサート'
  end,
  service_types = case
    when category = 'お祭り・地域イベント音響' then array['pa_sound', 'simple_lighting']::text[]
    when category = 'ライブ・アーティストPA'
      or coalesce(role_types, array[]::text[]) @> array['artist_pa_operation']::text[]
      or role_type = 'artist_pa_operation'
      or coalesce(description, '') ilike '%アーティストPA%'
      then array['artist_pa_operation']::text[]
    else array['pa_sound']::text[]
  end
where category in ('WORKS', 'ライブ・アーティストPA', 'お祭り・地域イベント音響');

alter table public.work_posts
  alter column event_type set not null,
  alter column service_types set not null;

alter table public.work_posts
  add constraint work_posts_category_allowed
    check (category in (
      'ライブ・コンサート',
      'クラブ・DJイベント',
      '祭り・地域イベント',
      '企業・式典',
      '講演会・セミナー',
      'ダンス・舞台公演',
      '学校・文化イベント'
    )),
  add constraint work_posts_event_type_allowed
    check (event_type in (
      'ライブ・コンサート',
      'クラブ・DJイベント',
      '祭り・地域イベント',
      '企業・式典',
      '講演会・セミナー',
      'ダンス・舞台公演',
      '学校・文化イベント'
    )),
  add constraint work_posts_service_types_allowed
    check (
      cardinality(service_types) between 1 and 9
      and service_types <@ array[
        'pa_sound',
        'artist_pa_operation',
        'simple_lighting',
        'stage_lighting',
        'led_video',
        'temporary_stage_setup',
        'truss_setup',
        'event_technical_production',
        'system_design_construction'
      ]::text[]
    );

comment on column public.work_posts.event_type is
  'イベントそのものの正式種別。categoryは既存クライアント互換の同値列。';
comment on column public.work_posts.service_types is
  'ARA-TECHが担当した正式業務コードの複数選択配列。';

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
        jsonb_build_object(
          'title', p_work.title,
          'slug', p_work.slug,
          'event_date', p_work.event_date,
          'open_time', p_work.open_time,
          'start_time', p_work.start_time,
          'category', p_work.category,
          'event_type', p_work.event_type,
          'service_types', p_work.service_types,
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
          'public_image_source_url', p_work.public_image_source_url,
          'public_image_sha256', p_work.public_image_sha256,
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

notify pgrst, 'reload schema';

commit;

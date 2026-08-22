begin;

alter table public.work_posts
  drop constraint if exists work_posts_service_types_allowed;

alter table public.work_posts
  add constraint work_posts_service_types_allowed
    check (
      cardinality(service_types) between 1 and 10
      and service_types <@ array[
        'pa_sound',
        'local_touring_pa_support',
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

-- Legacy local_technical_support identifies touring teams that used
-- ARA-TECH as the Hiroshima local technical partner.  It is distinct from
-- ARA-TECH's own PA・音響 assignment, so replace (rather than append) pa_sound.
update public.work_posts
set service_types = array_append(
  array_remove(array_remove(service_types, 'pa_sound'), 'artist_pa_operation'),
  'local_touring_pa_support'
)
where (
  role_type = 'local_technical_support'
  or coalesce(role_types, array[]::text[]) @> array['local_technical_support']::text[]
)
and not (service_types @> array['local_touring_pa_support']::text[]);

comment on column public.work_posts.service_types is
  'ARA-TECHが担当した正式業務コードの複数選択配列。乗り込みPA・現地技術サポートを含む。';

notify pgrst, 'reload schema';

commit;

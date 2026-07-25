begin;

alter table public.work_posts
  add column if not exists service_plan text,
  add column if not exists assignment_items text[],
  add column if not exists system_setup text;

comment on column public.work_posts.service_plan is
  'ARA-TECH提供プランの安定コード。未設定はNULL。';
comment on column public.work_posts.assignment_items is
  '現場で担当した内容の安定コード配列。未設定はNULL。';
comment on column public.work_posts.system_setup is
  '現場ごとの機材・システム構成を記録する自由記入欄。';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.work_posts'::regclass
      and conname = 'work_posts_category_allowed'
  ) then
    alter table public.work_posts
      add constraint work_posts_category_allowed
      check (
        category in (
          'お祭り・地域イベント音響',
          'ライブ・アーティストPA',
          'DJイベント音響',
          'ステージ・照明',
          'ツアーPA',
          '音響設備・施工',
          '機材レンタル',
          'その他',
          'WORKS',
          'PA RENTAL',
          'STAGE PRODUCTION',
          'TOUR PA',
          'INSTALLATION'
        )
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.work_posts'::regclass
      and conname = 'work_posts_service_plan_allowed'
  ) then
    alter table public.work_posts
      add constraint work_posts_service_plan_allowed
      check (
        service_plan is null or service_plan in (
          'compact_pa',
          'standard_live',
          'matsuri_pack',
          'school_festival_pack',
          'pa_operator_only',
          'large_scale',
          'technical_advisor_training',
          'custom'
        )
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.work_posts'::regclass
      and conname = 'work_posts_assignment_items_allowed'
  ) then
    alter table public.work_posts
      add constraint work_posts_assignment_items_allowed
      check (
        assignment_items is null or (
          cardinality(assignment_items) <= 10
          and assignment_items <@ array[
            'sound_equipment',
            'pa_operation',
            'load_in_setup_strike',
            'simple_lighting',
            'lighting_operation',
            'stage_production',
            'equipment_rental_only',
            'sound_installation',
            'event_operation',
            'other'
          ]::text[]
        )
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.work_posts'::regclass
      and conname = 'work_posts_system_setup_length'
  ) then
    alter table public.work_posts
      add constraint work_posts_system_setup_length
      check (system_setup is null or char_length(system_setup) <= 2000)
      not valid;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;

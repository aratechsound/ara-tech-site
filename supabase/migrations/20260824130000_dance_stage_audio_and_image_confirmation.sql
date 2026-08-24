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
        'dance_stage_audio_operation',
        'simple_lighting',
        'stage_lighting',
        'led_video',
        'temporary_stage_setup',
        'truss_setup',
        'event_technical_production',
        'system_design_construction'
      ]::text[]
    );

create or replace function public.reset_work_image_confirmation_on_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and (
    nullif(btrim(new.flyer_path), '') is distinct from nullif(btrim(old.flyer_path), '')
    or new.public_image_source_url is distinct from old.public_image_source_url
    or new.public_image_sha256 is distinct from old.public_image_sha256
  ) then
    new.image_usage_status := 'unknown';
    new.use_image_on_public_page := false;
    new.image_publication_confirmed_at := null;
    new.image_publication_confirmed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists aaa_work_posts_reset_image_confirmation on public.work_posts;
create trigger aaa_work_posts_reset_image_confirmation
before update on public.work_posts
for each row execute function public.reset_work_image_confirmation_on_change();

notify pgrst, 'reload schema';

commit;

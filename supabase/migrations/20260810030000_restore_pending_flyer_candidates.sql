begin;

do $$
declare
  v_target_count integer;
  v_public_count integer;
begin
  perform id
  from public.work_posts
  where workflow_id in (
    '2026-08-14-bark-lagoon-hiroshima',
    '2026-08-28-cream-lagoon-hiroshima',
    '2026-09-11-ife-city-of-heaven-tour-lagoon-hiroshima'
  )
  order by id
  for update;

  select count(*), count(*) filter (
    where is_published
      and publication_review_status is null
      and lifecycle_status = 'upcoming'
  )
  into v_target_count, v_public_count
  from public.work_posts
  where workflow_id in (
    '2026-08-14-bark-lagoon-hiroshima',
    '2026-08-28-cream-lagoon-hiroshima',
    '2026-09-11-ife-city-of-heaven-tour-lagoon-hiroshima'
  );

  if v_target_count <> 3 or v_public_count <> 3 then
    raise exception 'pending candidate restore precondition failed: targets %, public %',
      v_target_count, v_public_count;
  end if;

  update public.work_posts
  set publication_review_status = 'publication_pending_approval',
      is_published = false,
      publish_at = null,
      announcement_confirmed_on = null,
      approved_hash = null,
      approved_at = null,
      approved_by = null,
      rejected_at = null,
      rejected_by = null,
      image_usage_status = 'unknown',
      use_image_on_public_page = false,
      image_publication_confirmed_at = null,
      image_publication_confirmed_by = null
  where workflow_id in (
    '2026-08-14-bark-lagoon-hiroshima',
    '2026-08-28-cream-lagoon-hiroshima',
    '2026-09-11-ife-city-of-heaven-tour-lagoon-hiroshima'
  );
end;
$$;

notify pgrst, 'reload schema';

commit;

begin;

alter table public.work_posts
  drop constraint if exists work_posts_category_allowed,
  drop column category;

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

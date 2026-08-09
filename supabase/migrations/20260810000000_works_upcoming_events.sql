alter table public.work_posts
    add column if not exists lifecycle_status text not null default 'completed',
    add column if not exists performer_name text,
    add column if not exists area text,
    add column if not exists venue_address text,
    add column if not exists organizer_name text,
    add column if not exists official_announcement_url text,
    add column if not exists announcement_confirmed_on date;

comment on column public.work_posts.lifecycle_status is
    'Publication lifecycle status: upcoming before the event, completed after it. Changing this value must not change slug.';
comment on column public.work_posts.performer_name is
    'Public artist or event participant name. This is separate from ARA-TECH role assignment fields.';
comment on column public.work_posts.area is
    'Public area or region label, for example 広島県広島市.';
comment on column public.work_posts.venue_address is
    'Detailed public venue address. Event structured data is emitted only when this is present.';
comment on column public.work_posts.organizer_name is
    'Optional organizer or venue name confirmed by the official announcement.';
comment on column public.work_posts.official_announcement_url is
    'Venue or organizer official announcement URL confirmed by a human before publication.';
comment on column public.work_posts.announcement_confirmed_on is
    'Date on which a human confirmed that the venue or organizer had made the announcement public.';

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'work_posts_lifecycle_status_allowed'
          and conrelid = 'public.work_posts'::regclass
    ) then
        alter table public.work_posts
            add constraint work_posts_lifecycle_status_allowed
            check (lifecycle_status in ('upcoming', 'completed'));
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'work_posts_upcoming_publication_evidence'
          and conrelid = 'public.work_posts'::regclass
    ) then
        alter table public.work_posts
            add constraint work_posts_upcoming_publication_evidence
            check (
                lifecycle_status <> 'upcoming'
                or not is_published
                or (
                    event_date is not null
                    and performer_name is not null and length(btrim(performer_name)) between 1 and 500
                    and venue is not null and length(btrim(venue)) between 1 and 120
                    and area is not null and length(btrim(area)) between 1 and 120
                    and (
                        cardinality(coalesce(assignment_items, '{}'::text[])) > 0
                        or cardinality(coalesce(role_types, '{}'::text[])) > 0
                        or role_type is not null
                    )
                    and official_announcement_url is not null
                    and official_announcement_url ~ '^https://[^[:space:]]+$'
                    and announcement_confirmed_on is not null
                )
            );
    end if;

    if not exists (
        select 1
        from pg_constraint
        where conname = 'work_posts_upcoming_text_lengths'
          and conrelid = 'public.work_posts'::regclass
    ) then
        alter table public.work_posts
            add constraint work_posts_upcoming_text_lengths
            check (
                (performer_name is null or length(performer_name) <= 500)
                and (area is null or length(area) <= 120)
                and (venue_address is null or length(venue_address) <= 500)
                and (organizer_name is null or length(organizer_name) <= 240)
                and (official_announcement_url is null or length(official_announcement_url) <= 2000)
                and (flyer_alt is null or length(flyer_alt) <= 500)
            );
    end if;
end $$;

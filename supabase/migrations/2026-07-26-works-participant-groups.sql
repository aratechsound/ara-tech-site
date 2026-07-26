alter table public.work_posts
    add column if not exists participant_groups text;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'work_posts_participant_groups_length'
          and conrelid = 'public.work_posts'::regclass
    ) then
        alter table public.work_posts
            add constraint work_posts_participant_groups_length
            check (
                participant_groups is null
                or char_length(participant_groups) <= 1000
            ) not valid;
    end if;
end
$$;

comment on column public.work_posts.participant_groups is
    'Optional performers or participant groups independent from artist PA role classification.';

notify pgrst, 'reload schema';

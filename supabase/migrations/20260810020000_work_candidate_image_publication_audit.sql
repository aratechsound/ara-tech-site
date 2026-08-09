begin;

alter table public.work_posts
  add column if not exists public_image_source_url text,
  add column if not exists public_image_sha256 text,
  add column if not exists image_publication_confirmed_at timestamptz,
  add column if not exists image_publication_confirmed_by uuid references auth.users(id) on delete set null;

comment on column public.work_posts.public_image_source_url is
  'Official review image URL copied into ARA-TECH Storage after explicit admin selection.';
comment on column public.work_posts.public_image_sha256 is
  'SHA-256 of the exact image bytes copied into ARA-TECH Storage.';
comment on column public.work_posts.image_publication_confirmed_at is
  'Time of the current explicit admin confirmation to use the flyer publicly.';
comment on column public.work_posts.image_publication_confirmed_by is
  'Admin who explicitly confirmed the current public flyer selection.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.work_posts'::regclass
      and conname = 'work_posts_public_image_evidence'
  ) then
    alter table public.work_posts
      add constraint work_posts_public_image_evidence
      check (
        (public_image_source_url is null or (char_length(public_image_source_url) <= 2000 and public_image_source_url ~ '^https://[^[:space:]]+$'))
        and (public_image_sha256 is null or public_image_sha256 ~ '^[0-9a-f]{64}$')
      );
  end if;
end;
$$;

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

create table if not exists public.work_candidate_image_audit (
  id bigint generated always as identity primary key,
  work_id bigint not null references public.work_posts(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('public_image_selected', 'public_image_reconfirmed', 'public_image_deselected')),
  selected boolean not null,
  candidate_hash text check (candidate_hash is null or candidate_hash ~ '^[0-9a-f]{64}$'),
  source_url text,
  flyer_path text,
  image_sha256 text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create index if not exists work_candidate_image_audit_work_idx
  on public.work_candidate_image_audit (work_id, occurred_at desc);

create or replace function public.set_work_image_publication_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_pending boolean;
  v_selection_changed boolean;
  v_image_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_pending := new.publication_review_status = 'publication_pending_approval';
    v_selection_changed := new.use_image_on_public_page;
    v_image_changed := false;
  else
    v_pending := new.publication_review_status = 'publication_pending_approval'
      or old.publication_review_status = 'publication_pending_approval';
    v_selection_changed := old.use_image_on_public_page is distinct from new.use_image_on_public_page;
    v_image_changed := new.use_image_on_public_page and (
      old.flyer_path is distinct from new.flyer_path
      or old.public_image_source_url is distinct from new.public_image_source_url
      or old.public_image_sha256 is distinct from new.public_image_sha256
    );
  end if;
  if not v_pending then return new; end if;

  if v_selection_changed or v_image_changed then
    if new.use_image_on_public_page then
      if auth.uid() is null
        or not public.is_work_admin()
        or new.image_usage_status <> 'confirmed'
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
$$;

drop trigger if exists work_posts_set_image_confirmation on public.work_posts;
create trigger work_posts_set_image_confirmation
before insert or update on public.work_posts
for each row execute function public.set_work_image_publication_confirmation();

create or replace function public.audit_work_candidate_image_selection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_pending boolean;
  v_selection_changed boolean;
  v_image_changed boolean;
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_pending := new.publication_review_status = 'publication_pending_approval';
    v_selection_changed := new.use_image_on_public_page;
    v_image_changed := false;
  else
    v_pending := new.publication_review_status = 'publication_pending_approval'
      or old.publication_review_status = 'publication_pending_approval';
    v_selection_changed := old.use_image_on_public_page is distinct from new.use_image_on_public_page;
    v_image_changed := new.use_image_on_public_page and (
      old.flyer_path is distinct from new.flyer_path
      or old.public_image_source_url is distinct from new.public_image_source_url
      or old.public_image_sha256 is distinct from new.public_image_sha256
    );
  end if;
  if not v_pending then return new; end if;
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
      'confirmation_at', new.image_publication_confirmed_at
    )
  );
  return new;
end;
$$;

drop trigger if exists work_posts_audit_image_selection on public.work_posts;
create trigger work_posts_audit_image_selection
after insert or update on public.work_posts
for each row execute function public.audit_work_candidate_image_selection();

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
    v_work.image_usage_status <> 'confirmed'
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
$$;

alter table public.work_candidate_image_audit enable row level security;

drop policy if exists "WORKS admins read image audit" on public.work_candidate_image_audit;
create policy "WORKS admins read image audit"
on public.work_candidate_image_audit for select to authenticated
using (public.is_work_admin());

revoke all on public.work_candidate_image_audit from public, anon, authenticated;
grant select on public.work_candidate_image_audit to authenticated;

notify pgrst, 'reload schema';

commit;

-- ARA-TECH WORKS: Supabase SQL Editorで一度だけ実行してください。

create table if not exists public.work_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_work_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.work_admins where user_id = auth.uid()
  );
$$;

grant execute on function public.is_work_admin() to authenticated;

create table if not exists public.work_posts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  title text not null check (char_length(title) <= 120),
  category text not null default 'WORKS' check (char_length(category) <= 60),
  event_date date,
  venue text check (char_length(venue) <= 120),
  artists text check (char_length(artists) <= 240),
  description text check (char_length(description) <= 1000),
  flyer_path text not null,
  flyer_alt text,
  is_published boolean not null default false,
  publish_at timestamptz,
  role_type text check (role_type in ('artist_pa_operation', 'local_technical_support')),
  role_types text[] not null default '{}',
  operation_artists text check (char_length(operation_artists) <= 240),
  support_artists text check (char_length(support_artists) <= 240)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists work_posts_set_updated_at on public.work_posts;
create trigger work_posts_set_updated_at
before update on public.work_posts
for each row execute function public.set_updated_at();

alter table public.work_admins enable row level security;
alter table public.work_posts enable row level security;

create policy "Work admins can read their own membership"
on public.work_admins for select to authenticated
using (user_id = auth.uid());

create policy "Anyone can read published work posts"
on public.work_posts for select
using (is_published = true and (publish_at is null or publish_at <= now()));

create policy "Work admins manage all posts"
on public.work_posts for all to authenticated
using (public.is_work_admin())
with check (public.is_work_admin());

insert into storage.buckets (id, name, public)
values ('work-flyers', 'work-flyers', true)
on conflict (id) do update set public = true;

create policy "Anyone can view work flyers"
on storage.objects for select
using (bucket_id = 'work-flyers');

create policy "Work admins upload work flyers"
on storage.objects for insert to authenticated
with check (bucket_id = 'work-flyers' and public.is_work_admin());

create policy "Work admins update work flyers"
on storage.objects for update to authenticated
using (bucket_id = 'work-flyers' and public.is_work_admin())
with check (bucket_id = 'work-flyers' and public.is_work_admin());

create policy "Work admins delete work flyers"
on storage.objects for delete to authenticated
using (bucket_id = 'work-flyers' and public.is_work_admin());

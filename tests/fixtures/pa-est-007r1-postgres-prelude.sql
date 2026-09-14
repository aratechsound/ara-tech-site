create schema auth;
create schema extensions;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table public.work_admins(user_id uuid primary key references auth.users(id));
create function public.is_work_admin() returns boolean
language sql stable security definer set search_path=pg_catalog,public,auth as $$
  select exists(select 1 from public.work_admins where user_id=auth.uid())
$$;
insert into auth.users values ('123e4567-e89b-42d3-a456-426614174001');
insert into public.work_admins values ('123e4567-e89b-42d3-a456-426614174001');

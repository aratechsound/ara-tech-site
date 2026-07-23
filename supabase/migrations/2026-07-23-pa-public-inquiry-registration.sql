-- ARA-20260723-006
-- 第1フォームからサーバー受付を経由してPA問い合わせ案件へ登録するための追加マイグレーション。
-- 既存データと管理者向けRLSポリシーは維持する。

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null then
    raise exception 'public.pa_inquiries is required before applying ARA-20260723-006';
  end if;

  if to_regprocedure('public.is_work_admin()') is null then
    raise exception 'public.is_work_admin() is required before applying ARA-20260723-006';
  end if;
end;
$$;

alter table public.pa_inquiries
  add column if not exists submission_key uuid,
  add column if not exists contact_name text,
  add column if not exists requested_services text[] not null default '{}'::text[];

alter table public.pa_inquiries
  alter column created_by drop not null;

alter table public.pa_inquiries
  drop constraint if exists pa_inquiries_request_summary_check,
  drop constraint if exists pa_inquiries_public_request_summary_check;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pa_inquiries'::regclass
      and conname = 'pa_inquiries_submission_key_unique'
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_submission_key_unique unique (submission_key);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pa_inquiries'::regclass
      and conname = 'pa_inquiries_contact_name_length'
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_contact_name_length
      check (contact_name is null or char_length(contact_name) between 1 and 160)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pa_inquiries'::regclass
      and conname = 'pa_inquiries_requested_services_limit'
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_requested_services_limit
      check (cardinality(requested_services) <= 20)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pa_inquiries'::regclass
      and conname = 'pa_inquiries_public_submission_key_required'
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_public_submission_key_required
      check (submission_source <> 'public_form' or submission_key is not null)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pa_inquiries'::regclass
      and conname = 'pa_inquiries_request_summary_length'
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_request_summary_length
      check (request_summary is null or char_length(request_summary) <= 20000)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pa_inquiries'::regclass
      and conname = 'pa_inquiries_public_request_summary_length'
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_public_request_summary_length
      check (public_request_summary is null or char_length(public_request_summary) <= 20000)
      not valid;
  end if;
end;
$$;

comment on column public.pa_inquiries.submission_key is
  'Browser-generated idempotency key for public form registration. Never exposed in the admin UI.';
comment on column public.pa_inquiries.contact_name is
  'Primary contact person resolved from the first form.';
comment on column public.pa_inquiries.requested_services is
  'Requested PA/event service labels captured by the first form.';

-- anon / authenticated users still cannot INSERT public-form records directly.
revoke all on public.pa_inquiries from anon;
revoke all on public.pa_inquiries from authenticated;
grant select, insert, update on public.pa_inquiries to authenticated;

commit;

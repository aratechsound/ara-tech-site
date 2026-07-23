-- ARA-20260723-010
-- Gmail送信結果を案件単位・メール種別単位で記録し、重複送信を防止する。
-- 既存案件と既存回答は変更・削除しない後方互換マイグレーション。

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null then
    raise exception 'public.pa_inquiries is required before applying ARA-20260723-010';
  end if;

  if to_regprocedure('public.is_work_admin()') is null then
    raise exception 'public.is_work_admin() is required before applying ARA-20260723-010';
  end if;
end;
$$;

create table if not exists public.pa_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.pa_inquiries(id) on delete cascade,
  message_type text not null
    check (message_type in ('internal_new_inquiry', 'customer_receipt', 'schedule_request')),
  dedupe_key text not null check (char_length(dedupe_key) between 20 and 240),
  attempt_number integer not null default 1 check (attempt_number > 0),
  is_retry boolean not null default false,
  retry_of uuid references public.pa_email_deliveries(id) on delete restrict,
  recipient text not null check (char_length(recipient) between 3 and 320),
  subject text not null check (char_length(subject) between 1 and 240),
  body text not null check (char_length(body) between 1 and 20000),
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'failed')),
  requested_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  gmail_message_id text check (gmail_message_id is null or char_length(gmail_message_id) <= 200),
  gmail_thread_id text check (gmail_thread_id is null or char_length(gmail_thread_id) <= 200),
  error_summary text check (error_summary is null or char_length(error_summary) <= 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (dedupe_key, attempt_number),
  check (status <> 'sent' or (sent_at is not null and gmail_message_id is not null)),
  check (status <> 'failed' or failed_at is not null),
  check (is_retry = (attempt_number > 1)),
  check ((is_retry and retry_of is not null) or (not is_retry and retry_of is null))
);

create unique index if not exists pa_email_deliveries_one_success_per_operation
  on public.pa_email_deliveries(dedupe_key)
  where status = 'sent';

create index if not exists pa_email_deliveries_case_idx
  on public.pa_email_deliveries(inquiry_id, requested_at desc);

create index if not exists pa_email_deliveries_status_idx
  on public.pa_email_deliveries(status, requested_at desc);

comment on table public.pa_email_deliveries is
  'PA案件のGmail送信試行履歴。顧客向け受付確認、ARA-TECH向け内部通知、日程確保案内を別記録する。';
comment on column public.pa_email_deliveries.dedupe_key is
  '同じ論理送信を1回だけ成功させるためのサーバー生成キー。外部の宛先指定には使用しない。';
comment on column public.pa_email_deliveries.error_summary is
  '認証情報や本文を含めない管理用エラー分類。';

alter table public.pa_email_deliveries enable row level security;

drop policy if exists "PA admins read email deliveries" on public.pa_email_deliveries;
create policy "PA admins read email deliveries"
on public.pa_email_deliveries for select to authenticated
using (public.is_work_admin());

revoke all on public.pa_email_deliveries from anon, authenticated;
grant select on public.pa_email_deliveries to authenticated;

commit;

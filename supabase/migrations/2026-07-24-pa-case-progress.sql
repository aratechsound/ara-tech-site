-- ARA-20260724-003
-- PA案件を問い合わせ受付から手動入金確認・ケースクローズまで追跡する。
-- 既存の問い合わせ、日程確保、回答、メール、履歴は保持し、同じ inquiry_id を継続利用する。

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regclass('public.pa_inquiry_audit') is null
    or to_regprocedure('public.is_work_admin()') is null
  then
    raise exception 'ARA-20260724-001 schema is required before applying ARA-20260724-003';
  end if;
end;
$$;

create table if not exists public.pa_case_progress (
  inquiry_id uuid primary key references public.pa_inquiries(id) on delete cascade,
  current_step smallint not null default 1 check (current_step between 1 and 14),
  is_on_hold boolean not null default false,
  estimate_amount numeric(12, 2) check (estimate_amount is null or estimate_amount >= 0),
  estimate_created_on date,
  estimate_sent_on date,
  estimate_adjusting boolean not null default false,
  estimate_approved_on date,
  estimate_memo text check (estimate_memo is null or char_length(estimate_memo) <= 10000),
  booking_confirmed_on date,
  confirmed_event_date date,
  event_preparing boolean not null default false,
  event_preparation_completed_on date,
  event_completed_on date,
  event_memo text check (event_memo is null or char_length(event_memo) <= 10000),
  invoice_amount numeric(12, 2) check (invoice_amount is null or invoice_amount >= 0),
  invoice_issued_on date,
  payment_due_on date,
  invoice_sent boolean not null default false,
  invoice_memo text check (invoice_memo is null or char_length(invoice_memo) <= 10000),
  close_reason text check (
    close_reason is null
    or close_reason in (
      'payment_received',
      'schedule_unavailable',
      'declined',
      'cancelled',
      'other_closed'
    )
  ),
  closed_from_step smallint check (closed_from_step is null or closed_from_step between 1 and 13),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.pa_payment_records (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  confirmation_source text not null default 'manual'
    check (confirmation_source in ('manual', 'automatic')),
  payment_date date not null,
  amount numeric(12, 2) not null check (amount >= 0),
  payment_method text not null
    check (payment_method in ('bank_transfer', 'cash', 'other')),
  confirmation_memo text
    check (confirmation_memo is null or char_length(confirmation_memo) <= 5000),
  confirmed_by uuid not null references auth.users(id) on delete restrict,
  confirmed_by_label text not null
    check (char_length(confirmed_by_label) between 1 and 320),
  confirmed_at timestamptz not null default now(),
  external_transaction_id text
    check (external_transaction_id is null or char_length(external_transaction_id) <= 240)
);

create unique index if not exists pa_payment_records_one_close_per_case
  on public.pa_payment_records(inquiry_id);

create index if not exists pa_case_progress_step_idx
  on public.pa_case_progress(current_step, updated_at desc);

create index if not exists pa_payment_records_case_idx
  on public.pa_payment_records(inquiry_id, confirmed_at desc);

create or replace function public.initial_pa_workflow_step(p_status text)
returns smallint
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_status
    when 'new' then 1
    when 'reviewing' then 2
    when 'second_form_not_issued' then 3
    when 'schedule_unconfirmed' then 3
    when 'second_form_issued' then 4
    when 'customer_responded' then 5
    when 'schedule_adjusting' then 5
    when 'needs_confirmation' then 5
    when 'schedule_confirmed' then 6
    when 'schedule_unavailable' then 14
    when 'declined' then 14
    when 'cancelled' then 14
    when 'closed' then 14
    when 'on_hold' then 2
    else 1
  end::smallint;
$$;

create or replace function public.derive_pa_workflow_step(
  p_status text,
  p_estimate_created_on date,
  p_estimate_sent_on date,
  p_estimate_adjusting boolean,
  p_estimate_approved_on date,
  p_booking_confirmed_on date,
  p_event_preparation_completed_on date,
  p_event_completed_on date,
  p_invoice_sent boolean
)
returns smallint
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_status in ('schedule_unavailable', 'declined', 'cancelled', 'closed') then 14
    when p_status <> 'schedule_confirmed' then public.initial_pa_workflow_step(p_status)
    when p_estimate_created_on is null then 6
    when p_estimate_sent_on is null or coalesce(p_estimate_adjusting, false) then 7
    when p_estimate_approved_on is null then 8
    when p_booking_confirmed_on is null then 9
    when p_event_preparation_completed_on is null then 10
    when p_event_completed_on is null then 11
    when coalesce(p_invoice_sent, false) is not true then 12
    else 13
  end::smallint;
$$;

insert into public.pa_case_progress (
  inquiry_id,
  current_step,
  is_on_hold,
  close_reason,
  closed_from_step,
  closed_at
)
select
  inquiry.id,
  public.initial_pa_workflow_step(inquiry.status),
  inquiry.status = 'on_hold',
  case inquiry.status
    when 'schedule_unavailable' then 'schedule_unavailable'
    when 'declined' then 'declined'
    when 'cancelled' then 'cancelled'
    when 'closed' then 'other_closed'
    else null
  end,
  case
    when inquiry.status in ('schedule_unavailable', 'declined') then 5
    when inquiry.status in ('cancelled', 'closed') then 1
    else null
  end,
  case
    when inquiry.status in ('schedule_unavailable', 'declined', 'cancelled', 'closed')
      then coalesce(inquiry.updated_at, now())
    else null
  end
from public.pa_inquiries as inquiry
on conflict (inquiry_id) do nothing;

create or replace function public.sync_pa_case_progress_from_inquiry()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_progress public.pa_case_progress%rowtype;
  v_close_reason text;
  v_next_step smallint;
begin
  select *
  into v_progress
  from public.pa_case_progress
  where inquiry_id = new.id
  for update;

  if not found then
    insert into public.pa_case_progress (
      inquiry_id,
      current_step,
      is_on_hold
    )
    values (
      new.id,
      public.initial_pa_workflow_step(new.status),
      new.status = 'on_hold'
    )
    returning * into v_progress;
  end if;

  if new.status = 'on_hold' then
    update public.pa_case_progress
    set
      is_on_hold = true,
      updated_at = now(),
      updated_by = auth.uid()
    where inquiry_id = new.id;
    return new;
  end if;

  v_next_step := public.derive_pa_workflow_step(
    new.status,
    v_progress.estimate_created_on,
    v_progress.estimate_sent_on,
    v_progress.estimate_adjusting,
    v_progress.estimate_approved_on,
    v_progress.booking_confirmed_on,
    v_progress.event_preparation_completed_on,
    v_progress.event_completed_on,
    v_progress.invoice_sent
  );

  v_close_reason := case new.status
    when 'schedule_unavailable' then 'schedule_unavailable'
    when 'declined' then 'declined'
    when 'cancelled' then 'cancelled'
    when 'closed' then coalesce(v_progress.close_reason, 'other_closed')
    else null
  end;

  update public.pa_case_progress
  set
    current_step = v_next_step,
    is_on_hold = false,
    close_reason = v_close_reason,
    closed_from_step = case
      when v_next_step = 14
        then coalesce(v_progress.closed_from_step, least(v_progress.current_step, 13))
      else null
    end,
    closed_at = case
      when v_next_step = 14 then coalesce(v_progress.closed_at, now())
      else null
    end,
    updated_at = now(),
    updated_by = auth.uid()
  where inquiry_id = new.id;

  return new;
end;
$$;

drop trigger if exists pa_inquiries_sync_case_progress on public.pa_inquiries;
create trigger pa_inquiries_sync_case_progress
after insert or update of status, schedule_state on public.pa_inquiries
for each row execute function public.sync_pa_case_progress_from_inquiry();

create or replace function public.prevent_paid_case_reopen()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'closed'
    and new.status <> 'closed'
    and exists (
      select 1
      from public.pa_case_progress
      where inquiry_id = old.id
        and close_reason = 'payment_received'
    )
  then
    raise exception 'paid case cannot be reopened through the generic case editor';
  end if;
  return new;
end;
$$;

drop trigger if exists pa_inquiries_prevent_paid_reopen on public.pa_inquiries;
create trigger pa_inquiries_prevent_paid_reopen
before update of status on public.pa_inquiries
for each row execute function public.prevent_paid_case_reopen();

create or replace function public.update_pa_case_progress(
  p_inquiry_id uuid,
  p_progress jsonb,
  p_note text default null
)
returns public.pa_case_progress
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inquiry public.pa_inquiries%rowtype;
  v_before public.pa_case_progress%rowtype;
  v_after public.pa_case_progress%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_actor_label text := coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text);
  v_unknown_key text;
  v_next_step smallint;
begin
  if not public.is_work_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_inquiry_id is null
    or p_progress is null
    or jsonb_typeof(p_progress) <> 'object'
    or octet_length(p_progress::text) > 50000
    or (v_note is not null and char_length(v_note) > 5000)
  then
    raise exception 'invalid progress payload';
  end if;

  select key
  into v_unknown_key
  from jsonb_object_keys(p_progress) as field(key)
  where key not in (
    'estimate_amount',
    'estimate_created_on',
    'estimate_sent_on',
    'estimate_adjusting',
    'estimate_approved_on',
    'estimate_memo',
    'booking_confirmed_on',
    'confirmed_event_date',
    'event_preparing',
    'event_preparation_completed_on',
    'event_completed_on',
    'event_memo',
    'invoice_amount',
    'invoice_issued_on',
    'payment_due_on',
    'invoice_sent',
    'invoice_memo'
  )
  limit 1;

  if v_unknown_key is not null then
    raise exception 'unsupported progress field';
  end if;

  select *
  into v_inquiry
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    raise exception 'inquiry not found';
  end if;

  if v_inquiry.status in ('schedule_unavailable', 'declined', 'cancelled', 'closed') then
    raise exception 'closed case cannot be updated';
  end if;
  if v_inquiry.status <> 'schedule_confirmed' then
    raise exception 'case is not ready for estimate and fulfillment progress';
  end if;

  select *
  into v_before
  from public.pa_case_progress
  where inquiry_id = p_inquiry_id
  for update;

  if not found then
    raise exception 'case progress not found';
  end if;

  v_after := v_before;
  v_after.estimate_amount := case when p_progress ? 'estimate_amount'
    then nullif(p_progress ->> 'estimate_amount', '')::numeric else v_before.estimate_amount end;
  v_after.estimate_created_on := case when p_progress ? 'estimate_created_on'
    then nullif(p_progress ->> 'estimate_created_on', '')::date else v_before.estimate_created_on end;
  v_after.estimate_sent_on := case when p_progress ? 'estimate_sent_on'
    then nullif(p_progress ->> 'estimate_sent_on', '')::date else v_before.estimate_sent_on end;
  v_after.estimate_adjusting := case when p_progress ? 'estimate_adjusting'
    then coalesce((p_progress ->> 'estimate_adjusting')::boolean, false) else v_before.estimate_adjusting end;
  v_after.estimate_approved_on := case when p_progress ? 'estimate_approved_on'
    then nullif(p_progress ->> 'estimate_approved_on', '')::date else v_before.estimate_approved_on end;
  v_after.estimate_memo := case when p_progress ? 'estimate_memo'
    then nullif(btrim(coalesce(p_progress ->> 'estimate_memo', '')), '') else v_before.estimate_memo end;
  v_after.booking_confirmed_on := case when p_progress ? 'booking_confirmed_on'
    then nullif(p_progress ->> 'booking_confirmed_on', '')::date else v_before.booking_confirmed_on end;
  v_after.confirmed_event_date := case when p_progress ? 'confirmed_event_date'
    then nullif(p_progress ->> 'confirmed_event_date', '')::date else v_before.confirmed_event_date end;
  v_after.event_preparing := case when p_progress ? 'event_preparing'
    then coalesce((p_progress ->> 'event_preparing')::boolean, false) else v_before.event_preparing end;
  v_after.event_preparation_completed_on := case when p_progress ? 'event_preparation_completed_on'
    then nullif(p_progress ->> 'event_preparation_completed_on', '')::date else v_before.event_preparation_completed_on end;
  v_after.event_completed_on := case when p_progress ? 'event_completed_on'
    then nullif(p_progress ->> 'event_completed_on', '')::date else v_before.event_completed_on end;
  v_after.event_memo := case when p_progress ? 'event_memo'
    then nullif(btrim(coalesce(p_progress ->> 'event_memo', '')), '') else v_before.event_memo end;
  v_after.invoice_amount := case when p_progress ? 'invoice_amount'
    then nullif(p_progress ->> 'invoice_amount', '')::numeric else v_before.invoice_amount end;
  v_after.invoice_issued_on := case when p_progress ? 'invoice_issued_on'
    then nullif(p_progress ->> 'invoice_issued_on', '')::date else v_before.invoice_issued_on end;
  v_after.payment_due_on := case when p_progress ? 'payment_due_on'
    then nullif(p_progress ->> 'payment_due_on', '')::date else v_before.payment_due_on end;
  v_after.invoice_sent := case when p_progress ? 'invoice_sent'
    then coalesce((p_progress ->> 'invoice_sent')::boolean, false) else v_before.invoice_sent end;
  v_after.invoice_memo := case when p_progress ? 'invoice_memo'
    then nullif(btrim(coalesce(p_progress ->> 'invoice_memo', '')), '') else v_before.invoice_memo end;

  if (v_after.estimate_amount is not null and v_after.estimate_amount > 9999999999.99)
    or (v_after.invoice_amount is not null and v_after.invoice_amount > 9999999999.99)
    or char_length(coalesce(v_after.estimate_memo, '')) > 10000
    or char_length(coalesce(v_after.event_memo, '')) > 10000
    or char_length(coalesce(v_after.invoice_memo, '')) > 10000
  then
    raise exception 'progress field is out of range';
  end if;

  if v_after.estimate_sent_on is not null and v_after.estimate_created_on is null then
    raise exception 'estimate creation date is required before sending';
  end if;
  if v_after.estimate_approved_on is not null and v_after.estimate_sent_on is null then
    raise exception 'estimate sent date is required before approval';
  end if;
  if v_after.estimate_approved_on is not null and v_after.estimate_adjusting then
    raise exception 'approved estimate cannot remain adjusting';
  end if;
  if v_after.booking_confirmed_on is not null and v_after.estimate_approved_on is null then
    raise exception 'estimate approval is required before booking';
  end if;
  if v_after.booking_confirmed_on is not null and v_after.confirmed_event_date is null then
    raise exception 'confirmed event date is required before booking';
  end if;
  if v_after.event_preparing and v_after.booking_confirmed_on is null then
    raise exception 'booking is required before event preparation';
  end if;
  if v_after.event_preparation_completed_on is not null and v_after.booking_confirmed_on is null then
    raise exception 'booking is required before event preparation completion';
  end if;
  if v_after.event_completed_on is not null and v_after.event_preparation_completed_on is null then
    raise exception 'event preparation completion is required before event completion';
  end if;
  if v_after.invoice_sent and (
    v_after.event_completed_on is null
    or v_after.invoice_amount is null
    or v_after.invoice_issued_on is null
    or v_after.payment_due_on is null
  ) then
    raise exception 'event completion, invoice amount, invoice date and due date are required before invoicing';
  end if;

  v_next_step := public.derive_pa_workflow_step(
    v_inquiry.status,
    v_after.estimate_created_on,
    v_after.estimate_sent_on,
    v_after.estimate_adjusting,
    v_after.estimate_approved_on,
    v_after.booking_confirmed_on,
    v_after.event_preparation_completed_on,
    v_after.event_completed_on,
    v_after.invoice_sent
  );

  update public.pa_case_progress
  set
    current_step = v_next_step,
    estimate_amount = v_after.estimate_amount,
    estimate_created_on = v_after.estimate_created_on,
    estimate_sent_on = v_after.estimate_sent_on,
    estimate_adjusting = v_after.estimate_adjusting,
    estimate_approved_on = v_after.estimate_approved_on,
    estimate_memo = v_after.estimate_memo,
    booking_confirmed_on = v_after.booking_confirmed_on,
    confirmed_event_date = v_after.confirmed_event_date,
    event_preparing = v_after.event_preparing,
    event_preparation_completed_on = v_after.event_preparation_completed_on,
    event_completed_on = v_after.event_completed_on,
    event_memo = v_after.event_memo,
    invoice_amount = v_after.invoice_amount,
    invoice_issued_on = v_after.invoice_issued_on,
    payment_due_on = v_after.payment_due_on,
    invoice_sent = v_after.invoice_sent,
    invoice_memo = v_after.invoice_memo,
    updated_at = now(),
    updated_by = auth.uid()
  where inquiry_id = p_inquiry_id
  returning * into v_after;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    actor_user_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    auth.uid(),
    'case_progress_updated',
    jsonb_build_object(
      'step_before', v_before.current_step,
      'step_after', v_after.current_step,
      'state_before', to_jsonb(v_before) - array['inquiry_id', 'created_at', 'updated_at', 'updated_by'],
      'state_after', to_jsonb(v_after) - array['inquiry_id', 'created_at', 'updated_at', 'updated_by'],
      'note', v_note,
      'operator_label', v_actor_label
    )
  );

  return v_after;
end;
$$;

create or replace function public.confirm_pa_payment_and_close(
  p_inquiry_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_payment_method text,
  p_confirmation_memo text,
  p_mismatch_confirmed boolean default false
)
returns table (
  payment_id uuid,
  result_status text,
  result_step smallint,
  result_close_reason text,
  result_closed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inquiry public.pa_inquiries%rowtype;
  v_progress public.pa_case_progress%rowtype;
  v_payment public.pa_payment_records%rowtype;
  v_memo text := nullif(btrim(coalesce(p_confirmation_memo, '')), '');
  v_confirmed_at timestamptz := now();
  v_actor_label text := coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text);
begin
  if not public.is_work_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_inquiry_id is null
    or p_payment_date is null
    or p_amount is null
    or p_amount < 0
    or p_amount > 9999999999.99
    or p_payment_method not in ('bank_transfer', 'cash', 'other')
    or (v_memo is not null and char_length(v_memo) > 5000)
  then
    raise exception 'invalid payment confirmation';
  end if;

  select *
  into v_inquiry
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    raise exception 'inquiry not found';
  end if;

  select *
  into v_progress
  from public.pa_case_progress
  where inquiry_id = p_inquiry_id
  for update;

  if not found then
    raise exception 'case progress not found';
  end if;

  if v_inquiry.status <> 'schedule_confirmed'
    or v_progress.current_step <> 13
    or v_progress.invoice_sent is not true
    or v_progress.invoice_amount is null
  then
    raise exception 'case is not ready for payment confirmation';
  end if;

  if round(v_progress.invoice_amount, 2) <> round(p_amount, 2)
    and p_mismatch_confirmed is not true
  then
    raise exception 'payment amount mismatch confirmation required';
  end if;

  insert into public.pa_payment_records (
    inquiry_id,
    confirmation_source,
    payment_date,
    amount,
    payment_method,
    confirmation_memo,
    confirmed_by,
    confirmed_by_label,
    confirmed_at,
    external_transaction_id
  )
  values (
    p_inquiry_id,
    'manual',
    p_payment_date,
    round(p_amount, 2),
    p_payment_method,
    v_memo,
    auth.uid(),
    v_actor_label,
    v_confirmed_at,
    null
  )
  returning * into v_payment;

  update public.pa_case_progress
  set
    current_step = 14,
    is_on_hold = false,
    close_reason = 'payment_received',
    closed_from_step = 13,
    closed_at = v_confirmed_at,
    updated_at = v_confirmed_at,
    updated_by = auth.uid()
  where inquiry_id = p_inquiry_id;

  update public.pa_inquiries
  set status = 'closed'
  where id = p_inquiry_id;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    actor_user_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    auth.uid(),
    'payment_confirmed_and_closed',
    jsonb_build_object(
      'status_before', v_inquiry.status,
      'status_after', 'closed',
      'step_before', v_progress.current_step,
      'step_after', 14,
      'payment_date', p_payment_date,
      'payment_amount', round(p_amount, 2),
      'invoice_amount', v_progress.invoice_amount,
      'payment_method', p_payment_method,
      'confirmation_source', 'manual',
      'memo', v_memo,
      'operator_label', v_actor_label,
      'confirmed_at', v_confirmed_at
    )
  );

  payment_id := v_payment.id;
  result_status := 'closed';
  result_step := 14;
  result_close_reason := 'payment_received';
  result_closed_at := v_confirmed_at;
  return next;
end;
$$;

alter table public.pa_case_progress enable row level security;
alter table public.pa_payment_records enable row level security;

drop policy if exists "PA admins read case progress" on public.pa_case_progress;
create policy "PA admins read case progress"
on public.pa_case_progress for select to authenticated
using (public.is_work_admin());

drop policy if exists "PA admins read payment records" on public.pa_payment_records;
create policy "PA admins read payment records"
on public.pa_payment_records for select to authenticated
using (public.is_work_admin());

revoke all on public.pa_case_progress from anon, authenticated;
revoke all on public.pa_payment_records from anon, authenticated;
grant select on public.pa_case_progress to authenticated;
grant select on public.pa_payment_records to authenticated;

revoke all on function public.update_pa_case_progress(uuid, jsonb, text) from public;
revoke all on function public.update_pa_case_progress(uuid, jsonb, text) from anon;
revoke all on function public.confirm_pa_payment_and_close(uuid, date, numeric, text, text, boolean) from public;
revoke all on function public.confirm_pa_payment_and_close(uuid, date, numeric, text, text, boolean) from anon;
grant execute on function public.update_pa_case_progress(uuid, jsonb, text) to authenticated;
grant execute on function public.confirm_pa_payment_and_close(uuid, date, numeric, text, text, boolean) to authenticated;

comment on table public.pa_case_progress is
  '同じPA問い合わせ案件を見積り、正式予約、実施、請求、入金確認まで継続管理する。';
comment on table public.pa_payment_records is
  '手動入金確認を保存する。confirmation_sourceとexternal_transaction_idは将来自動照合用に予約する。';
comment on function public.confirm_pa_payment_and_close(uuid, date, numeric, text, text, boolean) is
  '管理者専用。入金記録、案件クローズ、履歴を同一トランザクションで確定する。';

commit;

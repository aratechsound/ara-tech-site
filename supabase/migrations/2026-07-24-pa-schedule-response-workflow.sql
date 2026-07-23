-- ARA-20260724-001
-- 日程確保フォーム回答後の状態遷移、回答通知、結果メール連動を追加する。
-- 既存回答・トークン・送信履歴は削除せず、後方互換で状態だけを補正する。

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regclass('public.pa_schedule_responses') is null
    or to_regclass('public.pa_email_deliveries') is null
  then
    raise exception 'ARA-20260723-010 schema is required before applying ARA-20260724-001';
  end if;
end;
$$;

alter table public.pa_inquiries
  drop constraint if exists pa_inquiries_status_check;

alter table public.pa_inquiries
  add constraint pa_inquiries_status_check
  check (status in (
    'new',
    'reviewing',
    'second_form_not_issued',
    'second_form_issued',
    'customer_responded',
    'schedule_unconfirmed',
    'schedule_adjusting',
    'needs_confirmation',
    'declined',
    'schedule_confirmed',
    'schedule_unavailable',
    'on_hold',
    'cancelled',
    'closed'
  ));

alter table public.pa_inquiries
  drop constraint if exists pa_inquiries_schedule_state_check;

alter table public.pa_inquiries
  add constraint pa_inquiries_schedule_state_check
  check (schedule_state in ('unconfirmed', 'completed', 'unavailable'));

alter table public.pa_inquiries
  add column if not exists schedule_result_kind text
    check (schedule_result_kind is null or schedule_result_kind in ('confirmed', 'unavailable')),
  add column if not exists schedule_result_sent_at timestamptz,
  add column if not exists schedule_result_delivery_id uuid
    references public.pa_email_deliveries(id) on delete restrict;

alter table public.pa_email_deliveries
  drop constraint if exists pa_email_deliveries_message_type_check;

alter table public.pa_email_deliveries
  add constraint pa_email_deliveries_message_type_check
  check (message_type in (
    'internal_new_inquiry',
    'customer_receipt',
    'schedule_request',
    'schedule_response_agree_customer',
    'schedule_response_agree_internal',
    'schedule_response_question_customer',
    'schedule_response_question_internal',
    'schedule_response_decline_customer',
    'schedule_response_decline_internal',
    'schedule_result_confirmed',
    'schedule_result_unavailable'
  ));

create unique index if not exists pa_email_deliveries_one_initial_result_per_case
  on public.pa_email_deliveries(inquiry_id)
  where message_type in ('schedule_result_confirmed', 'schedule_result_unavailable')
    and attempt_number = 1;

create or replace function public.derive_pa_schedule_response_status()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_decision text;
begin
  if new.status = 'customer_responded' then
    select decision
    into v_decision
    from public.pa_schedule_responses
    where inquiry_id = new.id;

    new.status := case v_decision
      when 'agree' then 'schedule_adjusting'
      when 'question' then 'needs_confirmation'
      when 'decline' then 'declined'
      else new.status
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists pa_inquiries_derive_response_status on public.pa_inquiries;
create trigger pa_inquiries_derive_response_status
before update on public.pa_inquiries
for each row execute function public.derive_pa_schedule_response_status();

update public.pa_inquiries as inquiry
set status = case response.decision
  when 'agree' then 'schedule_adjusting'
  when 'question' then 'needs_confirmation'
  when 'decline' then 'declined'
  else inquiry.status
end
from public.pa_schedule_responses as response
where response.inquiry_id = inquiry.id
  and inquiry.status in ('customer_responded', 'schedule_unconfirmed');

create or replace function public.finalize_pa_schedule_result(
  p_inquiry_id uuid,
  p_delivery_id uuid,
  p_result text
)
returns table (
  result_status text,
  result_schedule_state text,
  result_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_delivery public.pa_email_deliveries%rowtype;
  v_inquiry public.pa_inquiries%rowtype;
  v_expected_type text;
  v_target_status text;
  v_target_schedule_state text;
  v_now timestamptz := now();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_result not in ('confirmed', 'unavailable') then
    raise exception 'invalid result';
  end if;

  v_expected_type := case p_result
    when 'confirmed' then 'schedule_result_confirmed'
    else 'schedule_result_unavailable'
  end;
  v_target_status := case p_result
    when 'confirmed' then 'schedule_confirmed'
    else 'schedule_unavailable'
  end;
  v_target_schedule_state := case p_result
    when 'confirmed' then 'completed'
    else 'unavailable'
  end;

  select *
  into v_delivery
  from public.pa_email_deliveries
  where id = p_delivery_id
  for update;

  if not found
    or v_delivery.inquiry_id <> p_inquiry_id
    or v_delivery.message_type <> v_expected_type
    or v_delivery.status <> 'sent'
    or v_delivery.sent_at is null
    or v_delivery.gmail_message_id is null
  then
    raise exception 'sent result delivery is required';
  end if;

  perform 1
  from public.pa_schedule_responses
  where inquiry_id = p_inquiry_id
    and decision = 'agree';

  if not found then
    raise exception 'schedule adjustment response is required';
  end if;

  select *
  into v_inquiry
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    raise exception 'inquiry not found';
  end if;

  if v_inquiry.status = v_target_status
    and v_inquiry.schedule_result_delivery_id = p_delivery_id
  then
    result_status := v_inquiry.status;
    result_schedule_state := v_inquiry.schedule_state;
    result_at := v_inquiry.schedule_result_sent_at;
    return next;
    return;
  end if;

  if v_inquiry.status <> 'schedule_adjusting'
    or v_inquiry.schedule_state <> 'unconfirmed'
    or v_inquiry.schedule_result_kind is not null
  then
    raise exception 'result transition is not allowed';
  end if;

  update public.pa_inquiries
  set
    status = v_target_status,
    schedule_state = v_target_schedule_state,
    schedule_result_kind = p_result,
    schedule_result_sent_at = v_delivery.sent_at,
    schedule_result_delivery_id = v_delivery.id,
    schedule_confirmed_at = case when p_result = 'confirmed' then v_delivery.sent_at else null end,
    customer_confirmation_sent_at = case when p_result = 'confirmed' then v_delivery.sent_at else null end
  where id = p_inquiry_id;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    case p_result
      when 'confirmed' then 'schedule_result_confirmed_after_mail'
      else 'schedule_result_unavailable_after_mail'
    end,
    jsonb_build_object(
      'delivery_id', p_delivery_id,
      'result', p_result,
      'sent_at', v_delivery.sent_at
    )
  );

  result_status := v_target_status;
  result_schedule_state := v_target_schedule_state;
  result_at := v_delivery.sent_at;
  return next;
end;
$$;

create or replace function public.enforce_pa_schedule_result_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_expected_type text;
begin
  if new.status in ('schedule_confirmed', 'schedule_unavailable')
    and new.status is distinct from old.status
  then
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'result state requires a sent Gmail delivery';
    end if;

    v_expected_type := case new.status
      when 'schedule_confirmed' then 'schedule_result_confirmed'
      else 'schedule_result_unavailable'
    end;

    perform 1
    from public.pa_email_deliveries
    where id = new.schedule_result_delivery_id
      and inquiry_id = new.id
      and message_type = v_expected_type
      and status = 'sent'
      and sent_at is not null
      and gmail_message_id is not null;

    if not found then
      raise exception 'result state requires a sent Gmail delivery';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists pa_inquiries_enforce_result_transition on public.pa_inquiries;
create trigger pa_inquiries_enforce_result_transition
before update on public.pa_inquiries
for each row execute function public.enforce_pa_schedule_result_transition();

revoke all on function public.finalize_pa_schedule_result(uuid, uuid, text) from public;
revoke all on function public.finalize_pa_schedule_result(uuid, uuid, text) from anon;
revoke all on function public.finalize_pa_schedule_result(uuid, uuid, text) from authenticated;
grant execute on function public.finalize_pa_schedule_result(uuid, uuid, text) to service_role;

-- 旧関数による「メール未送信の手動確定」を停止する。
revoke all on function public.confirm_pa_schedule(uuid, boolean) from public;
revoke all on function public.confirm_pa_schedule(uuid, boolean) from anon;
revoke all on function public.confirm_pa_schedule(uuid, boolean) from authenticated;

comment on function public.finalize_pa_schedule_result(uuid, uuid, text) is
  'Gmail送信済みレコードを確認した場合だけ日程確保結果へ状態遷移する。service_role専用。';

commit;

-- ARA-20260901-001
-- 受付確認メール後に、人が内容確認・ヒアリングメールを送る営業工程を追加する。
-- 既存の案件、日程確保、送信履歴、進捗、監査履歴を更新・削除しない後方互換マイグレーション。

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regclass('public.pa_email_deliveries') is null
    or to_regclass('public.pa_inquiry_audit') is null
    or to_regprocedure('public.is_work_admin()') is null
  then
    raise exception 'PA inquiry, delivery, audit and admin schema are required before ARA-20260901-001';
  end if;
end;
$$;

alter table public.pa_inquiries
  drop constraint if exists pa_inquiries_status_check;

alter table public.pa_inquiries
  add constraint pa_inquiries_status_check
  check (status in (
    'new',
    'new_inquiry',
    'follow_up_pending',
    'waiting_customer_reply',
    'hearing',
    'rough_estimate',
    'customer_intent_confirmed',
    'schedule_coordination',
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

alter table public.pa_email_deliveries
  drop constraint if exists pa_email_deliveries_message_type_check;

alter table public.pa_email_deliveries
  add constraint pa_email_deliveries_message_type_check
  check (message_type in (
    'internal_new_inquiry',
    'customer_receipt',
    'content_hearing_follow_up',
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

create unique index if not exists pa_email_deliveries_one_initial_content_hearing_per_case
  on public.pa_email_deliveries(inquiry_id)
  where message_type = 'content_hearing_follow_up'
    and attempt_number = 1;

create or replace function public.initial_pa_workflow_step(p_status text)
returns smallint
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_status
    when 'new' then 1
    when 'new_inquiry' then 1
    when 'follow_up_pending' then 1
    when 'waiting_customer_reply' then 2
    when 'hearing' then 2
    when 'rough_estimate' then 2
    when 'customer_intent_confirmed' then 2
    when 'schedule_coordination' then 3
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

create or replace function public.finalize_pa_content_hearing_delivery(
  p_inquiry_id uuid,
  p_delivery_id uuid
)
returns table (
  result_status text,
  result_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_delivery public.pa_email_deliveries%rowtype;
  v_inquiry public.pa_inquiries%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select *
  into v_delivery
  from public.pa_email_deliveries
  where id = p_delivery_id
  for update;

  if not found
    or v_delivery.inquiry_id <> p_inquiry_id
    or v_delivery.message_type <> 'content_hearing_follow_up'
    or v_delivery.status <> 'sent'
    or v_delivery.sent_at is null
    or v_delivery.gmail_message_id is null
  then
    raise exception 'sent content hearing delivery is required';
  end if;

  select *
  into v_inquiry
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    raise exception 'inquiry not found';
  end if;

  if v_inquiry.status = 'waiting_customer_reply' then
    result_status := v_inquiry.status;
    result_at := v_delivery.sent_at;
    return next;
    return;
  end if;

  if v_inquiry.status not in ('new', 'new_inquiry', 'follow_up_pending') then
    raise exception 'content hearing transition is not allowed';
  end if;

  update public.pa_inquiries
  set status = 'waiting_customer_reply'
  where id = p_inquiry_id;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    'content_hearing_follow_up_sent',
    jsonb_build_object(
      'delivery_id', p_delivery_id,
      'sent_at', v_delivery.sent_at
    )
  );

  result_status := 'waiting_customer_reply';
  result_at := v_delivery.sent_at;
  return next;
end;
$$;

create or replace function public.enforce_pa_content_hearing_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'waiting_customer_reply'
    and new.status is distinct from old.status
  then
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'content hearing state requires a sent Gmail delivery';
    end if;

    perform 1
    from public.pa_email_deliveries
    where inquiry_id = new.id
      and message_type = 'content_hearing_follow_up'
      and status = 'sent'
      and sent_at is not null
      and gmail_message_id is not null;

    if not found then
      raise exception 'content hearing state requires a sent Gmail delivery';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists pa_inquiries_enforce_content_hearing_transition on public.pa_inquiries;
create trigger pa_inquiries_enforce_content_hearing_transition
before update on public.pa_inquiries
for each row execute function public.enforce_pa_content_hearing_transition();

create or replace function public.issue_pa_schedule_token(
  p_inquiry_id uuid,
  p_token text,
  p_expires_at timestamptz
)
returns table (
  token_id uuid,
  issued_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_token public.pa_schedule_tokens%rowtype;
  v_inquiry public.pa_inquiries%rowtype;
  v_expiry timestamptz;
begin
  if not public.is_work_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_token is null
    or char_length(p_token) < 43
    or char_length(p_token) > 128
    or p_token !~ '^[A-Za-z0-9_-]+$'
  then
    raise exception 'invalid token';
  end if;

  v_expiry := coalesce(p_expires_at, now() + interval '7 days');
  if v_expiry <= now() or v_expiry > now() + interval '180 days' then
    raise exception 'invalid expiry';
  end if;

  select *
  into v_inquiry
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    raise exception 'inquiry not found';
  end if;

  if v_inquiry.status not in (
    'schedule_coordination',
    'second_form_not_issued',
    'second_form_issued',
    'schedule_unconfirmed',
    'customer_responded',
    'schedule_adjusting',
    'needs_confirmation'
  ) then
    raise exception 'schedule form is not allowed before schedule coordination';
  end if;

  update public.pa_schedule_tokens
  set revoked_at = now()
  where inquiry_id = p_inquiry_id
    and revoked_at is null
    and answered_at is null;

  insert into public.pa_schedule_tokens (
    inquiry_id,
    token_hash,
    expires_at,
    issued_by
  )
  values (
    p_inquiry_id,
    digest(convert_to(p_token, 'UTF8'), 'sha256'),
    v_expiry,
    auth.uid()
  )
  returning * into v_token;

  update public.pa_inquiries
  set
    status = 'second_form_issued',
    second_form_issued_at = v_token.issued_at,
    response_deadline = v_token.expires_at
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
    'second_form_token_issued',
    jsonb_build_object('expires_at', v_token.expires_at)
  );

  return query
  select v_token.id, v_token.issued_at, v_token.expires_at;
end;
$$;

revoke all on function public.finalize_pa_content_hearing_delivery(uuid, uuid) from public;
revoke all on function public.finalize_pa_content_hearing_delivery(uuid, uuid) from anon;
revoke all on function public.finalize_pa_content_hearing_delivery(uuid, uuid) from authenticated;
grant execute on function public.finalize_pa_content_hearing_delivery(uuid, uuid) to service_role;

comment on function public.finalize_pa_content_hearing_delivery(uuid, uuid) is
  'Gmail送信済みの内容確認・ヒアリングメールを確認した場合だけ、お客様回答待ちへ状態遷移する。service_role専用。';
comment on function public.issue_pa_schedule_token(uuid, text, timestamptz) is
  '管理者専用。お客様の依頼意思確認後の日程・人員調整段階以降だけ、日程確保フォームURLを発行する。';

commit;

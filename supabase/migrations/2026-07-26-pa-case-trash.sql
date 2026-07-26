-- ARA-20260726-003
-- PA案件を「ゴミ箱へ移動」「復元」「完全削除」するための安全な論理削除と管理RPC。
-- status / schedule_state / pa_case_progress は論理削除時に変更しない。

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regclass('public.pa_case_progress') is null
    or to_regclass('public.pa_payment_records') is null
    or to_regclass('public.pa_schedule_tokens') is null
    or to_regclass('public.pa_schedule_responses') is null
    or to_regclass('public.pa_email_deliveries') is null
    or to_regclass('public.pa_inquiry_audit') is null
    or to_regclass('public.work_admins') is null
  then
    raise exception 'PA inquiry, progress, payment, token, response, email, audit, and admin schemas are required';
  end if;
end;
$$;

alter table public.pa_inquiries
  add column if not exists deleted_at timestamptz,
  add column if not exists delete_reason text,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pa_inquiries_delete_reason_check'
      and conrelid = 'public.pa_inquiries'::regclass
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_delete_reason_check
      check (
        delete_reason is null
        or delete_reason in ('test_case', 'duplicate', 'input_error', 'other')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pa_inquiries_soft_delete_consistency'
      and conrelid = 'public.pa_inquiries'::regclass
  ) then
    alter table public.pa_inquiries
      add constraint pa_inquiries_soft_delete_consistency
      check (
        (deleted_at is null and delete_reason is null and deleted_by is null)
        or (deleted_at is not null and delete_reason is not null)
      );
  end if;
end;
$$;

create index if not exists pa_inquiries_deleted_at_idx
  on public.pa_inquiries(deleted_at desc)
  where deleted_at is not null;

create index if not exists pa_inquiries_active_status_idx
  on public.pa_inquiries(status, updated_at desc)
  where deleted_at is null;

comment on column public.pa_inquiries.deleted_at is
  'ゴミ箱へ移動した日時。NULLの案件だけを通常一覧・検索・履歴・件数へ含める。';
comment on column public.pa_inquiries.delete_reason is
  'test_case / duplicate / input_error / other のいずれか。ケースクローズ理由とは別管理。';
comment on column public.pa_inquiries.deleted_by is
  'ゴミ箱へ移動した管理者。管理者アカウント削除時はNULLになり得る。';

create or replace function public.is_pa_admin_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.work_admins
      where user_id = p_user_id
    );
$$;

revoke all on function public.is_pa_admin_user(uuid) from public, anon, authenticated;
grant execute on function public.is_pa_admin_user(uuid) to service_role;

create or replace function public.guard_pa_inquiry_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_mode text := coalesce(current_setting('app.pa_case_delete_mode', true), '');
begin
  if (
    old.deleted_at is distinct from new.deleted_at
    or old.delete_reason is distinct from new.delete_reason
    or old.deleted_by is distinct from new.deleted_by
  ) and v_mode not in ('trash', 'restore') then
    raise exception 'soft delete fields may only be changed by the PA trash RPC'
      using errcode = '42501';
  end if;

  if old.deleted_at is not null
    and new.deleted_at is not null
    and v_mode not in ('trash', 'restore', 'purge')
  then
    raise exception 'case is in trash'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists pa_inquiries_guard_soft_delete on public.pa_inquiries;
create trigger pa_inquiries_guard_soft_delete
before update on public.pa_inquiries
for each row execute function public.guard_pa_inquiry_soft_delete();

create or replace function public.guard_deleted_pa_related_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inquiry_id uuid;
  v_deleted_at timestamptz;
  v_mode text := coalesce(current_setting('app.pa_case_delete_mode', true), '');
begin
  if v_mode = 'purge' then
    return new;
  end if;

  v_inquiry_id := new.inquiry_id;
  select deleted_at
  into v_deleted_at
  from public.pa_inquiries
  where id = v_inquiry_id;

  if not found then
    raise exception 'inquiry not found';
  end if;

  if v_deleted_at is not null then
    raise exception 'case is in trash'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists pa_schedule_tokens_guard_deleted_case on public.pa_schedule_tokens;
create trigger pa_schedule_tokens_guard_deleted_case
before insert or update on public.pa_schedule_tokens
for each row execute function public.guard_deleted_pa_related_write();

drop trigger if exists pa_schedule_responses_guard_deleted_case on public.pa_schedule_responses;
create trigger pa_schedule_responses_guard_deleted_case
before insert or update on public.pa_schedule_responses
for each row execute function public.guard_deleted_pa_related_write();

drop trigger if exists pa_case_progress_guard_deleted_case on public.pa_case_progress;
create trigger pa_case_progress_guard_deleted_case
before insert or update on public.pa_case_progress
for each row execute function public.guard_deleted_pa_related_write();

drop trigger if exists pa_payment_records_guard_deleted_case on public.pa_payment_records;
create trigger pa_payment_records_guard_deleted_case
before insert or update on public.pa_payment_records
for each row execute function public.guard_deleted_pa_related_write();

drop trigger if exists pa_email_deliveries_guard_deleted_case on public.pa_email_deliveries;
create trigger pa_email_deliveries_guard_deleted_case
before insert or update on public.pa_email_deliveries
for each row execute function public.guard_deleted_pa_related_write();

create or replace function public.trash_pa_case(
  p_inquiry_id uuid,
  p_reason text,
  p_actor_user_id uuid
)
returns table (
  result text,
  inquiry_id uuid,
  inquiry_number text,
  deleted_at timestamptz,
  delete_reason text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_case public.pa_inquiries%rowtype;
  v_deleted_at timestamptz := now();
begin
  if not public.is_pa_admin_user(p_actor_user_id) then
    return query select 'not_authorized', null::uuid, null::text, null::timestamptz, null::text;
    return;
  end if;

  if p_reason is null
    or p_reason not in ('test_case', 'duplicate', 'input_error', 'other')
  then
    return query select 'invalid_reason', null::uuid, null::text, null::timestamptz, null::text;
    return;
  end if;

  select *
  into v_case
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    return query select 'not_found', null::uuid, null::text, null::timestamptz, null::text;
    return;
  end if;

  if v_case.deleted_at is not null then
    return query
    select
      'already_trashed',
      v_case.id,
      v_case.inquiry_number,
      v_case.deleted_at,
      v_case.delete_reason;
    return;
  end if;

  perform set_config('app.pa_case_delete_mode', 'trash', true);

  update public.pa_inquiries
  set
    deleted_at = v_deleted_at,
    delete_reason = p_reason,
    deleted_by = p_actor_user_id
  where id = p_inquiry_id;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    actor_user_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    p_actor_user_id,
    'case_moved_to_trash',
    jsonb_build_object(
      'delete_reason', p_reason,
      'deleted_at', v_deleted_at,
      'status_preserved', v_case.status,
      'schedule_state_preserved', v_case.schedule_state
    )
  );

  return query
  select 'trashed', v_case.id, v_case.inquiry_number, v_deleted_at, p_reason;
end;
$$;

create or replace function public.restore_pa_case(
  p_inquiry_id uuid,
  p_actor_user_id uuid
)
returns table (
  result text,
  inquiry_id uuid,
  inquiry_number text,
  active_token_restored boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_case public.pa_inquiries%rowtype;
  v_active_token boolean := false;
begin
  if not public.is_pa_admin_user(p_actor_user_id) then
    return query select 'not_authorized', null::uuid, null::text, false;
    return;
  end if;

  select *
  into v_case
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    return query select 'not_found', null::uuid, null::text, false;
    return;
  end if;

  if v_case.deleted_at is null then
    return query select 'already_active', v_case.id, v_case.inquiry_number, false;
    return;
  end if;

  select exists (
    select 1
    from public.pa_schedule_tokens as token
    where token.inquiry_id = p_inquiry_id
      and token.revoked_at is null
      and token.answered_at is null
      and token.expires_at > now()
  )
  into v_active_token;

  perform set_config('app.pa_case_delete_mode', 'restore', true);

  update public.pa_inquiries
  set
    deleted_at = null,
    delete_reason = null,
    deleted_by = null
  where id = p_inquiry_id;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    actor_user_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    p_actor_user_id,
    'case_restored_from_trash',
    jsonb_build_object(
      'restored_at', now(),
      'status_restored', v_case.status,
      'schedule_state_restored', v_case.schedule_state,
      'active_token_restored', v_active_token
    )
  );

  return query
  select 'restored', v_case.id, v_case.inquiry_number, v_active_token;
end;
$$;

create or replace function public.get_pa_case_delete_impact(
  p_inquiry_id uuid,
  p_actor_user_id uuid
)
returns table (
  result text,
  inquiry_id uuid,
  inquiry_number text,
  progress_count bigint,
  payment_count bigint,
  token_count bigint,
  response_count bigint,
  email_count bigint,
  audit_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_case public.pa_inquiries%rowtype;
begin
  if not public.is_pa_admin_user(p_actor_user_id) then
    return query
    select 'not_authorized', null::uuid, null::text, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  select *
  into v_case
  from public.pa_inquiries
  where id = p_inquiry_id;

  if not found then
    return query
    select 'not_found', null::uuid, null::text, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  if v_case.deleted_at is null then
    return query
    select 'not_trashed', v_case.id, v_case.inquiry_number, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  return query
  select
    'ready',
    v_case.id,
    v_case.inquiry_number,
    (select count(*) from public.pa_case_progress where pa_case_progress.inquiry_id = p_inquiry_id),
    (select count(*) from public.pa_payment_records where pa_payment_records.inquiry_id = p_inquiry_id),
    (select count(*) from public.pa_schedule_tokens where pa_schedule_tokens.inquiry_id = p_inquiry_id),
    (select count(*) from public.pa_schedule_responses where pa_schedule_responses.inquiry_id = p_inquiry_id),
    (select count(*) from public.pa_email_deliveries where pa_email_deliveries.inquiry_id = p_inquiry_id),
    (select count(*) from public.pa_inquiry_audit where pa_inquiry_audit.inquiry_id = p_inquiry_id);
end;
$$;

create or replace function public.purge_pa_case(
  p_inquiry_id uuid,
  p_confirmation text,
  p_actor_user_id uuid
)
returns table (
  result text,
  inquiry_id uuid,
  inquiry_number text,
  progress_deleted bigint,
  payments_deleted bigint,
  tokens_deleted bigint,
  responses_deleted bigint,
  emails_deleted bigint,
  audits_deleted bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_case public.pa_inquiries%rowtype;
  v_progress_count bigint;
  v_payment_count bigint;
  v_token_count bigint;
  v_response_count bigint;
  v_email_count bigint;
  v_audit_count bigint;
begin
  if not public.is_pa_admin_user(p_actor_user_id) then
    return query
    select 'not_authorized', null::uuid, null::text, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  select *
  into v_case
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    return query
    select 'not_found', null::uuid, null::text, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  if v_case.deleted_at is null then
    return query
    select 'not_trashed', v_case.id, v_case.inquiry_number, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  if p_confirmation is null or p_confirmation <> v_case.inquiry_number then
    return query
    select 'confirmation_mismatch', v_case.id, v_case.inquiry_number, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  select count(*) into v_progress_count
  from public.pa_case_progress as progress
  where progress.inquiry_id = p_inquiry_id;
  select count(*) into v_payment_count
  from public.pa_payment_records as payment
  where payment.inquiry_id = p_inquiry_id;
  select count(*) into v_token_count
  from public.pa_schedule_tokens as token
  where token.inquiry_id = p_inquiry_id;
  select count(*) into v_response_count
  from public.pa_schedule_responses as response
  where response.inquiry_id = p_inquiry_id;
  select count(*) into v_email_count
  from public.pa_email_deliveries as delivery
  where delivery.inquiry_id = p_inquiry_id;
  select count(*) into v_audit_count
  from public.pa_inquiry_audit as audit
  where audit.inquiry_id = p_inquiry_id;

  perform set_config('app.pa_case_delete_mode', 'purge', true);

  -- pa_inquiries から送信履歴へのRESTRICT参照を、履歴削除前に同一トランザクションで解除する。
  update public.pa_inquiries as inquiry
  set schedule_result_delivery_id = null
  where inquiry.id = p_inquiry_id
    and inquiry.schedule_result_delivery_id is not null;

  -- retry_of の自己参照RESTRICTを先に解除し、同じトランザクション内で全履歴を削除する。
  update public.pa_email_deliveries as delivery
  set retry_of = null
  where delivery.inquiry_id = p_inquiry_id
    and delivery.retry_of is not null;

  delete from public.pa_payment_records as payment
  where payment.inquiry_id = p_inquiry_id;
  delete from public.pa_schedule_responses as response
  where response.inquiry_id = p_inquiry_id;
  delete from public.pa_schedule_tokens as token
  where token.inquiry_id = p_inquiry_id;
  delete from public.pa_email_deliveries as delivery
  where delivery.inquiry_id = p_inquiry_id;
  delete from public.pa_case_progress as progress
  where progress.inquiry_id = p_inquiry_id;
  delete from public.pa_inquiry_audit as audit
  where audit.inquiry_id = p_inquiry_id;
  delete from public.pa_inquiries as inquiry
  where inquiry.id = p_inquiry_id;

  return query
  select
    'purged',
    v_case.id,
    v_case.inquiry_number,
    v_progress_count,
    v_payment_count,
    v_token_count,
    v_response_count,
    v_email_count,
    v_audit_count;
end;
$$;

-- 顧客URLは、案件がゴミ箱にある間はトークン自体を改変せず無効として扱う。
-- 復元後も期限切れ・無効化済み・回答済みトークンは従来どおり再利用できない。
create or replace function public.get_pa_schedule_case(p_token text)
returns table (
  access_state text,
  inquiry_number text,
  public_addressee text,
  event_name text,
  event_date date,
  event_time text,
  venue text,
  request_summary text,
  guidance text,
  conditions text,
  response_deadline timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_token public.pa_schedule_tokens%rowtype;
  v_case public.pa_inquiries%rowtype;
begin
  if p_token is null
    or char_length(p_token) < 43
    or char_length(p_token) > 128
    or p_token !~ '^[A-Za-z0-9_-]+$'
  then
    access_state := 'invalid';
    return next;
    return;
  end if;

  select *
  into v_token
  from public.pa_schedule_tokens
  where token_hash = digest(convert_to(p_token, 'UTF8'), 'sha256')
  limit 1;

  if not found or v_token.revoked_at is not null then
    access_state := 'invalid';
    return next;
    return;
  end if;

  if v_token.expires_at <= now() then
    access_state := 'expired';
    return next;
    return;
  end if;

  if v_token.answered_at is not null then
    access_state := 'answered';
    return next;
    return;
  end if;

  select *
  into v_case
  from public.pa_inquiries
  where id = v_token.inquiry_id
    and deleted_at is null;

  if not found then
    access_state := 'invalid';
    return next;
    return;
  end if;

  access_state := 'valid';
  inquiry_number := v_case.inquiry_number;
  public_addressee := v_case.public_addressee;
  event_name := coalesce(v_case.public_event_name, v_case.event_name);
  event_date := coalesce(v_case.public_event_date, v_case.event_date);
  event_time := coalesce(v_case.public_event_time, v_case.event_time);
  venue := coalesce(v_case.public_venue, v_case.venue);
  request_summary := v_case.public_request_summary;
  guidance := v_case.public_guidance;
  conditions := v_case.public_conditions;
  response_deadline := v_token.expires_at;
  return next;
end;
$$;

create or replace function public.submit_pa_schedule_response(
  p_token text,
  p_response jsonb,
  p_submission_key uuid
)
returns table (
  result text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_token public.pa_schedule_tokens%rowtype;
  v_existing public.pa_schedule_responses%rowtype;
  v_response public.pa_schedule_responses%rowtype;
  v_respondent_name text;
  v_organization text;
  v_email text;
  v_phone text;
  v_relationship text;
  v_relationship_other text;
  v_authority text;
  v_decision text;
  v_question_details text;
  v_confirmation_name text;
  v_agreements text[];
  v_required_agreements constant text[] := array[
    'not-secured',
    'adjustment-starts',
    'completion-notice',
    'schedule-fee',
    'cancellation-fee',
    'no-fee-if-unsecured',
    'authorized'
  ];
begin
  if p_submission_key is null
    or p_response is null
    or jsonb_typeof(p_response) <> 'object'
    or octet_length(p_response::text) > 30000
  then
    raise exception 'invalid response';
  end if;

  if p_token is null
    or char_length(p_token) < 43
    or char_length(p_token) > 128
    or p_token !~ '^[A-Za-z0-9_-]+$'
  then
    result := 'invalid';
    return next;
    return;
  end if;

  perform 1
  from public.pa_schedule_tokens t
  join public.pa_inquiries i on i.id = t.inquiry_id
  where t.token_hash = digest(convert_to(p_token, 'UTF8'), 'sha256')
    and i.deleted_at is null;

  if not found then
    result := 'invalid';
    return next;
    return;
  end if;

  select r.*
  into v_existing
  from public.pa_schedule_responses r
  join public.pa_schedule_tokens t on t.id = r.token_id
  where r.submission_key = p_submission_key
    and t.token_hash = digest(convert_to(p_token, 'UTF8'), 'sha256')
  limit 1;

  if found then
    result := 'accepted';
    submitted_at := v_existing.submitted_at;
    return next;
    return;
  end if;

  select t.*
  into v_token
  from public.pa_schedule_tokens t
  join public.pa_inquiries i on i.id = t.inquiry_id
  where t.token_hash = digest(convert_to(p_token, 'UTF8'), 'sha256')
    and i.deleted_at is null
  for update of t;

  if not found or v_token.revoked_at is not null then
    result := 'invalid';
    return next;
    return;
  end if;

  if v_token.expires_at <= now() then
    result := 'expired';
    return next;
    return;
  end if;

  if v_token.answered_at is not null then
    result := 'already_answered';
    return next;
    return;
  end if;

  v_respondent_name := btrim(coalesce(p_response ->> 'respondent_name', ''));
  v_organization := nullif(btrim(coalesce(p_response ->> 'organization', '')), '');
  v_email := btrim(coalesce(p_response ->> 'email', ''));
  v_phone := btrim(coalesce(p_response ->> 'phone', ''));
  v_relationship := btrim(coalesce(p_response ->> 'relationship', ''));
  v_relationship_other := nullif(btrim(coalesce(p_response ->> 'relationship_other', '')), '');
  v_authority := btrim(coalesce(p_response ->> 'authority', ''));
  v_decision := btrim(coalesce(p_response ->> 'decision', ''));
  v_question_details := nullif(btrim(coalesce(p_response ->> 'question_details', '')), '');
  v_confirmation_name := btrim(coalesce(p_response ->> 'confirmation_name', ''));

  begin
    select coalesce(array_agg(value), '{}'::text[])
    into v_agreements
    from jsonb_array_elements_text(coalesce(p_response -> 'agreements', '[]'::jsonb));
  exception
    when others then
      raise exception 'invalid agreements';
  end;

  if char_length(v_respondent_name) not between 1 and 160
    or char_length(v_email) not between 3 and 320
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(v_phone) not between 3 and 60
    or char_length(v_relationship) not between 1 and 80
    or v_authority not in ('yes', 'no', 'unknown')
    or v_decision not in ('agree', 'decline', 'question')
    or char_length(v_confirmation_name) not between 1 and 160
    or lower(regexp_replace(v_confirmation_name, '[ 　]+', '', 'g'))
      <> lower(regexp_replace(v_respondent_name, '[ 　]+', '', 'g'))
    or (v_relationship = 'other' and v_relationship_other is null)
    or (v_decision = 'question' and v_question_details is null)
  then
    raise exception 'invalid response fields';
  end if;

  if v_organization is not null and char_length(v_organization) > 200 then
    raise exception 'invalid organization';
  end if;

  if v_relationship_other is not null and char_length(v_relationship_other) > 200 then
    raise exception 'invalid relationship';
  end if;

  if v_question_details is not null and char_length(v_question_details) > 5000 then
    raise exception 'invalid question';
  end if;

  if v_decision = 'agree' then
    if v_authority <> 'yes' or v_relationship = 'contact-only' then
      raise exception 'consent authority required';
    end if;

    if not v_agreements @> v_required_agreements
      or not v_required_agreements @> v_agreements
    then
      raise exception 'all agreements are required';
    end if;
  end if;

  insert into public.pa_schedule_responses (
    inquiry_id,
    token_id,
    submission_key,
    respondent_name,
    organization,
    email,
    phone,
    relationship,
    relationship_other,
    authority,
    decision,
    agreements,
    question_details,
    confirmation_name,
    response_data
  )
  values (
    v_token.inquiry_id,
    v_token.id,
    p_submission_key,
    v_respondent_name,
    v_organization,
    v_email,
    v_phone,
    v_relationship,
    v_relationship_other,
    v_authority,
    v_decision,
    v_agreements,
    v_question_details,
    v_confirmation_name,
    p_response
  )
  returning * into v_response;

  update public.pa_schedule_tokens
  set answered_at = v_response.submitted_at
  where id = v_token.id;

  update public.pa_inquiries
  set
    status = 'customer_responded',
    schedule_state = 'unconfirmed',
    second_form_answered_at = v_response.submitted_at
  where id = v_token.inquiry_id
    and deleted_at is null;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    action,
    details
  )
  values (
    v_token.inquiry_id,
    'second_form_answered',
    jsonb_build_object('decision', v_decision)
  );

  result := 'accepted';
  submitted_at := v_response.submitted_at;
  return next;
end;
$$;

revoke all on function public.trash_pa_case(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.restore_pa_case(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_pa_case_delete_impact(uuid, uuid) from public, anon, authenticated;
revoke all on function public.purge_pa_case(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.trash_pa_case(uuid, text, uuid) to service_role;
grant execute on function public.restore_pa_case(uuid, uuid) to service_role;
grant execute on function public.get_pa_case_delete_impact(uuid, uuid) to service_role;
grant execute on function public.purge_pa_case(uuid, text, uuid) to service_role;

revoke all on function public.get_pa_schedule_case(text) from public;
revoke all on function public.submit_pa_schedule_response(text, jsonb, uuid) from public;
grant execute on function public.get_pa_schedule_case(text) to anon, authenticated;
grant execute on function public.submit_pa_schedule_response(text, jsonb, uuid) to anon, authenticated;

commit;

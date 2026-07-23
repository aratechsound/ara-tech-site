-- ARA-20260723-004
-- PA問い合わせ案件、第2フォーム用トークン、回答、操作履歴を追加する。
-- 既存のWORKS管理者認証 public.is_work_admin() を前提にし、
-- 既存テーブルは変更しない。

begin;

do $$
begin
  if to_regprocedure('public.is_work_admin()') is null then
    raise exception 'public.is_work_admin() is required before applying ARA-20260723-004';
  end if;
end;
$$;

create extension if not exists pgcrypto with schema extensions;

create sequence if not exists public.pa_inquiry_number_seq;

create or replace function public.next_pa_inquiry_number()
returns text
language sql
volatile
set search_path = pg_catalog, public
as $$
  select
    'PA-'
    || to_char(clock_timestamp() at time zone 'Asia/Tokyo', 'YYYYMMDD')
    || '-'
    || lpad(nextval('public.pa_inquiry_number_seq')::text, 5, '0');
$$;

create table if not exists public.pa_inquiries (
  id uuid primary key default gen_random_uuid(),
  inquiry_number text not null unique default public.next_pa_inquiry_number(),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  submission_source text not null default 'manual'
    check (submission_source in ('manual', 'public_form')),
  status text not null default 'new'
    check (status in (
      'new',
      'reviewing',
      'second_form_not_issued',
      'second_form_issued',
      'customer_responded',
      'schedule_unconfirmed',
      'schedule_confirmed',
      'on_hold',
      'cancelled',
      'closed'
    )),
  schedule_state text not null default 'unconfirmed'
    check (schedule_state in ('unconfirmed', 'completed')),
  customer_name text not null check (char_length(customer_name) between 1 and 160),
  organization_name text check (organization_name is null or char_length(organization_name) <= 200),
  email text not null check (char_length(email) between 3 and 320),
  phone text check (phone is null or char_length(phone) <= 60),
  event_name text check (event_name is null or char_length(event_name) <= 240),
  event_date date,
  event_time text check (event_time is null or char_length(event_time) <= 120),
  venue text check (venue is null or char_length(venue) <= 300),
  request_summary text check (request_summary is null or char_length(request_summary) <= 5000),
  first_form_data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(first_form_data) = 'object'),
  internal_memo text check (internal_memo is null or char_length(internal_memo) <= 10000),
  public_addressee text check (public_addressee is null or char_length(public_addressee) <= 160),
  public_event_name text check (public_event_name is null or char_length(public_event_name) <= 240),
  public_event_date date,
  public_event_time text check (public_event_time is null or char_length(public_event_time) <= 120),
  public_venue text check (public_venue is null or char_length(public_venue) <= 300),
  public_request_summary text check (public_request_summary is null or char_length(public_request_summary) <= 5000),
  public_guidance text check (public_guidance is null or char_length(public_guidance) <= 10000),
  public_conditions text check (public_conditions is null or char_length(public_conditions) <= 10000),
  response_deadline timestamptz,
  second_form_issued_at timestamptz,
  second_form_answered_at timestamptz,
  schedule_confirmed_at timestamptz,
  customer_confirmation_sent_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  check (schedule_state <> 'completed' or customer_confirmation_sent_at is not null)
);

create table if not exists public.pa_schedule_tokens (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.pa_inquiries(id) on delete cascade,
  token_hash bytea not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  answered_at timestamptz,
  issued_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  check (expires_at > issued_at)
);

create unique index if not exists pa_schedule_tokens_one_open_per_case
  on public.pa_schedule_tokens(inquiry_id)
  where revoked_at is null and answered_at is null;

create index if not exists pa_schedule_tokens_inquiry_id_idx
  on public.pa_schedule_tokens(inquiry_id, issued_at desc);

create table if not exists public.pa_schedule_responses (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null unique references public.pa_inquiries(id) on delete cascade,
  token_id uuid not null unique references public.pa_schedule_tokens(id) on delete restrict,
  submission_key uuid not null unique,
  submitted_at timestamptz not null default now(),
  respondent_name text not null check (char_length(respondent_name) between 1 and 160),
  organization text check (organization is null or char_length(organization) <= 200),
  email text not null check (char_length(email) between 3 and 320),
  phone text not null check (char_length(phone) between 3 and 60),
  relationship text not null check (char_length(relationship) between 1 and 80),
  relationship_other text check (relationship_other is null or char_length(relationship_other) <= 200),
  authority text not null check (authority in ('yes', 'no', 'unknown')),
  decision text not null check (decision in ('agree', 'decline', 'question')),
  agreements text[] not null default '{}'::text[],
  question_details text check (question_details is null or char_length(question_details) <= 5000),
  confirmation_name text not null check (char_length(confirmation_name) between 1 and 160),
  terms_version text not null default 'ARA-20260723-002',
  response_data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(response_data) = 'object')
);

create table if not exists public.pa_inquiry_audit (
  id bigint generated always as identity primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) between 1 and 80),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object')
);

create index if not exists pa_inquiries_received_at_idx
  on public.pa_inquiries(received_at desc);

create index if not exists pa_inquiries_event_date_idx
  on public.pa_inquiries(event_date);

create index if not exists pa_inquiries_status_idx
  on public.pa_inquiries(status, updated_at desc);

create index if not exists pa_inquiry_audit_case_idx
  on public.pa_inquiry_audit(inquiry_id, occurred_at desc);

create or replace function public.set_pa_inquiry_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  new.revision := old.revision + 1;
  return new;
end;
$$;

drop trigger if exists pa_inquiries_set_updated_at on public.pa_inquiries;
create trigger pa_inquiries_set_updated_at
before update on public.pa_inquiries
for each row execute function public.set_pa_inquiry_updated_at();

create or replace function public.audit_pa_inquiry_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action text;
  v_details jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'case_created';
    v_details := jsonb_build_object(
      'source', new.submission_source,
      'status', new.status,
      'schedule_state', new.schedule_state
    );
  else
    v_action := 'case_updated';
    v_details := jsonb_build_object(
      'status_before', old.status,
      'status_after', new.status,
      'schedule_before', old.schedule_state,
      'schedule_after', new.schedule_state,
      'public_fields_changed',
        old.public_addressee is distinct from new.public_addressee
        or old.public_event_name is distinct from new.public_event_name
        or old.public_event_date is distinct from new.public_event_date
        or old.public_event_time is distinct from new.public_event_time
        or old.public_venue is distinct from new.public_venue
        or old.public_request_summary is distinct from new.public_request_summary
        or old.public_guidance is distinct from new.public_guidance
        or old.public_conditions is distinct from new.public_conditions,
      'internal_memo_changed', old.internal_memo is distinct from new.internal_memo
    );
  end if;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    actor_user_id,
    action,
    details
  )
  values (
    new.id,
    auth.uid(),
    v_action,
    v_details
  );

  return new;
end;
$$;

drop trigger if exists pa_inquiries_audit_insert on public.pa_inquiries;
create trigger pa_inquiries_audit_insert
after insert on public.pa_inquiries
for each row execute function public.audit_pa_inquiry_change();

drop trigger if exists pa_inquiries_audit_update on public.pa_inquiries;
create trigger pa_inquiries_audit_update
after update on public.pa_inquiries
for each row execute function public.audit_pa_inquiry_change();

alter table public.pa_inquiries enable row level security;
alter table public.pa_schedule_tokens enable row level security;
alter table public.pa_schedule_responses enable row level security;
alter table public.pa_inquiry_audit enable row level security;

drop policy if exists "PA admins manage inquiries" on public.pa_inquiries;
create policy "PA admins manage inquiries"
on public.pa_inquiries for all to authenticated
using (public.is_work_admin())
with check (public.is_work_admin());

drop policy if exists "PA admins read tokens" on public.pa_schedule_tokens;
create policy "PA admins read tokens"
on public.pa_schedule_tokens for select to authenticated
using (public.is_work_admin());

drop policy if exists "PA admins read responses" on public.pa_schedule_responses;
create policy "PA admins read responses"
on public.pa_schedule_responses for select to authenticated
using (public.is_work_admin());

drop policy if exists "PA admins read audit" on public.pa_inquiry_audit;
create policy "PA admins read audit"
on public.pa_inquiry_audit for select to authenticated
using (public.is_work_admin());

revoke all on public.pa_inquiries from anon, authenticated;
revoke all on public.pa_schedule_tokens from anon, authenticated;
revoke all on public.pa_schedule_responses from anon, authenticated;
revoke all on public.pa_inquiry_audit from anon, authenticated;

grant select, insert, update on public.pa_inquiries to authenticated;
grant select on public.pa_schedule_tokens to authenticated;
grant select on public.pa_schedule_responses to authenticated;
grant select on public.pa_inquiry_audit to authenticated;
grant usage, select on sequence public.pa_inquiry_number_seq to authenticated;
grant execute on function public.next_pa_inquiry_number() to authenticated;

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

  perform 1
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    raise exception 'inquiry not found';
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

create or replace function public.revoke_pa_schedule_token(p_inquiry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  if not public.is_work_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.pa_schedule_tokens
  set revoked_at = now()
  where inquiry_id = p_inquiry_id
    and revoked_at is null
    and answered_at is null;

  get diagnostics v_count = row_count;

  if v_count > 0 then
    update public.pa_inquiries
    set
      status = 'second_form_not_issued',
      response_deadline = null
    where id = p_inquiry_id
      and status = 'second_form_issued';

    insert into public.pa_inquiry_audit (
      inquiry_id,
      actor_user_id,
      action
    )
    values (
      p_inquiry_id,
      auth.uid(),
      'second_form_token_revoked'
    );
  end if;

  return v_count > 0;
end;
$$;

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
  where id = v_token.inquiry_id;

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

  select *
  into v_token
  from public.pa_schedule_tokens
  where token_hash = digest(convert_to(p_token, 'UTF8'), 'sha256')
  for update;

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
  where id = v_token.inquiry_id;

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

create or replace function public.confirm_pa_schedule(
  p_inquiry_id uuid,
  p_customer_confirmation_sent boolean
)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_confirmed_at timestamptz := now();
begin
  if not public.is_work_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_customer_confirmation_sent is not true then
    raise exception 'customer confirmation must be sent first';
  end if;

  update public.pa_inquiries
  set
    status = 'schedule_confirmed',
    schedule_state = 'completed',
    schedule_confirmed_at = v_confirmed_at,
    customer_confirmation_sent_at = v_confirmed_at
  where id = p_inquiry_id;

  if not found then
    raise exception 'inquiry not found';
  end if;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    actor_user_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    auth.uid(),
    'schedule_confirmed_after_customer_notice',
    jsonb_build_object('confirmed_at', v_confirmed_at)
  );

  return v_confirmed_at;
end;
$$;

revoke all on function public.issue_pa_schedule_token(uuid, text, timestamptz) from public;
revoke all on function public.revoke_pa_schedule_token(uuid) from public;
revoke all on function public.get_pa_schedule_case(text) from public;
revoke all on function public.submit_pa_schedule_response(text, jsonb, uuid) from public;
revoke all on function public.confirm_pa_schedule(uuid, boolean) from public;

grant execute on function public.issue_pa_schedule_token(uuid, text, timestamptz) to authenticated;
grant execute on function public.revoke_pa_schedule_token(uuid) to authenticated;
grant execute on function public.get_pa_schedule_case(text) to anon, authenticated;
grant execute on function public.submit_pa_schedule_response(text, jsonb, uuid) to anon, authenticated;
grant execute on function public.confirm_pa_schedule(uuid, boolean) to authenticated;

commit;

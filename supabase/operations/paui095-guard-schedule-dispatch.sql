-- Apply after paui095-guard-schedule-token.sql, before releasing the paired application.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

select 'public.pa_manage_schedule_token_v2(uuid,timestamptz,uuid,text,text,timestamptz)'::regprocedure;

create function public.pa_schedule_invitation_hash(p_body text)
returns bytea
language sql immutable strict
set search_path = pg_catalog
as $fn$
  select case when count(distinct found[1])=1
    then sha256(convert_to(min(found[1]),'UTF8')) end
  from regexp_matches(p_body,
    $pattern$https://ara-tech\.cc/pa-schedule-confirm\.html\?token=([A-Za-z0-9_-]{43,128})(?:[[:space:]<>"']|$)$pattern$, 'g') as r(found)
$fn$;

-- A delivery from the old application may still be in flight.
lock table public.pa_email_deliveries, public.pa_schedule_tokens in share row exclusive mode;
do $gate$
begin
  if exists(select from public.pa_email_deliveries where message_type='schedule_request' and status='sending') then
    raise exception 'schedule_delivery_busy';
  end if;
  if exists(select from public.pa_email_deliveries d where d.message_type='schedule_request'
      and not exists(select from public.pa_schedule_tokens t
        where t.inquiry_id=d.inquiry_id and t.token_hash=public.pa_schedule_invitation_hash(d.body))) then
    raise exception 'schedule_delivery_history_unmatched';
  end if;
end
$gate$;

create function public.pa_guard_schedule_invitation_insert()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_case public.pa_inquiries%rowtype;
  v_token bytea;
  v_version public.pa_email_deliveries%rowtype;
begin
  select * into v_case from public.pa_inquiries
    where id=new.inquiry_id and deleted_at is null for no key update nowait;
  if not found or lower(btrim(v_case.email)) is distinct from lower(btrim(new.recipient)) then
    raise exception 'schedule_token_not_available';
  end if;

  v_token := public.pa_schedule_invitation_hash(new.body);
  if v_token is null or new.status <> 'sending' then
    raise exception 'schedule_token_not_available';
  end if;

  -- PostgREST insert uses ON CONFLICT DO NOTHING for exact operation replays.
  select * into v_version from public.pa_email_deliveries
    where dedupe_key=new.dedupe_key and attempt_number=new.attempt_number;
  if found then
    if v_version.inquiry_id=new.inquiry_id and v_version.message_type='schedule_request'
        and v_version.recipient=new.recipient and v_version.subject=new.subject and v_version.body=new.body then
      return new;
    end if;
    raise exception 'schedule_delivery_exists';
  end if;

  if v_case.status in ('on_hold','closed','cancelled','declined','schedule_unavailable')
    or exists(select from public.pa_case_progress where inquiry_id=new.inquiry_id
      and (is_on_hold or closed_at is not null)) then
    raise exception 'schedule_token_not_available';
  end if;
  perform 1 from public.pa_schedule_tokens
    where inquiry_id=new.inquiry_id and token_hash=v_token and revoked_at is null
      and answered_at is null and expires_at>clock_timestamp()
    for no key update nowait;
  if not found then raise exception 'schedule_token_not_available'; end if;

  select * into v_version from public.pa_email_deliveries
    where inquiry_id=new.inquiry_id and message_type='schedule_request'
      and public.pa_schedule_invitation_hash(body)=v_token
    order by requested_at desc, attempt_number desc, id desc limit 1;
  if not found then
    if new.is_retry then raise exception 'retry_not_allowed'; end if;
    return new;
  end if;

  if not new.is_retry then raise exception 'schedule_delivery_exists'; end if;
  if new.retry_of is distinct from v_version.id or new.dedupe_key<>v_version.dedupe_key
      or new.attempt_number<>v_version.attempt_number+1 or v_version.status<>'failed'
      or v_version.recipient<>new.recipient or v_version.subject<>new.subject or v_version.body<>new.body
      or coalesce(v_version.error_summary,'') !~ '^(gmail_not_configured|gmail_oauth_([0-9]{3}|invalid)|mail_before_dispatch_failed|gmail_send_(400|401|403|404|413|422|429))$'
      or exists(select from public.pa_email_deliveries where inquiry_id=new.inquiry_id
        and message_type='schedule_request' and status in ('sending','sent','unknown')
        and public.pa_schedule_invitation_hash(body)=v_token) then
    raise exception 'retry_not_allowed';
  end if;
  return new;
exception when lock_not_available then
  raise exception 'schedule_delivery_busy';
end
$fn$;

create function public.pa_guard_schedule_revocation_during_delivery()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $fn$
begin
  perform 1 from public.pa_inquiries where id=old.inquiry_id for no key update nowait;
  if exists (select from public.pa_email_deliveries
      where inquiry_id=old.inquiry_id and message_type='schedule_request' and status='sending'
      and public.pa_schedule_invitation_hash(body)=old.token_hash) then
    raise exception 'schedule_delivery_busy' using errcode='55P03';
  end if;
  return new;
end
$fn$;

create function public.pa_claim_schedule_invitation(p_delivery jsonb)
returns setof public.pa_email_deliveries
language sql
set search_path = pg_catalog, public
as $fn$
  insert into public.pa_email_deliveries
    (inquiry_id,message_type,dedupe_key,attempt_number,is_retry,retry_of,recipient,subject,body,status,requested_at,created_by)
    select inquiry_id,'schedule_request',dedupe_key,attempt_number,is_retry,retry_of,
      recipient,subject,body,'sending',clock_timestamp(),created_by
    from jsonb_populate_record(null::public.pa_email_deliveries,p_delivery)
  on conflict(dedupe_key,attempt_number) do nothing returning *
$fn$;
revoke all on function public.pa_claim_schedule_invitation(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.pa_claim_schedule_invitation(jsonb) to service_role;

revoke all on function public.pa_schedule_invitation_hash(text),
  public.pa_guard_schedule_invitation_insert(), public.pa_guard_schedule_revocation_during_delivery()
  from public,anon,authenticated,service_role;

create trigger pa_schedule_invitation_insert_guard
before insert on public.pa_email_deliveries
for each row when (new.message_type='schedule_request')
execute function public.pa_guard_schedule_invitation_insert();

create trigger pa_schedule_invitation_revocation_guard
before update of revoked_at on public.pa_schedule_tokens
for each row when (old.revoked_at is null and new.revoked_at is not null)
execute function public.pa_guard_schedule_revocation_during_delivery();

commit;

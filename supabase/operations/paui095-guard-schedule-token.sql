-- Owner-approved schedule token concurrency gate.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $guard$
begin
  if exists (
    select 1 from pg_proc p
    join (values
      ('public.issue_pa_schedule_token(uuid,text,timestamptz)'::regprocedure,'7039ceba390cac068193355b619fcab647697daec64e9819dc497d643bf2fa76'),
      ('public.revoke_pa_schedule_token(uuid)'::regprocedure,'9289838a966f7fd0b17bf41a3d2feae72e831d7a090c54e8ca73afa722277380')
    ) as expected(id, body_hash) on expected.id=p.oid
    where encode(sha256(convert_to(replace(p.prosrc,chr(13),''),'UTF8')),'hex')<>expected.body_hash
       or pg_get_userbyid(p.proowner)<>'postgres'
       or (select array_agg(entry::text order by entry::text collate "C") from unnest(p.proacl) entry)
          is distinct from array['anon=X/postgres','authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']
  ) then
    raise exception 'PAUI-095 schedule baseline mismatch';
  end if;
end
$guard$;

create function public.pa_manage_schedule_token_v2(
  p_inquiry_id uuid, p_expected_updated_at timestamptz, p_expected_token_id uuid,
  p_action text, p_token text default null, p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_case public.pa_inquiries%rowtype;
  v_progress public.pa_case_progress%rowtype;
  v_open uuid;
  v_issued record;
begin
  if auth.uid() is null or not public.is_work_admin() then
    raise exception 'not authorized' using errcode='42501';
  end if;
  select * into v_case from public.pa_inquiries
    where id=p_inquiry_id and deleted_at is null for update nowait;
  if not found or v_case.status in ('on_hold','closed','cancelled','declined','schedule_unavailable') then
    return jsonb_build_object('state','unavailable');
  end if;
  select * into v_progress from public.pa_case_progress
    where inquiry_id=p_inquiry_id for update nowait;
  if not found or v_progress.is_on_hold or v_progress.closed_at is not null then
    return jsonb_build_object('state','unavailable');
  end if;
  -- The existing public submission takes the token lock first. NOWAIT avoids
  -- deadlocking with a customer response that is about to update the case.
  select id into v_open from public.pa_schedule_tokens
    where inquiry_id=p_inquiry_id and revoked_at is null and answered_at is null
    for update nowait;
  if p_expected_updated_at is null or v_case.updated_at is distinct from p_expected_updated_at
      or v_open is distinct from p_expected_token_id then
    return jsonb_build_object('state','stale');
  end if;

  if p_action='issue' then
    if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43,128}$' or p_expires_at is null
      or p_expires_at<=now() or p_expires_at>now()+interval '180 days'
      or v_case.status not in ('schedule_coordination','second_form_not_issued','second_form_issued',
        'schedule_unconfirmed','customer_responded','schedule_adjusting','needs_confirmation')
      or coalesce(nullif(btrim(v_case.public_event_name), ''), nullif(btrim(v_case.event_name), '')) is null
      or coalesce(v_case.public_event_date,v_case.event_date) is null
      or coalesce(nullif(btrim(v_case.public_venue), ''), nullif(btrim(v_case.venue), '')) is null
      or nullif(btrim(v_case.public_conditions), '') is null then
      return jsonb_build_object('state','unavailable');
    end if;
    select * into v_issued from public.issue_pa_schedule_token(p_inquiry_id,p_token,p_expires_at);
    return jsonb_build_object('state','issued','token_id',v_issued.token_id,
      'issued_at',v_issued.issued_at,'expires_at',v_issued.expires_at,
      'updated_at',(select updated_at from public.pa_inquiries where id=p_inquiry_id),
      'case_status',(select status from public.pa_inquiries where id=p_inquiry_id));
  elsif p_action='revoke' and p_token is null and p_expires_at is null and v_open is not null then
    if not public.revoke_pa_schedule_token(p_inquiry_id) then
      return jsonb_build_object('state','stale');
    end if;
    return jsonb_build_object('state','revoked',
      'revoked_at',(select revoked_at from public.pa_schedule_tokens where id=v_open),
      'updated_at',(select updated_at from public.pa_inquiries where id=p_inquiry_id),
      'case_status',(select status from public.pa_inquiries where id=p_inquiry_id));
  end if;
  return jsonb_build_object('state','unavailable');
exception when lock_not_available then
  return jsonb_build_object('state','busy');
end
$fn$;

revoke all on function public.pa_manage_schedule_token_v2(uuid,timestamptz,uuid,text,text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.pa_manage_schedule_token_v2(uuid,timestamptz,uuid,text,text,timestamptz)
  to authenticated;
revoke execute on function public.issue_pa_schedule_token(uuid,text,timestamptz),public.revoke_pa_schedule_token(uuid)
  from public,anon,authenticated;
commit;

-- LOCAL candidate only. Organizer authority is the existing session -> access link -> portal binding.
-- No work_admin claim, admin JWT, arbitrary-event authority or new tables.
begin;
create function public.pa_portal_organizer_staff_manage_link(
 p_session_hash text,p_grade text,p_action text,p_case_id uuid default null,p_portal_ref text default null,
 p_token_hash text default null,p_plain_token text default null,p_expected_link_id uuid default null,p_expected_token_hash text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.pa_portal_sessions%rowtype;a public.pa_portal_access_links%rowtype;
 p public.pa_portals%rowtype;i public.pa_inquiries%rowtype;l public.pa_portal_staff_links%rowtype;
 e public.pa_portal_staff_event_settings%rowtype;bound_portal uuid;expiry timestamptz;tz text;new_id uuid;
begin
 if p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false);end if;
 -- Match existing organizer mutation lock order: portal, access link, session.
 select x.portal_id into bound_portal from public.pa_portal_sessions y join public.pa_portal_access_links x on x.id=y.access_link_id where y.session_hash=p_session_hash;
 if bound_portal is null then return jsonb_build_object('ok',false);end if;
 select * into p from public.pa_portals where id=bound_portal for update;
 select x.* into a from public.pa_portal_access_links x join public.pa_portal_sessions y on y.access_link_id=x.id where y.session_hash=p_session_hash for update of x;
 select * into s from public.pa_portal_sessions where session_hash=p_session_hash for update;
 if p.id is null or s.id is null or a.id is null or a.portal_id<>p.id or s.access_link_id<>a.id
  or a.role is distinct from 'organizer' or s.revoked_at is not null or s.expires_at<=now()
  or a.revoked_at is not null or (a.expires_at is not null and a.expires_at<=now()) then return jsonb_build_object('ok',false);end if;
 select * into i from public.pa_inquiries where id=p.case_id and deleted_at is null;
 if i.id is null or to_jsonb(i)->>'case_type' is distinct from 'PA_EVENT' or to_jsonb(i)->>'status'='closed' then return jsonb_build_object('ok',false);end if;
 if (p_case_id is not null and p_case_id<>p.case_id) or (p_portal_ref is not null and p_portal_ref<>p.public_ref)
  then return public.pa_portal_organizer_failure(p.id,a.id,s.id,'staff_link_'||coalesce(p_action,''),'not_permitted');end if;
 if p_grade is null or p_grade not in ('GENERAL','TECHNICAL') or p_action is null or p_action not in ('status','stored_token','create','rotate','revoke') then raise exception 'invalid_staff_action';end if;
 if (p_expected_link_id is null) <> (p_expected_token_hash is null) then raise exception 'invalid_staff_action';end if;
 if p_action not in ('create','rotate') and (p_plain_token is not null or p_token_hash is not null) then raise exception 'invalid_staff_action';end if;
 select * into e from public.pa_portal_staff_event_settings where portal_id=p.id;
 tz=coalesce(e.timezone,'Asia/Tokyo');
 if e.event_end_at is not null then expiry=e.event_end_at+interval '24 hours';
 elsif i.event_date is not null then expiry=(i.event_date+1+time '23:59') at time zone tz;end if;
 select * into l from public.pa_portal_staff_links where portal_id=p.id and grade=p_grade and revoked_at is null for update;
 if p_action='status' then return jsonb_build_object('ok',true,'case_id',p.case_id,'exists',l.id is not null,'revoked',exists(select 1 from public.pa_portal_staff_links x where x.portal_id=p.id and x.grade=p_grade and x.revoked_at is not null),'active',coalesce(l.expires_at>now(),false),'grade',p_grade,'expires_at',l.expires_at,'default_expires_at',expiry,'timezone',tz);end if;
 if p_action='stored_token' then
  if l.id is null or l.expires_at<=now() or (p_expected_link_id is not null and (l.id<>p_expected_link_id or l.token_hash<>p_expected_token_hash)) then return jsonb_build_object('ok',false);end if;
  return jsonb_build_object('ok',true,'link_id',l.id,'case_id',p.case_id,'grade',l.grade,'token_hash',l.token_hash,'token_plaintext',l.token_plaintext);
 end if;
 if p_action='revoke' then
  update public.pa_portal_staff_links set revoked_at=now() where id=l.id;
  update public.pa_portal_staff_sessions set revoked_at=now() where link_id=l.id and revoked_at is null;
 else
  if expiry is null or expiry<=now() or expiry>now()+interval '366 days' then raise exception 'invalid_expiry';end if;
  if p_action='create' and l.id is not null then raise exception 'active_link_exists';end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token';end if;
  if p_plain_token is null or p_plain_token !~ '^[a-f0-9]{64}$'
   or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_plain_token,'UTF8')),'hex')<>p_token_hash then raise exception 'invalid_token';end if;
  new_id=gen_random_uuid();
  if l.id is not null then
   update public.pa_portal_staff_links set revoked_at=now() where id=l.id;
   update public.pa_portal_staff_sessions set revoked_at=now() where link_id=l.id and revoked_at is null;
  end if;
  -- created_by retains the originating organizer-link issuer FK; it grants no authority.
  -- Actual organizer actor/session is recorded in the existing collaboration audit below.
  insert into public.pa_portal_staff_links(id,portal_id,grade,token_hash,expires_at,created_by,rotated_from,token_plaintext)
  values(new_id,p.id,p_grade,p_token_hash,expiry,a.created_by,l.id,p_plain_token);
 end if;
 insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,access_link_id,session_id,success,detail)
 values(p.id,'staff_link_'||p_action,'organizer',a.id,s.id,true,jsonb_build_object('grade',p_grade,'staff_link_id',coalesce(new_id,l.id)));
 return jsonb_build_object('ok',true,'active',p_action<>'revoke','grade',p_grade,'expires_at',case when p_action='revoke' then null else expiry end,'timezone',tz);
end $$;
revoke all on function public.pa_portal_organizer_staff_manage_link(text,text,text,uuid,text,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.pa_portal_organizer_staff_manage_link(text,text,text,uuid,text,text,text,uuid,text) to service_role;
commit;

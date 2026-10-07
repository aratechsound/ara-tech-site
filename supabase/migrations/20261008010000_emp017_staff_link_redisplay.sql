-- EMP-017 local variant. Owner accepted plaintext bearer-token storage risk.
-- Hash remains the authentication authority. No existing links are rewritten.
begin;
alter table public.pa_portal_staff_links add column token_plaintext text,
 add constraint pa_staff_plain_token_shape check(token_plaintext is null or
  (token_plaintext ~ '^[a-f0-9]{64}$' and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(token_plaintext,'UTF8')),'hex')=token_hash));

create function public.pa_portal_staff_manage_link_v2(p_case_id uuid,p_grade text,p_action text,p_token_hash text default null,p_expires_at timestamptz default null,p_timezone text default null,p_event_end_at timestamptz default null,p_plain_token text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized';end if;
 if exists(select 1 from public.pa_inquiries i where i.id=p_case_id and to_jsonb(i)->>'status'='closed') then raise exception 'portal_not_found';end if;
 if p_action in ('create','rotate') then
  if p_plain_token is null or p_plain_token !~ '^[a-f0-9]{64}$' or p_token_hash is null
   or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_plain_token,'UTF8')),'hex')<>p_token_hash then raise exception 'invalid_token';end if;
 elsif p_plain_token is not null then raise exception 'invalid_staff_action';end if;
 result=public.pa_portal_staff_manage_link(p_case_id,p_grade,p_action,p_token_hash,p_expires_at,p_timezone,p_event_end_at);
 if p_action in ('create','rotate') then
  update public.pa_portal_staff_links l set token_plaintext=p_plain_token
  where l.token_hash=p_token_hash and l.grade=p_grade and l.revoked_at is null
   and l.portal_id=(select p.id from public.pa_portals p where p.case_id=p_case_id);
  if not found then raise exception 'link_unavailable';end if;
 end if;
 if p_action='status' then result=result||jsonb_build_object('revoked',exists(select 1 from public.pa_portal_staff_links l join public.pa_portals p on p.id=l.portal_id where p.case_id=p_case_id and l.grade=p_grade and l.revoked_at is not null));end if;
 return result;
end $$;

create function public.pa_portal_staff_link_token(p_case_id uuid,p_grade text,p_expected_link_id uuid default null,p_expected_token_hash text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.pa_portal_staff_links%rowtype;
begin
 if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized';end if;
 if p_grade is null or p_grade not in ('GENERAL','TECHNICAL') or ((p_expected_link_id is null) <> (p_expected_token_hash is null)) then raise exception 'invalid_staff_action';end if;
 select a.* into l from public.pa_portal_staff_links a
 join public.pa_portals p on p.id=a.portal_id join public.pa_inquiries i on i.id=p.case_id
 where p.case_id=p_case_id and a.grade=p_grade and a.revoked_at is null and a.expires_at>now()
 and i.deleted_at is null and to_jsonb(i)->>'case_type'='PA_EVENT' and coalesce(to_jsonb(i)->>'status','')<>'closed'
 and (p_expected_link_id is null or (a.id=p_expected_link_id and a.token_hash=p_expected_token_hash)) for update of a;
 if l.id is null then return jsonb_build_object('ok',false);end if;
 return jsonb_build_object('ok',true,'link_id',l.id,'case_id',p_case_id,'grade',l.grade,'token_hash',l.token_hash,'token_plaintext',l.token_plaintext);
end $$;

-- All new issuance must pass the token/hash validation wrapper.
revoke all on function public.pa_portal_staff_manage_link(uuid,text,text,text,timestamptz,text,timestamptz) from authenticated;
revoke all on function public.pa_portal_staff_manage_link_v2(uuid,text,text,text,timestamptz,text,timestamptz,text),public.pa_portal_staff_link_token(uuid,text,uuid,text) from public,anon;
grant execute on function public.pa_portal_staff_manage_link_v2(uuid,text,text,text,timestamptz,text,timestamptz,text),public.pa_portal_staff_link_token(uuid,text,uuid,text) to authenticated;

-- Direct CASE close dependency: future closure revokes staff links and sessions.
create function public.pa_portal_staff_case_closed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if to_jsonb(new)->>'status'='closed' and to_jsonb(old)->>'status' is distinct from 'closed' then
  update public.pa_portal_staff_links l set revoked_at=now() from public.pa_portals p
   where p.case_id=new.id and l.portal_id=p.id and l.revoked_at is null;
  update public.pa_portal_staff_sessions s set revoked_at=now() from public.pa_portal_staff_links l,public.pa_portals p
   where p.case_id=new.id and l.portal_id=p.id and s.link_id=l.id and s.revoked_at is null;
 end if;
 return new;
end $$;
revoke all on function public.pa_portal_staff_case_closed() from public,anon,authenticated;
create trigger pa_portal_staff_case_closed after update on public.pa_inquiries for each row execute function public.pa_portal_staff_case_closed();
-- Already-closed cases also fail exchange/context without rewriting existing rows.
create or replace function public.pa_portal_staff_exchange(p_token_hash text,p_session_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.pa_portal_staff_links%rowtype;e timestamptz;
begin
 if p_token_hash is null or p_session_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_session_hash !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false);end if;
 select a.* into l from public.pa_portal_staff_links a join public.pa_portals p on p.id=a.portal_id join public.pa_inquiries i on i.id=p.case_id
 where a.token_hash=p_token_hash and a.revoked_at is null and a.expires_at>now() and i.deleted_at is null and to_jsonb(i)->>'case_type'='PA_EVENT' and coalesce(to_jsonb(i)->>'status','')<>'closed' for update of a;
 if l.id is null then return jsonb_build_object('ok',false);end if;
 e=least(now()+interval '12 hours',l.expires_at);
 insert into public.pa_portal_staff_sessions(link_id,session_hash,expires_at) values(l.id,p_session_hash,e);
 return jsonb_build_object('ok',true,'expires_at',e);
end $$;

create or replace function public.pa_portal_staff_context(p_session_hash text)
returns table(portal_id uuid,case_id uuid,grade text,timezone text) language sql stable security definer set search_path='' as $$
 select p.id,p.case_id,l.grade,coalesce(e.timezone,'Asia/Tokyo') from public.pa_portal_staff_sessions s
 join public.pa_portal_staff_links l on l.id=s.link_id join public.pa_portals p on p.id=l.portal_id
 join public.pa_inquiries i on i.id=p.case_id left join public.pa_portal_staff_event_settings e on e.portal_id=p.id
 where s.session_hash=p_session_hash and s.revoked_at is null and s.expires_at>now() and l.revoked_at is null and l.expires_at>now()
 and i.deleted_at is null and to_jsonb(i)->>'case_type'='PA_EVENT' and coalesce(to_jsonb(i)->>'status','')<>'closed'
$$;


commit;

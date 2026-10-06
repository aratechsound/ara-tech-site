-- Candidate only: ciphertext is bound to the unique link identity, event, grade and hash.
begin;
alter table public.pa_portal_staff_links
 add column token_key_id text,
 add column token_encryption_version smallint,
 add column token_iv text,
 add column token_ciphertext text,
 add constraint pa_staff_envelope_shape check (
  (token_key_id is null and token_encryption_version is null and token_iv is null and token_ciphertext is null)
  or (token_key_id is not null and token_key_id ~ '^[A-Za-z0-9_-]{1,32}$' and token_encryption_version is not null and token_encryption_version=1
   and token_iv is not null and token_iv ~ '^[a-f0-9]{24}$'
   and token_ciphertext is not null and token_ciphertext ~ '^[A-Za-z0-9+/]{107}=$')
 );

create function public.pa_portal_staff_manage_link_v2(p_case_id uuid,p_grade text,p_action text,p_token_hash text default null,p_expires_at timestamptz default null,p_timezone text default null,p_event_end_at timestamptz default null,p_envelope jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;link_id uuid;
begin
 if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized';end if;
 if p_action in ('create','rotate') then
  if p_envelope is null or jsonb_typeof(p_envelope)<>'object'
   or p_envelope - array['link_id','key_id','version','iv','ciphertext'] <> '{}'::jsonb
   or p_envelope->>'link_id' is null or p_envelope->>'key_id' is null
   or p_envelope->>'key_id' !~ '^[A-Za-z0-9_-]{1,32}$'
   or p_envelope->>'version' is distinct from '1'
   or p_envelope->>'iv' is null or p_envelope->>'iv' !~ '^[a-f0-9]{24}$'
   or p_envelope->>'ciphertext' is null or p_envelope->>'ciphertext' !~ '^[A-Za-z0-9+/]{107}=$'
   then raise exception 'invalid_staff_envelope';end if;
  link_id=(p_envelope->>'link_id')::uuid;
 elsif p_envelope is not null then raise exception 'invalid_staff_envelope';end if;
 -- Existing management owns locking, authorization, expiry and grade-specific rotation.
 result=public.pa_portal_staff_manage_link(p_case_id,p_grade,p_action,p_token_hash,p_expires_at,p_timezone,p_event_end_at);
 if p_action in ('create','rotate') then
  -- The just-inserted row is uncommitted, so it has no externally visible child sessions.
  -- Replace only that new row's generated ID with the server-selected authenticated ID.
  update public.pa_portal_staff_links l set id=link_id,token_key_id=p_envelope->>'key_id',token_encryption_version=1,
   token_iv=p_envelope->>'iv',token_ciphertext=p_envelope->>'ciphertext'
  where l.token_hash=p_token_hash and l.grade=p_grade and l.revoked_at is null
   and l.portal_id=(select p.id from public.pa_portals p where p.case_id=p_case_id);
  if not found then raise exception 'link_unavailable';end if;
 end if;
 return result;
end $$;

create function public.pa_portal_staff_link_envelope(p_case_id uuid,p_grade text,p_expected_link_id uuid default null,p_expected_token_hash text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.pa_portal_staff_links%rowtype;
begin
 if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized';end if;
 if p_grade is null or p_grade not in ('GENERAL','TECHNICAL') or ((p_expected_link_id is null) <> (p_expected_token_hash is null)) then raise exception 'invalid_staff_action';end if;
 select a.* into l from public.pa_portal_staff_links a
 join public.pa_portals p on p.id=a.portal_id join public.pa_inquiries i on i.id=p.case_id
 where p.case_id=p_case_id and a.grade=p_grade and a.revoked_at is null and a.expires_at>now()
 and i.deleted_at is null and to_jsonb(i)->>'case_type'='PA_EVENT'
 and (p_expected_link_id is null or (a.id=p_expected_link_id and a.token_hash=p_expected_token_hash)) for update of a;
 if l.id is null then return jsonb_build_object('ok',false);end if;
 return jsonb_build_object('ok',true,'link_id',l.id,'case_id',p_case_id,'grade',l.grade,'token_hash',l.token_hash,
  'key_id',l.token_key_id,'version',l.token_encryption_version,'iv',l.token_iv,'ciphertext',l.token_ciphertext);
end $$;

-- No direct legacy creation of hash-only links through an authenticated RPC.
revoke all on function public.pa_portal_staff_manage_link(uuid,text,text,text,timestamptz,text,timestamptz) from authenticated;
revoke all on function public.pa_portal_staff_manage_link_v2(uuid,text,text,text,timestamptz,text,timestamptz,jsonb),public.pa_portal_staff_link_envelope(uuid,text,uuid,text) from public,anon;
grant execute on function public.pa_portal_staff_manage_link_v2(uuid,text,text,text,timestamptz,text,timestamptz,jsonb),public.pa_portal_staff_link_envelope(uuid,text,uuid,text) to authenticated;
commit;

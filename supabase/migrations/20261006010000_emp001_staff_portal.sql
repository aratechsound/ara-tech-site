-- EMP-001 candidate only. Canonical categories are the section authority.
-- Shared source contents are the organizer/ARA-TECH operational responsibility.
begin;

create table public.pa_portal_staff_event_settings (
  portal_id uuid primary key references public.pa_portals(id) on delete restrict,
  timezone text not null default 'Asia/Tokyo',
  event_end_at timestamptz,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);
create table public.pa_portal_staff_links (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  grade text not null check(grade in ('GENERAL','TECHNICAL')),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  rotated_from uuid references public.pa_portal_staff_links(id),
  check(expires_at>created_at)
);
create unique index pa_portal_staff_one_active_grade on public.pa_portal_staff_links(portal_id,grade) where revoked_at is null;
create table public.pa_portal_staff_sessions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.pa_portal_staff_links(id) on delete restrict,
  session_hash text not null unique check(session_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check(expires_at>created_at)
);
alter table public.pa_portal_staff_event_settings enable row level security;
alter table public.pa_portal_staff_links enable row level security;
alter table public.pa_portal_staff_sessions enable row level security;
revoke all on public.pa_portal_staff_event_settings,public.pa_portal_staff_links,public.pa_portal_staff_sessions from public,anon,authenticated;

-- The sole role-to-section policy; list and asset resolution both call it.
create function public.pa_portal_staff_section(p_grade text,p_category text)
returns text language sql immutable set search_path='' as $$
 select case
 when p_grade is null or p_grade not in ('GENERAL','TECHNICAL') then null
 when p_category in ('timetable','script','layout','other','photos') then 'common'
 when p_category='performer' and p_grade='TECHNICAL' then 'performer'
 else null end
$$;

create function public.pa_portal_staff_manage_link(p_case_id uuid,p_grade text,p_action text,p_token_hash text default null,p_expires_at timestamptz default null,p_timezone text default null,p_event_end_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.pa_portals%rowtype;i public.pa_inquiries%rowtype;l public.pa_portal_staff_links%rowtype;s public.pa_portal_staff_event_settings%rowtype;expiry timestamptz;tz text;
begin
 if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized';end if;
 if p_grade is null or p_grade not in ('GENERAL','TECHNICAL') or p_action is null or p_action not in ('status','create','rotate','revoke','expiry','settings') then raise exception 'invalid_staff_action';end if;
 select * into p from public.pa_portals where case_id=p_case_id for update;
 select * into i from public.pa_inquiries where id=p_case_id and deleted_at is null;
 if p.id is null or i.id is null or (to_jsonb(i)->>'case_type') is distinct from 'PA_EVENT' then raise exception 'portal_not_found';end if;
 select * into s from public.pa_portal_staff_event_settings where portal_id=p.id;
 tz=coalesce(s.timezone,'Asia/Tokyo');
 if p_action='settings' then
  if p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'invalid_timezone';end if;
  insert into public.pa_portal_staff_event_settings(portal_id,timezone,event_end_at,updated_by) values(p.id,p_timezone,p_event_end_at,auth.uid())
  on conflict(portal_id) do update set timezone=excluded.timezone,event_end_at=excluded.event_end_at,updated_by=excluded.updated_by,updated_at=now();
  return jsonb_build_object('timezone',p_timezone,'event_end_at',p_event_end_at);
 end if;
 if s.event_end_at is not null then expiry=s.event_end_at+interval '24 hours';
 elsif i.event_date is not null then expiry=(i.event_date+1+time '23:59') at time zone tz;
 else expiry=null;end if;
 select * into l from public.pa_portal_staff_links where portal_id=p.id and grade=p_grade and revoked_at is null for update;
 if p_action='status' then return jsonb_build_object('exists',l.id is not null,'active',coalesce(l.expires_at>now(),false),'grade',p_grade,'expires_at',l.expires_at,'default_expires_at',expiry,'timezone',tz,'event_end_at',s.event_end_at,'qr_redisplay',false);end if;
 if p_action='revoke' then
  update public.pa_portal_staff_links set revoked_at=now() where id=l.id;
  update public.pa_portal_staff_sessions set revoked_at=now() where link_id=l.id and revoked_at is null;
  return jsonb_build_object('active',false);
 end if;
 expiry=coalesce(p_expires_at,expiry);
 if expiry is null or expiry<=now() or expiry>now()+interval '366 days' then raise exception 'invalid_expiry';end if;
 if p_action='expiry' then
  if l.id is null then raise exception 'link_unavailable';end if;
  update public.pa_portal_staff_links set expires_at=expiry where id=l.id;
  update public.pa_portal_staff_sessions set expires_at=least(expires_at,expiry) where link_id=l.id and revoked_at is null;
  return jsonb_build_object('active',true,'expires_at',expiry);
 end if;
 if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token';end if;
 if p_action='create' and l.id is not null then raise exception 'active_link_exists';end if;
 if l.id is not null then
  update public.pa_portal_staff_links set revoked_at=now() where id=l.id;
  update public.pa_portal_staff_sessions set revoked_at=now() where link_id=l.id and revoked_at is null;
 end if;
 insert into public.pa_portal_staff_links(portal_id,grade,token_hash,expires_at,created_by,rotated_from) values(p.id,p_grade,p_token_hash,expiry,auth.uid(),l.id);
 return jsonb_build_object('active',true,'grade',p_grade,'expires_at',expiry,'timezone',tz,'qr_redisplay',false);
end $$;

create function public.pa_portal_staff_exchange(p_token_hash text,p_session_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.pa_portal_staff_links%rowtype;e timestamptz;
begin
 if p_token_hash is null or p_session_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_session_hash !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false);end if;
 select a.* into l from public.pa_portal_staff_links a join public.pa_portals p on p.id=a.portal_id join public.pa_inquiries i on i.id=p.case_id
 where a.token_hash=p_token_hash and a.revoked_at is null and a.expires_at>now() and i.deleted_at is null and to_jsonb(i)->>'case_type'='PA_EVENT' for update of a;
 if l.id is null then return jsonb_build_object('ok',false);end if;
 e=least(now()+interval '12 hours',l.expires_at);
 insert into public.pa_portal_staff_sessions(link_id,session_hash,expires_at) values(l.id,p_session_hash,e);
 return jsonb_build_object('ok',true,'expires_at',e);
end $$;

create function public.pa_portal_staff_context(p_session_hash text)
returns table(portal_id uuid,case_id uuid,grade text,timezone text) language sql stable security definer set search_path='' as $$
 select p.id,p.case_id,l.grade,coalesce(e.timezone,'Asia/Tokyo') from public.pa_portal_staff_sessions s
 join public.pa_portal_staff_links l on l.id=s.link_id join public.pa_portals p on p.id=l.portal_id
 join public.pa_inquiries i on i.id=p.case_id left join public.pa_portal_staff_event_settings e on e.portal_id=p.id
 where s.session_hash=p_session_hash and s.revoked_at is null and s.expires_at>now() and l.revoked_at is null and l.expires_at>now()
 and i.deleted_at is null and to_jsonb(i)->>'case_type'='PA_EVENT'
$$;

create function public.pa_portal_staff_read(p_session_hash text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ctx record;i public.pa_inquiries%rowtype;docs jsonb;
begin
 select * into ctx from public.pa_portal_staff_context(p_session_hash);
 if not found then return jsonb_build_object('ok',false);end if;
 select * into i from public.pa_inquiries where id=ctx.case_id;
 select coalesce(jsonb_agg(d.payload order by d.sort_order,d.created_at),'[]'::jsonb) into docs from (
  select c.sort_order,c.created_at,jsonb_build_object('section',public.pa_portal_staff_section(ctx.grade,c.category),'ref',v.public_ref,'kind','version','title',c.title,'filename',v.display_filename,'mime_type',v.mime_type,'version_label',v.version_label,'updated_at',v.created_at) payload
  from public.pa_portal_document_cards c join public.pa_portal_document_versions v on v.id=c.current_version_id and v.card_id=c.id
  where c.portal_id=ctx.portal_id and c.archived_at is null and v.archived_at is null and public.pa_portal_staff_section(ctx.grade,c.category) is not null
  union all
  select f.sort_order,f.created_at,jsonb_build_object('section',public.pa_portal_staff_section(ctx.grade,'photos'),'ref',f.public_ref,'kind','photo','title',f.display_filename,'filename',f.display_filename,'mime_type',f.mime_type,'version_label',null,'updated_at',f.created_at)
  from public.pa_portal_photo_items f where f.portal_id=ctx.portal_id and f.archived_at is null and public.pa_portal_staff_section(ctx.grade,'photos') is not null
 ) d;
 return jsonb_build_object('ok',true,'portal',jsonb_build_object('grade',ctx.grade,'event',jsonb_build_object('name',i.event_name,'date',i.event_date,'time',i.event_time,'venue',i.venue,'timezone',ctx.timezone),'documents',docs));
end $$;

-- An exact canonical ref, not a client URL/path/case/grade, is accepted.
create function public.pa_portal_staff_asset(p_session_hash text,p_asset_ref text,p_asset_kind text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ctx record;a record;
begin
 select * into ctx from public.pa_portal_staff_context(p_session_hash);
 if not found then return jsonb_build_object('ok',false);end if;
 if p_asset_kind='version' then
  select v.source_type,v.source_ref,v.display_filename,v.mime_type,v.gmail_part_id into a from public.pa_portal_document_versions v
  join public.pa_portal_document_cards c on c.current_version_id=v.id and v.card_id=c.id
  where v.public_ref=p_asset_ref and c.portal_id=ctx.portal_id and c.archived_at is null and v.archived_at is null and public.pa_portal_staff_section(ctx.grade,c.category) is not null;
 elsif p_asset_kind='photo' then
  select f.source_type,f.source_ref,f.display_filename,f.mime_type,f.gmail_part_id into a from public.pa_portal_photo_items f
  where f.public_ref=p_asset_ref and f.portal_id=ctx.portal_id and f.archived_at is null and public.pa_portal_staff_section(ctx.grade,'photos') is not null;
 else return jsonb_build_object('ok',false);end if;
 if not found then return jsonb_build_object('ok',false);end if;
 return jsonb_build_object('ok',true,'case_id',ctx.case_id,'source_type',a.source_type,'source_ref',a.source_ref,'display_filename',a.display_filename,'mime_type',a.mime_type,'gmail_part_id',a.gmail_part_id);
end $$;

revoke all on function public.pa_portal_staff_section(text,text),public.pa_portal_staff_context(text) from public,anon,authenticated;
revoke all on function public.pa_portal_staff_manage_link(uuid,text,text,text,timestamptz,text,timestamptz) from public,anon;
grant execute on function public.pa_portal_staff_manage_link(uuid,text,text,text,timestamptz,text,timestamptz) to authenticated;
revoke all on function public.pa_portal_staff_exchange(text,text),public.pa_portal_staff_read(text),public.pa_portal_staff_asset(text,text,text) from public,anon,authenticated;
grant execute on function public.pa_portal_staff_exchange(text,text),public.pa_portal_staff_read(text),public.pa_portal_staff_asset(text,text,text) to service_role;
commit;

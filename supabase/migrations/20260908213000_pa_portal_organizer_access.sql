-- PA event document portal Phase 1.2B
-- Additive organizer access links, short-lived sessions and owner-scoped mutations.

begin;

do $$ begin
  if to_regclass('public.pa_portals') is null or to_regprocedure('public.is_work_admin()') is null then
    raise exception 'Phase 1.2B requires Phase 1.2A portal schema';
  end if;
end $$;

alter table public.pa_portals add column if not exists public_ref text;
alter table public.pa_portal_document_cards add column if not exists public_ref text;
alter table public.pa_portal_document_versions add column if not exists public_ref text;
alter table public.pa_portal_photo_items add column if not exists public_ref text;
alter table public.pa_portal_photo_items add column if not exists owner_kind text;

update public.pa_portals set public_ref=replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4) where public_ref is null;
update public.pa_portal_document_cards set public_ref=replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4) where public_ref is null;
update public.pa_portal_document_versions set public_ref=replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4) where public_ref is null;
update public.pa_portal_photo_items set public_ref=replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4),owner_kind=coalesce(owner_kind,contributor_kind) where public_ref is null or owner_kind is null;
update public.pa_portals p set event_identity=p.event_identity||jsonb_build_object('event_name',i.event_name,'event_date',i.event_date,'event_time',i.event_time,'venue',i.venue) from public.pa_inquiries i where i.id=p.case_id;

alter table public.pa_portals alter column public_ref set not null;
alter table public.pa_portal_document_cards alter column public_ref set not null;
alter table public.pa_portal_document_versions alter column public_ref set not null;
alter table public.pa_portal_photo_items alter column public_ref set not null;
alter table public.pa_portal_photo_items alter column owner_kind set not null;
alter table public.pa_portals alter column public_ref set default (replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4));
alter table public.pa_portal_document_cards alter column public_ref set default (replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4));
alter table public.pa_portal_document_versions alter column public_ref set default (replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4));
alter table public.pa_portal_photo_items alter column public_ref set default (replace(gen_random_uuid()::text,'-','')||left(replace(gen_random_uuid()::text,'-',''),4));
alter table public.pa_portal_photo_items alter column owner_kind set default 'shared';

create unique index if not exists pa_portals_public_ref_uq on public.pa_portals(public_ref);
create unique index if not exists pa_portal_cards_public_ref_uq on public.pa_portal_document_cards(public_ref);
create unique index if not exists pa_portal_versions_public_ref_uq on public.pa_portal_document_versions(public_ref);
create unique index if not exists pa_portal_photos_public_ref_uq on public.pa_portal_photo_items(public_ref);

do $$ begin
  if not exists(select 1 from pg_constraint where conname='pa_portal_photo_owner_kind_check') then
    alter table public.pa_portal_photo_items add constraint pa_portal_photo_owner_kind_check check(owner_kind in ('organizer','ara_tech','shared','performer'));
  end if;
end $$;

create or replace function public.pa_portal_photo_owner_default()
returns trigger language plpgsql set search_path='' as $$ begin
  if new.submitted_by is not null then new.owner_kind=new.contributor_kind; end if;
  return new;
end $$;
do $$ begin
  if not exists(select 1 from pg_trigger where tgname='pa_portal_photo_owner_default_trigger') then
    create trigger pa_portal_photo_owner_default_trigger before insert on public.pa_portal_photo_items for each row execute function public.pa_portal_photo_owner_default();
  end if;
end $$;

create table if not exists public.pa_portal_access_links (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  role text not null default 'organizer' check(role='organizer'),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  rotated_from uuid references public.pa_portal_access_links(id) on delete restrict,
  check(expires_at is null or expires_at>created_at)
);
create unique index if not exists pa_portal_one_active_organizer_link on public.pa_portal_access_links(portal_id,role) where revoked_at is null;

create table if not exists public.pa_portal_sessions (
  id uuid primary key default gen_random_uuid(),
  access_link_id uuid not null references public.pa_portal_access_links(id) on delete restrict,
  session_hash text not null unique check(session_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check(expires_at>created_at),
  revoked_at timestamptz,
  last_used_at timestamptz
);

create table if not exists public.pa_portal_organizer_mutation_keys (
  access_link_id uuid not null references public.pa_portal_access_links(id) on delete restrict,
  idempotency_key uuid not null,
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(access_link_id,idempotency_key)
);

create table if not exists public.pa_portal_collaboration_audit (
  id bigint generated always as identity primary key,
  portal_id uuid references public.pa_portals(id) on delete restrict,
  action text not null,
  actor_kind text not null check(actor_kind in ('ara_tech','organizer')),
  actor_id uuid references auth.users(id) on delete set null,
  access_link_id uuid references public.pa_portal_access_links(id) on delete restrict,
  session_id uuid references public.pa_portal_sessions(id) on delete restrict,
  card_id uuid references public.pa_portal_document_cards(id) on delete restrict,
  version_id uuid references public.pa_portal_document_versions(id) on delete restrict,
  photo_id uuid references public.pa_portal_photo_items(id) on delete restrict,
  success boolean not null,
  failure_code text,
  detail jsonb not null default '{}'::jsonb check(jsonb_typeof(detail)='object'),
  created_at timestamptz not null default now()
);
create index if not exists pa_portal_access_link_lookup on public.pa_portal_access_links(token_hash);
create index if not exists pa_portal_session_lookup on public.pa_portal_sessions(session_hash);
create index if not exists pa_portal_collaboration_audit_idx on public.pa_portal_collaboration_audit(portal_id,created_at desc);

alter table public.pa_portal_access_links enable row level security;
alter table public.pa_portal_sessions enable row level security;
alter table public.pa_portal_organizer_mutation_keys enable row level security;
alter table public.pa_portal_collaboration_audit enable row level security;
revoke all on public.pa_portal_access_links,public.pa_portal_sessions,public.pa_portal_organizer_mutation_keys,public.pa_portal_collaboration_audit from public,anon,authenticated;

create or replace function public.pa_portal_organizer_failure(p_portal uuid,p_link uuid,p_session uuid,p_action text,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,access_link_id,session_id,success,failure_code)
  values(p_portal,p_action,'organizer',p_link,p_session,false,p_code);
  return jsonb_build_object('ok',false,'code',p_code);
end $$;

create or replace function public.pa_portal_manage_link(p_case_id uuid,p_action text,p_token_hash text default null,p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_actor uuid:=auth.uid();v_portal public.pa_portals%rowtype;v_current public.pa_portal_access_links%rowtype;v_new public.pa_portal_access_links%rowtype;
begin
  if v_actor is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if p_action not in ('status','create','revoke','rotate') then raise exception 'invalid_link_action'; end if;
  select * into v_portal from public.pa_portals where case_id=p_case_id for update;
  if not found then raise exception 'portal_not_found'; end if;
  select * into v_current from public.pa_portal_access_links where portal_id=v_portal.id and role='organizer' and revoked_at is null order by created_at desc limit 1 for update;
  if p_action='status' then
    if v_current.id is null then return jsonb_build_object('exists',false,'active',false); end if;
    return jsonb_build_object('exists',true,'active',v_current.expires_at is null or v_current.expires_at>now(),'created_at',v_current.created_at,'expires_at',v_current.expires_at,'last_used_at',v_current.last_used_at);
  end if;
  if p_action='revoke' then
    if v_current.id is not null then
      update public.pa_portal_access_links set revoked_at=now() where id=v_current.id;
      update public.pa_portal_sessions set revoked_at=now() where access_link_id=v_current.id and revoked_at is null;
      insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,actor_id,access_link_id,success) values(v_portal.id,'link_revoked','ara_tech',v_actor,v_current.id,true);
    end if;
    return jsonb_build_object('exists',false,'active',false);
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or (p_expires_at is not null and (p_expires_at<=now() or p_expires_at>now()+interval '366 days')) then raise exception 'invalid_link'; end if;
  if p_action='create' and v_current.id is not null then raise exception 'active_link_exists'; end if;
  if p_action='rotate' and v_current.id is not null then
    update public.pa_portal_access_links set revoked_at=now() where id=v_current.id;
    update public.pa_portal_sessions set revoked_at=now() where access_link_id=v_current.id and revoked_at is null;
  end if;
  insert into public.pa_portal_access_links(portal_id,token_hash,created_by,expires_at,rotated_from)
  values(v_portal.id,p_token_hash,v_actor,p_expires_at,v_current.id) returning * into v_new;
  insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,actor_id,access_link_id,success) values(v_portal.id,case when p_action='rotate' then 'link_rotated' else 'link_created' end,'ara_tech',v_actor,v_new.id,true);
  return jsonb_build_object('exists',true,'active',true,'created_at',v_new.created_at,'expires_at',v_new.expires_at,'last_used_at',v_new.last_used_at);
end $$;

create or replace function public.pa_portal_exchange(p_token_hash text,p_session_hash text,p_session_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_link public.pa_portal_access_links%rowtype;v_session public.pa_portal_sessions%rowtype;v_code text;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or p_session_hash !~ '^[a-f0-9]{64}$' or p_session_expires_at<=now() or p_session_expires_at>now()+interval '13 hours' then return jsonb_build_object('ok',false); end if;
  select * into v_link from public.pa_portal_access_links where token_hash=p_token_hash for update;
  if not found then return jsonb_build_object('ok',false); end if;
  if v_link.revoked_at is not null then v_code='revoked'; elsif v_link.expires_at is not null and v_link.expires_at<=now() then v_code='expired'; end if;
  if v_code is not null then
    insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,access_link_id,success,failure_code) values(v_link.portal_id,'session_exchange','organizer',v_link.id,false,v_code);
    return jsonb_build_object('ok',false);
  end if;
  insert into public.pa_portal_sessions(access_link_id,session_hash,expires_at,last_used_at) values(v_link.id,p_session_hash,p_session_expires_at,now()) returning * into v_session;
  update public.pa_portal_access_links set last_used_at=now() where id=v_link.id;
  insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,access_link_id,session_id,success) values(v_link.portal_id,'session_exchange','organizer',v_link.id,v_session.id,true);
  return jsonb_build_object('ok',true,'expires_at',v_session.expires_at);
end $$;

create or replace function public.pa_portal_organizer_read(p_session_hash text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_session public.pa_portal_sessions%rowtype;v_link public.pa_portal_access_links%rowtype;v_portal public.pa_portals%rowtype;
begin
  select s.* into v_session from public.pa_portal_sessions s where s.session_hash=p_session_hash for update;
  if not found then return jsonb_build_object('ok',false); end if;
  select * into v_link from public.pa_portal_access_links where id=v_session.access_link_id;
  if v_session.revoked_at is not null or v_session.expires_at<=now() or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then
    insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,access_link_id,session_id,success,failure_code) values(v_link.portal_id,'session_read','organizer',v_link.id,v_session.id,false,'inactive_session');
    return jsonb_build_object('ok',false);
  end if;
  update public.pa_portal_sessions set last_used_at=now() where id=v_session.id;
  update public.pa_portal_access_links set last_used_at=now() where id=v_link.id;
  select * into v_portal from public.pa_portals where id=v_link.portal_id;
  return jsonb_build_object('ok',true,'portal',jsonb_build_object(
    'event',v_portal.event_identity,
    'cards',coalesce((select jsonb_agg(jsonb_build_object('ref',c.public_ref,'category',c.category,'title',c.title,'card_kind',c.card_kind,'owner_kind',c.owner_kind,'can_edit',c.owner_kind in ('organizer','shared'),'current_version_ref',cv.public_ref,'versions',coalesce((select jsonb_agg(jsonb_build_object('ref',v.public_ref,'display_filename',v.display_filename,'mime_type',v.mime_type,'version_label',v.version_label,'note',v.note,'contributor_kind',v.contributor_kind,'source_created_at',v.source_created_at,'created_at',v.created_at) order by (v.id=c.current_version_id) desc,coalesce(v.source_created_at,v.created_at) desc) from public.pa_portal_document_versions v where v.card_id=c.id and v.archived_at is null),'[]'::jsonb)) order by c.sort_order,c.created_at) from public.pa_portal_document_cards c left join public.pa_portal_document_versions cv on cv.id=c.current_version_id where c.portal_id=v_portal.id and c.archived_at is null),'[]'::jsonb),
    'photos',coalesce((select jsonb_agg(jsonb_build_object('ref',p.public_ref,'display_filename',p.display_filename,'mime_type',p.mime_type,'caption',p.caption,'owner_kind',p.owner_kind,'can_edit',p.owner_kind in ('organizer','shared'),'contributor_kind',p.contributor_kind,'source_created_at',p.source_created_at,'created_at',p.created_at) order by p.sort_order,coalesce(p.source_created_at,p.created_at) desc) from public.pa_portal_photo_items p where p.portal_id=v_portal.id and p.archived_at is null),'[]'::jsonb)
  ));
end $$;

create or replace function public.pa_portal_organizer_authorize(p_session_hash text,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_session public.pa_portal_sessions%rowtype;v_link public.pa_portal_access_links%rowtype;v_portal public.pa_portals%rowtype;v_card public.pa_portal_document_cards%rowtype;
begin
  select * into v_session from public.pa_portal_sessions where session_hash=p_session_hash;
  if not found then return jsonb_build_object('ok',false,'code','link_unavailable'); end if;
  select * into v_link from public.pa_portal_access_links where id=v_session.access_link_id;
  select * into v_portal from public.pa_portals where id=v_link.portal_id;
  if v_session.revoked_at is not null or v_session.expires_at<=now() or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'link_unavailable'); end if;
  if p_operation='add_version' and p_payload->'new_card' is null then
    select * into v_card from public.pa_portal_document_cards where public_ref=p_payload->>'card_ref' and portal_id=v_portal.id and archived_at is null;
    if not found or v_card.owner_kind not in ('organizer','shared') then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
  elsif p_operation='add_version' and (p_payload->'new_card'->>'category' not in ('layout','other') or p_payload->'new_card'->>'owner_kind' not in ('organizer','shared')) then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted');
  elsif p_operation<>'add_photo' then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
  return jsonb_build_object('ok',true,'portal_ref',v_portal.public_ref);
end $$;

create or replace function public.pa_portal_organizer_apply(p_session_hash text,p_operation text,p_payload jsonb,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_session public.pa_portal_sessions%rowtype;v_link public.pa_portal_access_links%rowtype;v_portal public.pa_portals%rowtype;v_card public.pa_portal_document_cards%rowtype;v_version public.pa_portal_document_versions%rowtype;v_photo public.pa_portal_photo_items%rowtype;v_result jsonb;v_prior record;
begin
  select * into v_session from public.pa_portal_sessions where session_hash=p_session_hash for update;
  if not found then return jsonb_build_object('ok',false,'code','link_unavailable'); end if;
  select * into v_link from public.pa_portal_access_links where id=v_session.access_link_id;
  select * into v_portal from public.pa_portals where id=v_link.portal_id;
  if v_session.revoked_at is not null or v_session.expires_at<=now() or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'link_unavailable'); end if;
  if p_idempotency_key is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or p_payload ? 'contributor_kind' or p_payload ? 'owner_kind' or p_payload ? 'source' then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'invalid_input'); end if;
  select portal_id,operation,result into v_prior from public.pa_portal_organizer_mutation_keys where access_link_id=v_link.id and idempotency_key=p_idempotency_key;
  if found then if v_prior.portal_id<>v_portal.id or v_prior.operation<>p_operation then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'invalid_idempotency_key'); end if; return jsonb_build_object('ok',true,'result',v_prior.result); end if;

  if p_operation in ('add_version','add_photo') then
    if p_payload->>'source_type'<>'portal_upload' or jsonb_typeof(p_payload->'source_ref')<>'object' or p_payload->>'mime_type' not in ('application/pdf','image/jpeg','image/png','image/webp') or char_length(btrim(p_payload->>'display_filename')) not between 1 and 255 or (p_payload->'source_ref'->>'storage_path') !~ ('^organizer/'||v_portal.public_ref||'/[0-9a-f-]{36}/') or coalesce(p_payload->'source_ref'->>'sha256','') !~ '^[a-f0-9]{64}$' or coalesce((p_payload->'source_ref'->>'size')::bigint,0) not between 1 and 3145728 then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'invalid_upload'); end if;
    if p_operation='add_photo' then
      if p_payload->>'mime_type'='application/pdf' then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'invalid_upload'); end if;
      insert into public.pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,caption,contributor_kind,owner_kind,source_created_at)
      values(v_portal.id,'portal_upload',p_payload->>'source_key',p_payload->'source_ref',btrim(p_payload->>'display_filename'),p_payload->>'mime_type',nullif(btrim(p_payload->>'caption'),''),'organizer','organizer',now()) returning * into v_photo;
      v_result=jsonb_build_object('photo_ref',v_photo.public_ref);
    else
      if jsonb_typeof(p_payload->'new_card')='object' then
        if p_payload->'new_card'->>'category' not in ('layout','other') or p_payload->'new_card'->>'owner_kind' not in ('organizer','shared') then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
        insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order) values(v_portal.id,p_payload->'new_card'->>'category',btrim(p_payload->'new_card'->>'title'),'collection',p_payload->'new_card'->>'owner_kind',case when p_payload->'new_card'->>'category'='layout' then 30 else 50 end) returning * into v_card;
      else
        select * into v_card from public.pa_portal_document_cards where public_ref=p_payload->>'card_ref' and portal_id=v_portal.id and archived_at is null for update;
        if not found or v_card.owner_kind not in ('organizer','shared') then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
      end if;
      insert into public.pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,version_label,note,contributor_kind,source_created_at) values(v_card.id,'portal_upload',p_payload->>'source_key',p_payload->'source_ref',btrim(p_payload->>'display_filename'),p_payload->>'mime_type',nullif(btrim(p_payload->>'version_label'),''),nullif(btrim(p_payload->>'note'),''),'organizer',now()) returning * into v_version;
      update public.pa_portal_document_cards set current_version_id=v_version.id,updated_at=now() where id=v_card.id;
      v_result=jsonb_build_object('card_ref',v_card.public_ref,'version_ref',v_version.public_ref);
    end if;
  elsif p_operation='switch_current' then
    select * into v_card from public.pa_portal_document_cards where public_ref=p_payload->>'card_ref' and portal_id=v_portal.id and archived_at is null for update;
    select * into v_version from public.pa_portal_document_versions where public_ref=p_payload->>'version_ref' and card_id=v_card.id and archived_at is null;
    if v_card.id is null or v_card.owner_kind not in ('organizer','shared') or v_version.id is null then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
    update public.pa_portal_document_cards set current_version_id=v_version.id,updated_at=now() where id=v_card.id;v_result=jsonb_build_object('current_version_ref',v_version.public_ref);
  elsif p_operation='archive_card' then
    select * into v_card from public.pa_portal_document_cards where public_ref=p_payload->>'card_ref' and portal_id=v_portal.id and archived_at is null for update;
    if not found or v_card.owner_kind not in ('organizer','shared') or v_card.card_kind='fixed' then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
    update public.pa_portal_document_cards set archived_at=now(),updated_at=now() where id=v_card.id;v_result=jsonb_build_object('archived',true);
  elsif p_operation='archive_version' then
    select v.* into v_version from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where v.public_ref=p_payload->>'version_ref' and c.portal_id=v_portal.id and c.owner_kind in ('organizer','shared') and v.archived_at is null for update of v;
    if not found or exists(select 1 from public.pa_portal_document_cards where current_version_id=v_version.id) then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
    update public.pa_portal_document_versions set archived_at=now() where id=v_version.id;v_result=jsonb_build_object('archived',true);
  elsif p_operation in ('archive_photo','update_photo_caption') then
    select * into v_photo from public.pa_portal_photo_items where public_ref=p_payload->>'photo_ref' and portal_id=v_portal.id and owner_kind in ('organizer','shared') and archived_at is null for update;
    if not found then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'not_permitted'); end if;
    if p_operation='archive_photo' then update public.pa_portal_photo_items set archived_at=now() where id=v_photo.id; else update public.pa_portal_photo_items set caption=nullif(btrim(p_payload->>'caption'),'') where id=v_photo.id; end if;
    v_result=jsonb_build_object('photo_ref',v_photo.public_ref);
  else return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'invalid_operation'); end if;
  insert into public.pa_portal_organizer_mutation_keys(access_link_id,idempotency_key,portal_id,operation,result) values(v_link.id,p_idempotency_key,v_portal.id,p_operation,v_result);
  insert into public.pa_portal_collaboration_audit(portal_id,action,actor_kind,access_link_id,session_id,card_id,version_id,photo_id,success) values(v_portal.id,p_operation,'organizer',v_link.id,v_session.id,v_card.id,v_version.id,v_photo.id,true);
  return jsonb_build_object('ok',true,'result',v_result);
exception when unique_violation then return public.pa_portal_organizer_failure(v_portal.id,v_link.id,v_session.id,p_operation,'duplicate_submit');
end $$;

create or replace function public.pa_portal_organizer_asset(p_session_hash text,p_asset_ref text,p_asset_kind text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_session public.pa_portal_sessions%rowtype;v_link public.pa_portal_access_links%rowtype;v_portal public.pa_portals%rowtype;v_asset record;
begin
  select * into v_session from public.pa_portal_sessions where session_hash=p_session_hash;
  if not found then return jsonb_build_object('ok',false); end if;select * into v_link from public.pa_portal_access_links where id=v_session.access_link_id;select * into v_portal from public.pa_portals where id=v_link.portal_id;
  if v_session.revoked_at is not null or v_session.expires_at<=now() or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at<=now()) then return jsonb_build_object('ok',false); end if;
  if p_asset_kind='version' then select v.source_type,v.source_ref,v.display_filename,v.mime_type into v_asset from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where v.public_ref=p_asset_ref and c.portal_id=v_portal.id and v.archived_at is null;
  elsif p_asset_kind='photo' then select p.source_type,p.source_ref,p.display_filename,p.mime_type into v_asset from public.pa_portal_photo_items p where p.public_ref=p_asset_ref and p.portal_id=v_portal.id and p.archived_at is null;else return jsonb_build_object('ok',false);end if;
  if not found then return jsonb_build_object('ok',false);end if;
  return jsonb_build_object('ok',true,'case_id',v_portal.case_id,'source_type',v_asset.source_type,'source_ref',v_asset.source_ref,'display_filename',v_asset.display_filename,'mime_type',v_asset.mime_type);
end $$;

revoke all on function public.pa_portal_manage_link(uuid,text,text,timestamptz) from public,anon;
grant execute on function public.pa_portal_manage_link(uuid,text,text,timestamptz) to authenticated;
revoke all on function public.pa_portal_exchange(text,text,timestamptz),public.pa_portal_organizer_read(text),public.pa_portal_organizer_authorize(text,text,jsonb),public.pa_portal_organizer_apply(text,text,jsonb,uuid),public.pa_portal_organizer_asset(text,text,text) from public,anon,authenticated;
revoke all on function public.pa_portal_organizer_failure(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.pa_portal_exchange(text,text,timestamptz),public.pa_portal_organizer_read(text),public.pa_portal_organizer_authorize(text,text,jsonb),public.pa_portal_organizer_apply(text,text,jsonb,uuid),public.pa_portal_organizer_asset(text,text,text) to service_role;

commit;

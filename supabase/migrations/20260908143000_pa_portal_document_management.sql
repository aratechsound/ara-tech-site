-- PA event document portal Phase 1.2A
-- Additive logical-document/version model. Existing Gmail assets remain canonical.

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regclass('public.pa_gmail_message_index') is null
    or to_regprocedure('public.is_work_admin()') is null then
    raise exception 'PA portal management requires PA inquiry, Gmail index and admin authority';
  end if;
end;
$$;

create table if not exists public.pa_portals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references public.pa_inquiries(id) on delete restrict,
  event_identity jsonb not null default '{}'::jsonb check (jsonb_typeof(event_identity) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pa_portal_document_cards (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  category text not null check (category in ('timetable','script','layout','performer','other')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  card_kind text not null check (card_kind in ('fixed','collection','performer')),
  owner_kind text not null check (owner_kind in ('organizer','ara_tech','shared','performer')),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  current_version_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (portal_id, category, title)
);

create table if not exists public.pa_portal_document_versions (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.pa_portal_document_cards(id) on delete restrict,
  source_type text not null check (source_type in ('gmail_attachment','pa_attachment','portal_upload')),
  source_key text not null check (char_length(source_key) between 1 and 700),
  source_ref jsonb not null check (jsonb_typeof(source_ref) = 'object'),
  display_filename text not null check (char_length(btrim(display_filename)) between 1 and 255),
  mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png','image/webp')),
  version_label text check (version_label is null or char_length(version_label) <= 80),
  note text check (note is null or char_length(note) <= 1000),
  contributor_kind text not null check (contributor_kind in ('organizer','ara_tech','shared','performer')),
  submitted_by uuid references auth.users(id) on delete set null,
  source_created_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (card_id, source_type, source_key)
);

do $$ begin
  if not exists(select 1 from pg_constraint where conname='pa_portal_document_cards_current_version_fk') then
    alter table public.pa_portal_document_cards add constraint pa_portal_document_cards_current_version_fk
      foreign key (current_version_id) references public.pa_portal_document_versions(id) on delete restrict;
  end if;
end $$;

create table if not exists public.pa_portal_photo_items (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  source_type text not null check (source_type in ('gmail_attachment','pa_attachment','portal_upload')),
  source_key text not null check (char_length(source_key) between 1 and 700),
  source_ref jsonb not null check (jsonb_typeof(source_ref) = 'object'),
  display_filename text not null check (char_length(btrim(display_filename)) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  caption text check (caption is null or char_length(caption) <= 300),
  contributor_kind text not null check (contributor_kind in ('organizer','ara_tech','shared','performer')),
  submitted_by uuid references auth.users(id) on delete set null,
  source_created_at timestamptz,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (portal_id, source_type, source_key)
);

create table if not exists public.pa_portal_audit (
  id bigint generated always as identity primary key,
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  card_id uuid references public.pa_portal_document_cards(id) on delete restrict,
  version_id uuid references public.pa_portal_document_versions(id) on delete restrict,
  photo_id uuid references public.pa_portal_photo_items(id) on delete restrict,
  action text not null check (action in ('card_created','version_added','current_changed','card_archived','version_archived','photo_added','photo_archived')),
  actor_id uuid references auth.users(id) on delete set null,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);

create table if not exists public.pa_portal_mutation_keys (
  idempotency_key uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, idempotency_key)
);

create index if not exists pa_portal_cards_visible_idx on public.pa_portal_document_cards(portal_id, category, sort_order, created_at) where archived_at is null;
create index if not exists pa_portal_versions_history_idx on public.pa_portal_document_versions(card_id, created_at desc) where archived_at is null;
create index if not exists pa_portal_photos_visible_idx on public.pa_portal_photo_items(portal_id, sort_order, created_at desc) where archived_at is null;
create index if not exists pa_portal_audit_portal_idx on public.pa_portal_audit(portal_id, created_at desc);

alter table public.pa_portals enable row level security;
alter table public.pa_portal_document_cards enable row level security;
alter table public.pa_portal_document_versions enable row level security;
alter table public.pa_portal_photo_items enable row level security;
alter table public.pa_portal_audit enable row level security;
alter table public.pa_portal_mutation_keys enable row level security;

drop policy if exists "PA admins read portals" on public.pa_portals;
drop policy if exists "PA admins read portal cards" on public.pa_portal_document_cards;
drop policy if exists "PA admins read portal versions" on public.pa_portal_document_versions;
drop policy if exists "PA admins read portal photos" on public.pa_portal_photo_items;
drop policy if exists "PA admins read portal audit" on public.pa_portal_audit;
create policy "PA admins read portals" on public.pa_portals for select to authenticated using (public.is_work_admin());
create policy "PA admins read portal cards" on public.pa_portal_document_cards for select to authenticated using (public.is_work_admin());
create policy "PA admins read portal versions" on public.pa_portal_document_versions for select to authenticated using (public.is_work_admin());
create policy "PA admins read portal photos" on public.pa_portal_photo_items for select to authenticated using (public.is_work_admin());
create policy "PA admins read portal audit" on public.pa_portal_audit for select to authenticated using (public.is_work_admin());

revoke all on public.pa_portals, public.pa_portal_document_cards, public.pa_portal_document_versions,
  public.pa_portal_photo_items, public.pa_portal_audit, public.pa_portal_mutation_keys from public, anon, authenticated;
grant select on public.pa_portals, public.pa_portal_document_cards, public.pa_portal_document_versions,
  public.pa_portal_photo_items, public.pa_portal_audit to authenticated;

create or replace function public.pa_portal_read(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_portal public.pa_portals%rowtype;
begin
  if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  select * into v_portal from public.pa_portals where case_id=p_case_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'portal', to_jsonb(v_portal),
    'cards', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('versions', coalesce((
      select jsonb_agg(to_jsonb(v) order by (v.id=c.current_version_id) desc, coalesce(v.source_created_at,v.created_at) desc)
      from public.pa_portal_document_versions v where v.card_id=c.id and v.archived_at is null
    ),'[]'::jsonb)) order by c.sort_order,c.created_at) from public.pa_portal_document_cards c where c.portal_id=v_portal.id and c.archived_at is null),'[]'::jsonb),
    'photos', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort_order,coalesce(p.source_created_at,p.created_at) desc) from public.pa_portal_photo_items p where p.portal_id=v_portal.id and p.archived_at is null),'[]'::jsonb)
  );
end;
$$;

create or replace function public.pa_portal_apply(p_case_id uuid, p_operation text, p_payload jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid(); v_portal public.pa_portals%rowtype; v_card public.pa_portal_document_cards%rowtype;
  v_version public.pa_portal_document_versions%rowtype; v_photo public.pa_portal_photo_items%rowtype;
  v_result jsonb; v_key_portal uuid; v_key_operation text; v_source_type text; v_source_ref jsonb; v_source_key text; v_mime text; v_filename text;
begin
  if v_actor is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if p_idempotency_key is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'invalid_input'; end if;
  if not exists(select 1 from public.pa_inquiries where id=p_case_id and deleted_at is null) then raise exception 'inquiry_not_found'; end if;

  insert into public.pa_portals(case_id,event_identity)
  select i.id,jsonb_build_object('event_name',i.event_name,'event_date',i.event_date,'venue',i.venue) from public.pa_inquiries i where i.id=p_case_id
  on conflict(case_id) do nothing;
  select * into v_portal from public.pa_portals where case_id=p_case_id for update;
  select portal_id,operation,result into v_key_portal,v_key_operation,v_result from public.pa_portal_mutation_keys where actor_id=v_actor and idempotency_key=p_idempotency_key;
  if found then
    if v_key_portal<>v_portal.id or v_key_operation<>p_operation then raise exception 'idempotency_key_mismatch'; end if;
    return v_result;
  end if;

  if p_operation='create_card' then
    if p_payload->>'category' not in ('layout','other') or p_payload->>'owner_kind' not in ('organizer','ara_tech','shared','performer') then raise exception 'invalid_card'; end if;
    insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order)
    values(v_portal.id,p_payload->>'category',btrim(p_payload->>'title'),'collection',p_payload->>'owner_kind',coalesce((p_payload->>'sort_order')::integer,0)) returning * into v_card;
    insert into public.pa_portal_audit(portal_id,card_id,action,actor_id) values(v_portal.id,v_card.id,'card_created',v_actor);
    v_result=jsonb_build_object('card_id',v_card.id);
  elsif p_operation in ('add_version','add_photo') then
    v_source_type=p_payload->>'source_type'; v_source_ref=p_payload->'source_ref'; v_source_key=p_payload->>'source_key';
    v_mime=p_payload->>'mime_type'; v_filename=btrim(p_payload->>'display_filename');
    if v_source_type not in ('gmail_attachment','pa_attachment','portal_upload') or jsonb_typeof(v_source_ref)<>'object'
      or char_length(v_source_key) not between 1 and 700 or char_length(v_filename) not between 1 and 255
      or v_mime not in ('application/pdf','image/jpeg','image/png','image/webp') then raise exception 'invalid_source'; end if;
    if v_source_type in ('gmail_attachment','pa_attachment') and not exists(
      select 1 from public.pa_gmail_message_index m cross join lateral jsonb_array_elements(m.attachment_metadata) a
      where m.inquiry_id=p_case_id and m.gmail_message_id=v_source_ref->>'gmail_message_id' and a->>'id'=v_source_ref->>'gmail_attachment_id'
        and a->>'filename'=v_filename and lower(coalesce(a->>'mime_type',''))=v_mime
        and (v_source_type<>'pa_attachment' or m.message_source='pa_case_manager')
        and (coalesce(a->>'filename','')||' '||coalesce(m.subject,'')) !~* '(見積|estimate|契約|contract|請求|invoice|領収|receipt)'
    ) then raise exception 'attachment_case_mismatch'; end if;
    if v_source_type='portal_upload' and ((v_source_ref->>'storage_path') !~ ('^cases/'||p_case_id::text||'/[0-9a-f-]{36}/')
      or coalesce(v_source_ref->>'sha256','') !~ '^[0-9a-f]{64}$' or coalesce((v_source_ref->>'size')::bigint,0) not between 1 and 3145728) then raise exception 'upload_case_mismatch'; end if;

    if p_operation='add_photo' then
      if v_mime='application/pdf' then raise exception 'invalid_photo'; end if;
      insert into public.pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,caption,contributor_kind,submitted_by,source_created_at)
      values(v_portal.id,v_source_type,v_source_key,v_source_ref,v_filename,v_mime,nullif(btrim(p_payload->>'caption'),''),p_payload->>'contributor_kind',v_actor,nullif(p_payload->>'source_created_at','')::timestamptz)
      returning * into v_photo;
      insert into public.pa_portal_audit(portal_id,photo_id,action,actor_id) values(v_portal.id,v_photo.id,'photo_added',v_actor);
      v_result=jsonb_build_object('photo_id',v_photo.id);
    else
      if nullif(p_payload->>'card_id','') is null and jsonb_typeof(p_payload->'new_card')='object' then
        if p_payload->'new_card'->>'category' not in ('layout','other') or p_payload->'new_card'->>'owner_kind' not in ('organizer','ara_tech','shared','performer') then raise exception 'invalid_card'; end if;
        insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order)
        values(v_portal.id,p_payload->'new_card'->>'category',btrim(p_payload->'new_card'->>'title'),'collection',p_payload->'new_card'->>'owner_kind',coalesce((p_payload->'new_card'->>'sort_order')::integer,0)) returning * into v_card;
        insert into public.pa_portal_audit(portal_id,card_id,action,actor_id) values(v_portal.id,v_card.id,'card_created',v_actor);
      else
        select * into v_card from public.pa_portal_document_cards where id=(p_payload->>'card_id')::uuid and portal_id=v_portal.id and archived_at is null for update;
      end if;
      if not found then raise exception 'card_case_mismatch'; end if;
      insert into public.pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,version_label,note,contributor_kind,submitted_by,source_created_at)
      values(v_card.id,v_source_type,v_source_key,v_source_ref,v_filename,v_mime,nullif(btrim(p_payload->>'version_label'),''),nullif(btrim(p_payload->>'note'),''),p_payload->>'contributor_kind',v_actor,nullif(p_payload->>'source_created_at','')::timestamptz)
      returning * into v_version;
      update public.pa_portal_document_cards set current_version_id=v_version.id,updated_at=now() where id=v_card.id;
      insert into public.pa_portal_audit(portal_id,card_id,version_id,action,actor_id,detail) values(v_portal.id,v_card.id,v_version.id,'version_added',v_actor,jsonb_build_object('previous_version_id',v_card.current_version_id));
      v_result=jsonb_build_object('card_id',v_card.id,'version_id',v_version.id);
    end if;
  elsif p_operation='switch_current' then
    select * into v_card from public.pa_portal_document_cards where id=(p_payload->>'card_id')::uuid and portal_id=v_portal.id and archived_at is null for update;
    select * into v_version from public.pa_portal_document_versions where id=(p_payload->>'version_id')::uuid and card_id=v_card.id and archived_at is null;
    if v_card.id is null or v_version.id is null then raise exception 'version_case_mismatch'; end if;
    update public.pa_portal_document_cards set current_version_id=v_version.id,updated_at=now() where id=v_card.id;
    insert into public.pa_portal_audit(portal_id,card_id,version_id,action,actor_id,detail) values(v_portal.id,v_card.id,v_version.id,'current_changed',v_actor,jsonb_build_object('previous_version_id',v_card.current_version_id));
    v_result=jsonb_build_object('card_id',v_card.id,'current_version_id',v_version.id);
  elsif p_operation='archive_card' then
    update public.pa_portal_document_cards set archived_at=now(),updated_at=now() where id=(p_payload->>'card_id')::uuid and portal_id=v_portal.id and archived_at is null returning * into v_card;
    if not found then raise exception 'card_case_mismatch'; end if;
    if v_card.card_kind='fixed' then raise exception 'cannot_archive_fixed'; end if;
    insert into public.pa_portal_audit(portal_id,card_id,action,actor_id) values(v_portal.id,v_card.id,'card_archived',v_actor);
    v_result=jsonb_build_object('card_id',v_card.id,'archived',true);
  elsif p_operation='archive_photo' then
    update public.pa_portal_photo_items set archived_at=now() where id=(p_payload->>'photo_id')::uuid and portal_id=v_portal.id and archived_at is null returning * into v_photo;
    if not found then raise exception 'photo_case_mismatch'; end if;
    insert into public.pa_portal_audit(portal_id,photo_id,action,actor_id) values(v_portal.id,v_photo.id,'photo_archived',v_actor);
    v_result=jsonb_build_object('photo_id',v_photo.id,'archived',true);
  elsif p_operation='archive_version' then
    select v.* into v_version from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where v.id=(p_payload->>'version_id')::uuid and c.portal_id=v_portal.id and v.archived_at is null for update of v;
    if not found then raise exception 'version_case_mismatch'; end if;
    if exists(select 1 from public.pa_portal_document_cards where id=v_version.card_id and current_version_id=v_version.id) then raise exception 'cannot_archive_current'; end if;
    update public.pa_portal_document_versions set archived_at=now() where id=v_version.id;
    insert into public.pa_portal_audit(portal_id,card_id,version_id,action,actor_id) values(v_portal.id,v_version.card_id,v_version.id,'version_archived',v_actor);
    v_result=jsonb_build_object('version_id',v_version.id,'archived',true);
  else raise exception 'invalid_operation'; end if;

  insert into public.pa_portal_mutation_keys(idempotency_key,actor_id,portal_id,operation,result) values(p_idempotency_key,v_actor,v_portal.id,p_operation,v_result);
  return v_result;
end;
$$;

revoke all on function public.pa_portal_read(uuid), public.pa_portal_apply(uuid,text,jsonb,uuid) from public, anon;
grant execute on function public.pa_portal_read(uuid), public.pa_portal_apply(uuid,text,jsonb,uuid) to authenticated;

-- Generic, idempotent portal/card/version/photo backfill from the existing Gmail index.
insert into public.pa_portals(case_id,event_identity)
select i.id,jsonb_build_object('event_name',i.event_name,'event_date',i.event_date,'venue',i.venue)
from public.pa_inquiries i where i.deleted_at is null on conflict(case_id) do nothing;

insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order)
select p.id,x.category,x.title,case when x.category in ('timetable','script') then 'fixed' else 'collection' end,x.owner_kind,x.sort_order
from public.pa_portals p cross join lateral (values ('timetable','タイムテーブル','shared',10),('script','台本','shared',20)) x(category,title,owner_kind,sort_order)
on conflict(portal_id,category,title) do nothing;

with attachments as (
  select p.id portal_id,m.gmail_message_id,m.message_source,m.direction,coalesce(m.received_at,m.sent_at,m.indexed_at) occurred_at,
    a->>'id' attachment_id,a->>'filename' filename,lower(coalesce(a->>'mime_type','')) mime_type,
    lower(coalesce(a->>'filename','')||' '||coalesce(m.subject,'')) searchable
  from public.pa_portals p join public.pa_gmail_message_index m on m.inquiry_id=p.case_id
  cross join lateral jsonb_array_elements(m.attachment_metadata) a
  where a ? 'id' and a ? 'filename' and (lower(coalesce(a->>'mime_type','')) in ('application/pdf','image/jpeg','image/png','image/webp') or a->>'filename' ~* '\.(pdf|jpe?g|png|webp)$')
    and (coalesce(a->>'filename','')||' '||coalesce(m.subject,'')) !~* '(見積|estimate|契約|contract|請求|invoice|領収|receipt)'
), classified as (
  select *,case when searchable ~ '(タイムテーブル|time[[:space:]]*table|timetable|進行表|香盤)' then 'timetable'
    when searchable ~ '(台本|script|進行台本)' then 'script'
    when mime_type like 'image/%' or searchable ~ '(写真|photo)' then 'photo'
    when searchable ~ '(会場図|配置図|平面図|電源|搬入|導線|layout|stage[[:space:]]*plot|ステージ図|音響)' then 'layout'
    when searchable ~ '(出演者|出演順|performer|artist|アーティスト)' then 'performer' else 'other' end category
  from attachments
), card_sources as (
  select *,case when category='timetable' then 'タイムテーブル' when category='script' then '台本'
    else left(btrim(regexp_replace(regexp_replace(filename,'\.[A-Za-z0-9]{1,8}$','','i'),'[＿_[:space:]-]*(最新版|最終|final|ver(sion)?|v)?[＿_[:space:]-]*[0-9]+(\.[0-9]+)?$','','i')),160) end title
  from classified where category<>'photo'
)
insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order)
select portal_id,category,title,case when category in ('timetable','script') then 'fixed' when category='performer' then 'performer' else 'collection' end,
  case when bool_and(direction='inbound') then 'organizer' when bool_and(direction='outbound') then 'ara_tech' else 'shared' end,
  case category when 'timetable' then 10 when 'script' then 20 when 'layout' then 30 when 'performer' then 40 else 50 end
from card_sources group by portal_id,category,title on conflict(portal_id,category,title) do nothing;

with attachments as (
  select p.id portal_id,m.gmail_message_id,m.message_source,m.direction,coalesce(m.received_at,m.sent_at,m.indexed_at) occurred_at,a->>'id' attachment_id,a->>'filename' filename,
    case when lower(coalesce(a->>'mime_type','')) in ('application/pdf','image/jpeg','image/png','image/webp') then lower(a->>'mime_type') when a->>'filename' ~* '\.pdf$' then 'application/pdf' when a->>'filename' ~* '\.png$' then 'image/png' when a->>'filename' ~* '\.webp$' then 'image/webp' else 'image/jpeg' end mime_type,
    lower(coalesce(a->>'filename','')||' '||coalesce(m.subject,'')) searchable
  from public.pa_portals p join public.pa_gmail_message_index m on m.inquiry_id=p.case_id cross join lateral jsonb_array_elements(m.attachment_metadata) a
  where a ? 'id' and a ? 'filename' and (lower(coalesce(a->>'mime_type','')) in ('application/pdf','image/jpeg','image/png','image/webp') or a->>'filename' ~* '\.(pdf|jpe?g|png|webp)$') and (coalesce(a->>'filename','')||' '||coalesce(m.subject,'')) !~* '(見積|estimate|契約|contract|請求|invoice|領収|receipt)'
), classified as (
  select *,case when searchable ~ '(タイムテーブル|time[[:space:]]*table|timetable|進行表|香盤)' then 'timetable' when searchable ~ '(台本|script|進行台本)' then 'script'
    when mime_type like 'image/%' or searchable ~ '(写真|photo)' then 'photo' when searchable ~ '(会場図|配置図|平面図|電源|搬入|導線|layout|stage[[:space:]]*plot|ステージ図|音響)' then 'layout'
    when searchable ~ '(出演者|出演順|performer|artist|アーティスト)' then 'performer' else 'other' end category from attachments
), normalized as (
  select *,case when category='timetable' then 'タイムテーブル' when category='script' then '台本' else left(btrim(regexp_replace(regexp_replace(filename,'\.[A-Za-z0-9]{1,8}$','','i'),'[＿_[:space:]-]*(最新版|最終|final|ver(sion)?|v)?[＿_[:space:]-]*[0-9]+(\.[0-9]+)?$','','i')),160) end title from classified
)
insert into public.pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind,source_created_at)
select c.id,case when n.message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end,n.gmail_message_id||':'||n.attachment_id,jsonb_build_object('gmail_message_id',n.gmail_message_id,'gmail_attachment_id',n.attachment_id),n.filename,n.mime_type,case when n.direction='inbound' then 'organizer' else 'ara_tech' end,n.occurred_at
from normalized n join public.pa_portal_document_cards c on c.portal_id=n.portal_id and c.category=n.category and c.title=n.title where n.category<>'photo'
on conflict(card_id,source_type,source_key) do nothing;

with latest as (
  select distinct on (card_id) card_id,id from public.pa_portal_document_versions
  where archived_at is null order by card_id,coalesce(source_created_at,created_at) desc,id desc
)
update public.pa_portal_document_cards c set current_version_id=latest.id,updated_at=now()
from latest where c.id=latest.card_id and c.current_version_id is distinct from latest.id;

with photos as (
  select p.id portal_id,m.gmail_message_id,m.message_source,m.direction,coalesce(m.received_at,m.sent_at,m.indexed_at) occurred_at,a->>'id' attachment_id,a->>'filename' filename,
    case when lower(a->>'mime_type') in ('image/jpeg','image/png','image/webp') then lower(a->>'mime_type') when a->>'filename' ~* '\.png$' then 'image/png' when a->>'filename' ~* '\.webp$' then 'image/webp' else 'image/jpeg' end mime_type
  from public.pa_portals p join public.pa_gmail_message_index m on m.inquiry_id=p.case_id cross join lateral jsonb_array_elements(m.attachment_metadata) a
  where a ? 'id' and a ? 'filename' and (lower(coalesce(a->>'mime_type','')) like 'image/%' or a->>'filename' ~* '\.(jpe?g|png|webp)$')
    and (coalesce(a->>'filename','')||' '||coalesce(m.subject,'')) !~* '(見積|estimate|契約|contract|請求|invoice|領収|receipt)'
)
insert into public.pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,caption,contributor_kind,source_created_at)
select portal_id,case when message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end,gmail_message_id||':'||attachment_id,jsonb_build_object('gmail_message_id',gmail_message_id,'gmail_attachment_id',attachment_id),filename,mime_type,filename,case when direction='inbound' then 'organizer' else 'ara_tech' end,occurred_at
from photos on conflict(portal_id,source_type,source_key) do nothing;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
    values('pa-portal-assets','pa-portal-assets',false,3145728,array['application/pdf','image/jpeg','image/png','image/webp'])
    on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
  end if;
end;
$$;

comment on table public.pa_portal_document_versions is 'Append-only portal versions; source_ref points to the canonical Gmail/PA attachment or portal upload.';
comment on table public.pa_portal_mutation_keys is 'Server mutation idempotency receipts; not readable by browser roles.';
commit;

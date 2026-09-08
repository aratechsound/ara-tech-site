-- PA event document portal Phase 1.2C
-- Gmail attachments are persisted as review candidates. They never become portal
-- documents, photos or current versions without an authenticated admin decision.

begin;

do $$
begin
  if to_regclass('public.pa_portals') is null
    or to_regclass('public.pa_portal_document_cards') is null
    or to_regclass('public.pa_portal_document_versions') is null
    or to_regclass('public.pa_portal_photo_items') is null
    or to_regclass('public.pa_gmail_thread_links') is null
    or to_regclass('public.pa_gmail_message_index') is null
    or to_regprocedure('public.is_work_admin()') is null then
    raise exception 'Phase 1.2C requires PA portal, Gmail binding and admin authority';
  end if;
end;
$$;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='pa_portals_id_case_unique') then
    alter table public.pa_portals add constraint pa_portals_id_case_unique unique(id,case_id);
  end if;
end $$;

create table if not exists public.pa_portal_document_candidates (
  id uuid primary key default gen_random_uuid(),
  portal_id uuid not null,
  case_id uuid not null,
  source_type text not null check (source_type in ('gmail_attachment','pa_attachment')),
  source_direction text not null check (source_direction in ('inbound','outbound')),
  gmail_message_id text not null check (gmail_message_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  gmail_attachment_id text not null check (char_length(gmail_attachment_id) between 1 and 1000),
  display_filename text not null check (char_length(btrim(display_filename)) between 1 and 255),
  mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png','image/webp')),
  source_created_at timestamptz,
  source_subject text not null default '' check (char_length(source_subject) <= 500),
  source_sender text not null default '' check (char_length(source_sender) <= 320),
  detected_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','accepted','ignored','dismissed')),
  suggested_category text not null check (suggested_category in ('timetable','script','layout','photo','performer','other')),
  suggested_card_id uuid references public.pa_portal_document_cards(id) on delete restrict,
  suggested_action text not null check (suggested_action in ('add_new_version','create_new_card','add_photo','hold_performer')),
  suggested_title text not null check (char_length(btrim(suggested_title)) between 1 and 160),
  confidence text not null check (confidence in ('high','medium','low')),
  suggestion_basis text not null check (char_length(btrim(suggestion_basis)) between 1 and 500),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  accepted_target jsonb check (accepted_target is null or jsonb_typeof(accepted_target)='object'),
  ignored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (portal_id,case_id) references public.pa_portals(id,case_id) on delete restrict,
  unique (portal_id,gmail_message_id,gmail_attachment_id)
);

create table if not exists public.pa_portal_candidate_audit (
  id bigint generated always as identity primary key,
  candidate_id uuid not null references public.pa_portal_document_candidates(id) on delete restrict,
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('DETECTED','SUGGESTED','ACCEPTED','IGNORED','TARGET_CHANGED')),
  before_target jsonb check (before_target is null or jsonb_typeof(before_target)='object'),
  after_target jsonb check (after_target is null or jsonb_typeof(after_target)='object'),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail)='object'),
  created_at timestamptz not null default now()
);

create index if not exists pa_portal_candidates_pending_idx on public.pa_portal_document_candidates(portal_id,detected_at desc) where status='pending';
create index if not exists pa_portal_candidates_source_idx on public.pa_portal_document_candidates(case_id,gmail_message_id,gmail_attachment_id);
create index if not exists pa_portal_candidate_audit_idx on public.pa_portal_candidate_audit(portal_id,candidate_id,created_at);

alter table public.pa_portal_document_candidates enable row level security;
alter table public.pa_portal_candidate_audit enable row level security;
revoke all on public.pa_portal_document_candidates,public.pa_portal_candidate_audit from public,anon,authenticated;

create or replace function public.pa_portal_candidate_detect(p_case_id uuid,p_actor_id uuid,p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_portal public.pa_portals%rowtype; v_message public.pa_gmail_message_index%rowtype; v_attachment jsonb; v_item jsonb;
  v_candidate_id uuid; v_card_id uuid; v_filename text; v_mime text; v_category text; v_action text; v_confidence text;
  v_inserted integer:=0; v_business_excluded integer:=0; v_signature_excluded integer:=0; v_size bigint; v_inline boolean;
begin
  if p_case_id is null or p_actor_id is null or not exists(select 1 from public.work_admins where user_id=p_actor_id) then raise exception 'not_authorized'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>500 then raise exception 'invalid_candidate_detection'; end if;
  if not exists(select 1 from public.pa_inquiries where id=p_case_id and deleted_at is null) then raise exception 'inquiry_not_found'; end if;
  insert into public.pa_portals(case_id,event_identity)
  select i.id,jsonb_build_object('event_name',i.event_name,'event_date',i.event_date,'venue',i.venue) from public.pa_inquiries i where i.id=p_case_id
  on conflict(case_id) do nothing;
  select * into v_portal from public.pa_portals where case_id=p_case_id;
  insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order)
  values(v_portal.id,'timetable','タイムテーブル','fixed','shared',10),(v_portal.id,'script','台本','fixed','shared',20)
  on conflict(portal_id,category,title) do nothing;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item)<>'object'
      or coalesce(v_item->>'gmail_message_id','') !~ '^[A-Za-z0-9_-]{1,200}$'
      or char_length(coalesce(v_item->>'gmail_attachment_id','')) not between 1 and 1000 then
      raise exception 'invalid_candidate_detection';
    end if;
    select m.* into v_message from public.pa_gmail_message_index m
    join public.pa_gmail_thread_links l on l.inquiry_id=m.inquiry_id and l.gmail_thread_id=m.gmail_thread_id
    where m.inquiry_id=p_case_id and m.gmail_message_id=v_item->>'gmail_message_id';
    if not found then continue; end if;
    select a into v_attachment from jsonb_array_elements(v_message.attachment_metadata) a where a->>'id'=v_item->>'gmail_attachment_id' limit 1;
    if v_attachment is null then continue; end if;
    v_filename=btrim(coalesce(v_attachment->>'filename',''));
    v_mime=lower(split_part(coalesce(v_attachment->>'mime_type',''),';',1));
    if v_mime not in ('application/pdf','image/jpeg','image/png','image/webp') then
      v_mime=case when v_filename ~* '\.pdf$' then 'application/pdf' when v_filename ~* '\.png$' then 'image/png' when v_filename ~* '\.webp$' then 'image/webp' when v_filename ~* '\.jpe?g$' then 'image/jpeg' else '' end;
    end if;
    if char_length(v_filename) not between 1 and 255 or v_mime not in ('application/pdf','image/jpeg','image/png','image/webp') then continue; end if;
    if v_filename ~* '(見積|estimate|quotation|契約|contract|請求|invoice|領収|receipt|支払|payment)' then v_business_excluded=v_business_excluded+1; continue; end if;
    v_size=case when coalesce(v_attachment->>'size','') ~ '^[0-9]+$' then (v_attachment->>'size')::bigint else 0 end;
    v_inline=(case when lower(coalesce(v_attachment->>'inline','')) in ('true','false') then (v_attachment->>'inline')::boolean else false end) or coalesce(v_attachment->>'content_id','')<>'' or coalesce(v_attachment->>'content_disposition','') ~* '^inline(?:;|$)';
    if v_mime like 'image/%' and ((v_size between 1 and 4096) or (v_inline and v_filename ~* '(^|[._ -])(logo|signature|sig|facebook|instagram|twitter|x-icon|linkedin|youtube|social|icon|pixel|spacer|tracker|tracking|qr)([._ -]|$)' and (v_size=0 or v_size<=204800))) then
      v_signature_excluded=v_signature_excluded+1; continue;
    end if;
    if exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where c.portal_id=v_portal.id and v.source_ref->>'gmail_message_id'=v_message.gmail_message_id and v.source_ref->>'gmail_attachment_id'=v_item->>'gmail_attachment_id')
      or exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and p.source_ref->>'gmail_message_id'=v_message.gmail_message_id and p.source_ref->>'gmail_attachment_id'=v_item->>'gmail_attachment_id') then continue; end if;

    v_category=v_item->>'suggested_category'; v_action=v_item->>'suggested_action'; v_confidence=v_item->>'confidence';
    if v_category not in ('timetable','script','layout','photo','performer','other')
      or v_action not in ('add_new_version','create_new_card','add_photo','hold_performer')
      or v_confidence not in ('high','medium','low')
      or char_length(btrim(coalesce(v_item->>'suggested_title',''))) not between 1 and 160
      or char_length(btrim(coalesce(v_item->>'suggestion_basis',''))) not between 1 and 500 then raise exception 'invalid_candidate_suggestion'; end if;
    v_card_id=null;
    if nullif(v_item->>'suggested_card_id','') is not null then
      select id into v_card_id from public.pa_portal_document_cards where id=(v_item->>'suggested_card_id')::uuid and portal_id=v_portal.id and category=v_category and archived_at is null;
      if not found then raise exception 'candidate_case_mismatch'; end if;
    elsif v_category in ('timetable','script') then
      select id into v_card_id from public.pa_portal_document_cards where portal_id=v_portal.id and category=v_category and card_kind='fixed' and archived_at is null limit 1;
    end if;
    v_candidate_id=null;
    insert into public.pa_portal_document_candidates(portal_id,case_id,source_type,source_direction,gmail_message_id,gmail_attachment_id,display_filename,mime_type,source_created_at,source_subject,source_sender,suggested_category,suggested_card_id,suggested_action,suggested_title,confidence,suggestion_basis)
    values(v_portal.id,p_case_id,case when v_message.message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end,v_message.direction,v_message.gmail_message_id,v_item->>'gmail_attachment_id',v_filename,v_mime,coalesce(v_message.received_at,v_message.sent_at,v_message.indexed_at),v_message.subject,v_message.from_address,v_category,v_card_id,v_action,btrim(v_item->>'suggested_title'),v_confidence,btrim(v_item->>'suggestion_basis'))
    on conflict(portal_id,gmail_message_id,gmail_attachment_id) do nothing returning id into v_candidate_id;
    if v_candidate_id is not null then
      v_inserted=v_inserted+1;
      insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,detail) values(v_candidate_id,v_portal.id,p_actor_id,'DETECTED',jsonb_build_object('source_direction',v_message.direction,'source_type',case when v_message.message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end));
      insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,after_target) values(v_candidate_id,v_portal.id,p_actor_id,'SUGGESTED',jsonb_build_object('category',v_category,'action',v_action,'card_id',v_card_id,'title',btrim(v_item->>'suggested_title'),'confidence',v_confidence));
    end if;
  end loop;
  return jsonb_build_object('detected',v_inserted,'pending',(select count(*) from public.pa_portal_document_candidates where portal_id=v_portal.id and status='pending'),'business_excluded',v_business_excluded,'signature_excluded',v_signature_excluded);
end;
$$;

create or replace function public.pa_portal_candidate_read(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_portal public.pa_portals%rowtype;
begin
  if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  select * into v_portal from public.pa_portals where case_id=p_case_id;
  if not found then return jsonb_build_object('pending_count',0,'candidates','[]'::jsonb,'cards','[]'::jsonb); end if;
  return jsonb_build_object(
    'pending_count',(select count(*) from public.pa_portal_document_candidates d where d.portal_id=v_portal.id and d.status='pending' and not exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where c.portal_id=v_portal.id and v.source_ref->>'gmail_message_id'=d.gmail_message_id and v.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id) and not exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and p.source_ref->>'gmail_message_id'=d.gmail_message_id and p.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id)),
    'candidates',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'source_type',d.source_type,'source_direction',d.source_direction,'display_filename',d.display_filename,'mime_type',d.mime_type,'source_created_at',d.source_created_at,'source_subject',d.source_subject,'source_sender',d.source_sender,'detected_at',d.detected_at,'suggested_category',d.suggested_category,'suggested_card_id',d.suggested_card_id,'suggested_action',d.suggested_action,'suggested_title',d.suggested_title,'confidence',d.confidence,'suggestion_basis',d.suggestion_basis) order by d.detected_at desc) from public.pa_portal_document_candidates d where d.portal_id=v_portal.id and d.status='pending' and not exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where c.portal_id=v_portal.id and v.source_ref->>'gmail_message_id'=d.gmail_message_id and v.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id) and not exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and p.source_ref->>'gmail_message_id'=d.gmail_message_id and p.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id)),'[]'::jsonb),
    'cards',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'category',c.category,'title',c.title,'card_kind',c.card_kind,'owner_kind',c.owner_kind) order by c.sort_order,c.created_at) from public.pa_portal_document_cards c where c.portal_id=v_portal.id and c.archived_at is null),'[]'::jsonb)
  );
end;
$$;

create or replace function public.pa_portal_candidate_asset(p_case_id uuid,p_candidate_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_candidate public.pa_portal_document_candidates%rowtype;
begin
  if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  select d.* into v_candidate from public.pa_portal_document_candidates d join public.pa_portals p on p.id=d.portal_id where d.id=p_candidate_id and p.case_id=p_case_id and d.status='pending';
  if not found then raise exception 'candidate_case_mismatch'; end if;
  if not exists(select 1 from public.pa_gmail_message_index m join public.pa_gmail_thread_links l on l.inquiry_id=m.inquiry_id and l.gmail_thread_id=m.gmail_thread_id cross join lateral jsonb_array_elements(m.attachment_metadata) a where m.inquiry_id=p_case_id and m.gmail_message_id=v_candidate.gmail_message_id and a->>'id'=v_candidate.gmail_attachment_id and a->>'filename'=v_candidate.display_filename and (case when lower(split_part(coalesce(a->>'mime_type',''),';',1)) in ('application/pdf','image/jpeg','image/png','image/webp') then lower(split_part(coalesce(a->>'mime_type',''),';',1)) when a->>'filename' ~* '\.pdf$' then 'application/pdf' when a->>'filename' ~* '\.png$' then 'image/png' when a->>'filename' ~* '\.webp$' then 'image/webp' when a->>'filename' ~* '\.jpe?g$' then 'image/jpeg' else '' end)=v_candidate.mime_type) then raise exception 'candidate_attachment_mismatch'; end if;
  return jsonb_build_object('source_type',v_candidate.source_type,'source_ref',jsonb_build_object('gmail_message_id',v_candidate.gmail_message_id,'gmail_attachment_id',v_candidate.gmail_attachment_id),'display_filename',v_candidate.display_filename,'mime_type',v_candidate.mime_type);
end;
$$;

create or replace function public.pa_portal_candidate_apply(p_case_id uuid,p_candidate_id uuid,p_decision text,p_target jsonb,p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=auth.uid(); v_portal public.pa_portals%rowtype; v_candidate public.pa_portal_document_candidates%rowtype; v_card public.pa_portal_document_cards%rowtype;
  v_version public.pa_portal_document_versions%rowtype; v_photo public.pa_portal_photo_items%rowtype; v_result jsonb; v_receipt record;
  v_action text; v_category text; v_title text; v_owner text; v_make_current boolean:=false; v_source_ref jsonb; v_source_key text; v_before jsonb; v_after jsonb;
begin
  if v_actor is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if p_candidate_id is null or p_idempotency_key is null or p_decision not in ('accept','ignore') or p_target is null or jsonb_typeof(p_target)<>'object' then raise exception 'invalid_candidate_review'; end if;
  select * into v_portal from public.pa_portals where case_id=p_case_id;
  if not found then raise exception 'portal_not_found'; end if;
  select portal_id,operation,result into v_receipt from public.pa_portal_mutation_keys where actor_id=v_actor and idempotency_key=p_idempotency_key;
  if found then
    if v_receipt.portal_id<>v_portal.id or v_receipt.operation<>(case when p_decision='accept' then 'candidate_accept' else 'candidate_ignore' end) then raise exception 'idempotency_key_mismatch'; end if;
    return v_receipt.result;
  end if;
  select * into v_candidate from public.pa_portal_document_candidates where id=p_candidate_id and portal_id=v_portal.id and case_id=p_case_id for update;
  if not found then raise exception 'candidate_case_mismatch'; end if;
  if v_candidate.status<>'pending' then raise exception 'candidate_already_reviewed'; end if;
  if not exists(select 1 from public.pa_gmail_message_index m join public.pa_gmail_thread_links l on l.inquiry_id=m.inquiry_id and l.gmail_thread_id=m.gmail_thread_id cross join lateral jsonb_array_elements(m.attachment_metadata) a where m.inquiry_id=p_case_id and m.gmail_message_id=v_candidate.gmail_message_id and a->>'id'=v_candidate.gmail_attachment_id and a->>'filename'=v_candidate.display_filename and (case when lower(split_part(coalesce(a->>'mime_type',''),';',1)) in ('application/pdf','image/jpeg','image/png','image/webp') then lower(split_part(coalesce(a->>'mime_type',''),';',1)) when a->>'filename' ~* '\.pdf$' then 'application/pdf' when a->>'filename' ~* '\.png$' then 'image/png' when a->>'filename' ~* '\.webp$' then 'image/webp' when a->>'filename' ~* '\.jpe?g$' then 'image/jpeg' else '' end)=v_candidate.mime_type) then raise exception 'candidate_attachment_mismatch'; end if;
  if exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where c.portal_id=v_portal.id and v.source_ref->>'gmail_message_id'=v_candidate.gmail_message_id and v.source_ref->>'gmail_attachment_id'=v_candidate.gmail_attachment_id)
    or exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and p.source_ref->>'gmail_message_id'=v_candidate.gmail_message_id and p.source_ref->>'gmail_attachment_id'=v_candidate.gmail_attachment_id) then raise exception 'portal_source_already_used'; end if;
  v_before=jsonb_build_object('category',v_candidate.suggested_category,'action',v_candidate.suggested_action,'card_id',v_candidate.suggested_card_id,'title',v_candidate.suggested_title);
  if p_decision='ignore' then
    update public.pa_portal_document_candidates set status='ignored',reviewed_by=v_actor,reviewed_at=now(),ignored_at=now(),updated_at=now() where id=v_candidate.id;
    insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,before_target) values(v_candidate.id,v_portal.id,v_actor,'IGNORED',v_before);
    v_result=jsonb_build_object('candidate_id',v_candidate.id,'status','ignored');
  else
    v_action=p_target->>'action'; v_category=p_target->>'category'; v_title=btrim(coalesce(p_target->>'title','')); v_owner=coalesce(p_target->>'owner_kind','shared');
    if coalesce(p_target->>'make_current','false') not in ('true','false') then raise exception 'invalid_candidate_target'; end if;
    v_make_current=(p_target->>'make_current')::boolean;
    if v_action not in ('add_new_version','create_new_card','add_photo') or v_category not in ('timetable','script','layout','photo','other') or v_owner not in ('organizer','ara_tech','shared','performer') then raise exception 'invalid_candidate_target'; end if;
    v_source_ref=jsonb_build_object('gmail_message_id',v_candidate.gmail_message_id,'gmail_attachment_id',v_candidate.gmail_attachment_id); v_source_key=v_candidate.gmail_message_id||':'||v_candidate.gmail_attachment_id;
    if v_action='add_photo' then
      if v_category<>'photo' or v_candidate.mime_type not like 'image/%' then raise exception 'invalid_candidate_target'; end if;
      insert into public.pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,caption,contributor_kind,submitted_by,source_created_at)
      values(v_portal.id,v_candidate.source_type,v_source_key,v_source_ref,v_candidate.display_filename,v_candidate.mime_type,nullif(btrim(p_target->>'note'),''),case when v_candidate.source_direction='inbound' then 'organizer' else 'ara_tech' end,v_actor,v_candidate.source_created_at) returning * into v_photo;
      insert into public.pa_portal_audit(portal_id,photo_id,action,actor_id,detail) values(v_portal.id,v_photo.id,'photo_added',v_actor,jsonb_build_object('candidate_id',v_candidate.id));
      v_after=jsonb_build_object('category','photo','action','add_photo','photo_id',v_photo.id,'make_current',false);
      v_result=jsonb_build_object('candidate_id',v_candidate.id,'status','accepted','photo_id',v_photo.id);
    else
      if v_candidate.mime_type not in ('application/pdf','image/jpeg','image/png','image/webp') then raise exception 'invalid_candidate_target'; end if;
      if v_action='create_new_card' then
        if v_category not in ('layout','other') or char_length(v_title) not between 1 and 160 or not v_make_current then raise exception 'invalid_candidate_target'; end if;
        insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order)
        values(v_portal.id,v_category,v_title,'collection',v_owner,case when v_category='layout' then 30 else 50 end) returning * into v_card;
        insert into public.pa_portal_audit(portal_id,card_id,action,actor_id,detail) values(v_portal.id,v_card.id,'card_created',v_actor,jsonb_build_object('candidate_id',v_candidate.id));
      else
        select * into v_card from public.pa_portal_document_cards where id=(p_target->>'card_id')::uuid and portal_id=v_portal.id and archived_at is null for update;
        if not found or v_card.category='performer' or v_card.category<>v_category then raise exception 'candidate_card_mismatch'; end if;
      end if;
      insert into public.pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,version_label,note,contributor_kind,submitted_by,source_created_at)
      values(v_card.id,v_candidate.source_type,v_source_key,v_source_ref,v_candidate.display_filename,v_candidate.mime_type,nullif(btrim(p_target->>'version_label'),''),nullif(btrim(p_target->>'note'),''),case when v_candidate.source_direction='inbound' then 'organizer' else 'ara_tech' end,v_actor,v_candidate.source_created_at) returning * into v_version;
      insert into public.pa_portal_audit(portal_id,card_id,version_id,action,actor_id,detail) values(v_portal.id,v_card.id,v_version.id,'version_added',v_actor,jsonb_build_object('candidate_id',v_candidate.id,'previous_version_id',v_card.current_version_id));
      if v_make_current then
        update public.pa_portal_document_cards set current_version_id=v_version.id,updated_at=now() where id=v_card.id;
        insert into public.pa_portal_audit(portal_id,card_id,version_id,action,actor_id,detail) values(v_portal.id,v_card.id,v_version.id,'current_changed',v_actor,jsonb_build_object('candidate_id',v_candidate.id,'previous_version_id',v_card.current_version_id));
      end if;
      v_after=jsonb_build_object('category',v_card.category,'action',v_action,'card_id',v_card.id,'title',v_card.title,'owner_kind',v_card.owner_kind,'version_id',v_version.id,'make_current',v_make_current);
      v_result=jsonb_build_object('candidate_id',v_candidate.id,'status','accepted','card_id',v_card.id,'version_id',v_version.id,'current_changed',v_make_current);
    end if;
    if (v_before->>'category',v_before->>'action',coalesce(v_before->>'card_id',''),v_before->>'title') is distinct from (v_after->>'category',v_after->>'action',coalesce(v_after->>'card_id',''),coalesce(v_after->>'title','')) then
      insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,before_target,after_target) values(v_candidate.id,v_portal.id,v_actor,'TARGET_CHANGED',v_before,v_after);
    end if;
    update public.pa_portal_document_candidates set status='accepted',reviewed_by=v_actor,reviewed_at=now(),accepted_target=v_after,updated_at=now() where id=v_candidate.id;
    insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,before_target,after_target) values(v_candidate.id,v_portal.id,v_actor,'ACCEPTED',v_before,v_after);
  end if;
  insert into public.pa_portal_mutation_keys(idempotency_key,actor_id,portal_id,operation,result) values(p_idempotency_key,v_actor,v_portal.id,case when p_decision='accept' then 'candidate_accept' else 'candidate_ignore' end,v_result);
  return v_result;
end;
$$;

revoke all on function public.pa_portal_candidate_detect(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pa_portal_candidate_detect(uuid,uuid,jsonb) to service_role;
revoke all on function public.pa_portal_candidate_read(uuid),public.pa_portal_candidate_asset(uuid,uuid),public.pa_portal_candidate_apply(uuid,uuid,text,jsonb,uuid) from public,anon;
grant execute on function public.pa_portal_candidate_read(uuid),public.pa_portal_candidate_asset(uuid,uuid),public.pa_portal_candidate_apply(uuid,uuid,text,jsonb,uuid) to authenticated;

comment on table public.pa_portal_document_candidates is 'Review inbox only. Gmail attachment bytes remain canonical and no portal registration occurs before admin acceptance.';
comment on table public.pa_portal_candidate_audit is 'Candidate lifecycle audit without message bodies or raw secrets.';
commit;

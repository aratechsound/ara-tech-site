-- PA event document portal Phase 1.2C-R1
-- Preserve historical Gmail source_ref values while attaching a stable
-- message + MIME-part identity used for resolver lookup and duplicate control.

begin;

alter table public.pa_portal_document_versions
  add column if not exists source_provider text,
  add column if not exists gmail_part_id text,
  add column if not exists canonical_attachment_key text,
  add column if not exists source_content_sha256 text,
  add column if not exists source_byte_size bigint;

alter table public.pa_portal_photo_items
  add column if not exists source_provider text,
  add column if not exists gmail_part_id text,
  add column if not exists canonical_attachment_key text,
  add column if not exists source_content_sha256 text,
  add column if not exists source_byte_size bigint;

alter table public.pa_portal_document_candidates
  add column if not exists source_provider text,
  add column if not exists gmail_part_id text,
  add column if not exists canonical_attachment_key text,
  add column if not exists source_content_sha256 text,
  add column if not exists source_byte_size bigint;

do $$
declare v_table text; v_constraint text;
begin
  foreach v_table in array array['pa_portal_document_versions','pa_portal_photo_items','pa_portal_document_candidates']
  loop
    v_constraint=v_table||'_canonical_identity_check';
    if not exists(select 1 from pg_constraint where conname=v_constraint) then
      execute format('alter table public.%I add constraint %I check (((source_provider is null and gmail_part_id is null and canonical_attachment_key is null) or (source_provider=''gmail'' and char_length(gmail_part_id) between 1 and 1000 and canonical_attachment_key ~ ''^gmail:message-part:v1:[a-f0-9]{64}$'')) and (source_content_sha256 is null or source_content_sha256 ~ ''^[a-f0-9]{64}$'') and (source_byte_size is null or source_byte_size between 1 and 10485760))',v_table,v_constraint);
    end if;
  end loop;
end $$;

create unique index if not exists pa_portal_candidate_canonical_unique
  on public.pa_portal_document_candidates(portal_id,canonical_attachment_key)
  where canonical_attachment_key is not null;
create index if not exists pa_portal_versions_canonical_idx
  on public.pa_portal_document_versions(canonical_attachment_key)
  where canonical_attachment_key is not null;
create index if not exists pa_portal_photos_canonical_idx
  on public.pa_portal_photo_items(portal_id,canonical_attachment_key)
  where canonical_attachment_key is not null;

create table if not exists public.pa_portal_candidate_system_audit (
  id bigint generated always as identity primary key,
  candidate_id uuid not null references public.pa_portal_document_candidates(id) on delete restrict,
  portal_id uuid not null references public.pa_portals(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('RECONCILED_DUPLICATE_REGISTERED_ASSET','SUGGESTION_RECALCULATED')),
  event_key text not null check (char_length(event_key) between 1 and 180),
  before_state jsonb check (before_state is null or jsonb_typeof(before_state)='object'),
  after_state jsonb check (after_state is null or jsonb_typeof(after_state)='object'),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail)='object'),
  created_at timestamptz not null default now(),
  unique(candidate_id,action,event_key)
);
create index if not exists pa_portal_candidate_system_audit_idx
  on public.pa_portal_candidate_system_audit(portal_id,candidate_id,created_at);
alter table public.pa_portal_candidate_system_audit enable row level security;
revoke all on public.pa_portal_candidate_system_audit from public,anon,authenticated;

create or replace function public.pa_portal_candidate_identity_context(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_portal public.pa_portals%rowtype;
begin
  if current_user not in ('postgres','service_role') then raise exception 'not_authorized'; end if;
  select * into v_portal from public.pa_portals p
    where p.case_id=p_case_id
      and exists(select 1 from public.pa_inquiries i where i.id=p_case_id and i.deleted_at is null);
  if not found then return jsonb_build_object('registered','[]'::jsonb); end if;
  return jsonb_build_object('registered',coalesce((
    select jsonb_agg(asset order by asset->>'display_filename') from (
      select jsonb_build_object(
        'asset_kind','version','asset_id',v.id,'source_type',v.source_type,'source_ref',v.source_ref,
        'display_filename',v.display_filename,'mime_type',v.mime_type,'gmail_part_id',v.gmail_part_id,
        'canonical_attachment_key',v.canonical_attachment_key,'source_content_sha256',v.source_content_sha256,
        'source_byte_size',v.source_byte_size
      ) asset
      from public.pa_portal_document_versions v
      join public.pa_portal_document_cards c on c.id=v.card_id
      where c.portal_id=v_portal.id and v.archived_at is null and v.source_type in ('gmail_attachment','pa_attachment')
      union all
      select jsonb_build_object(
        'asset_kind','photo','asset_id',p.id,'source_type',p.source_type,'source_ref',p.source_ref,
        'display_filename',p.display_filename,'mime_type',p.mime_type,'gmail_part_id',p.gmail_part_id,
        'canonical_attachment_key',p.canonical_attachment_key,'source_content_sha256',p.source_content_sha256,
        'source_byte_size',p.source_byte_size
      ) asset
      from public.pa_portal_photo_items p
      where p.portal_id=v_portal.id and p.archived_at is null and p.source_type in ('gmail_attachment','pa_attachment')
    ) registered_assets
  ),'[]'::jsonb));
end;
$$;

create or replace function public.pa_portal_candidate_reconcile(p_case_id uuid,p_actor_id uuid,p_mappings jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_portal public.pa_portals%rowtype; v_mapping jsonb; v_candidate public.pa_portal_document_candidates%rowtype;
  v_kind text; v_asset_id uuid; v_message text; v_historical text; v_current text; v_part text; v_key text;
  v_filename text; v_mime text; v_hash text; v_proof text; v_expected_key text; v_existing_key text;
  v_before jsonb; v_after jsonb; v_reconciled integer:=0; v_recalculated integer:=0;
begin
  if current_user not in ('postgres','service_role') or p_actor_id is null
    or not exists(select 1 from public.work_admins where user_id=p_actor_id) then raise exception 'not_authorized'; end if;
  if p_mappings is null or jsonb_typeof(p_mappings)<>'array' or jsonb_array_length(p_mappings)>500 then raise exception 'invalid_identity_mapping'; end if;
  select * into v_portal from public.pa_portals where case_id=p_case_id for update;
  if not found then raise exception 'portal_not_found'; end if;

  for v_mapping in select value from jsonb_array_elements(p_mappings)
  loop
    v_kind=v_mapping->>'asset_kind'; v_asset_id=(v_mapping->>'asset_id')::uuid;
    v_message=v_mapping->>'gmail_message_id'; v_historical=v_mapping->>'historical_attachment_id';
    v_current=v_mapping->>'current_attachment_id'; v_part=v_mapping->>'gmail_part_id';
    v_key=v_mapping->>'canonical_attachment_key'; v_filename=btrim(v_mapping->>'display_filename');
    v_mime=lower(v_mapping->>'mime_type'); v_hash=nullif(v_mapping->>'content_sha256',''); v_proof=v_mapping->>'proof_type';
    v_expected_key='gmail:message-part:v1:'||encode(sha256(convert_to('gmail'||chr(31)||v_message||chr(31)||v_part,'UTF8')),'hex');
    if v_kind not in ('version','photo') or v_message !~ '^[A-Za-z0-9_-]{1,200}$'
      or char_length(v_historical) not between 1 and 1000 or char_length(v_current) not between 1 and 1000
      or char_length(v_part) not between 1 and 1000 or v_key<>v_expected_key
      or char_length(v_filename) not between 1 and 255
      or v_mime not in ('application/pdf','image/jpeg','image/png','image/webp')
      or coalesce((v_mapping->>'source_byte_size')::bigint,0) not between 1 and 10485760
      or (v_historical<>v_current and (v_proof<>'same_message_content_sha256' or coalesce(v_hash,'') !~ '^[a-f0-9]{64}$'))
      or (v_historical=v_current and v_proof<>'exact_attachment_identity') then raise exception 'invalid_identity_mapping'; end if;
    if not exists(
      select 1 from public.pa_gmail_message_index m
      join public.pa_gmail_thread_links l on l.inquiry_id=m.inquiry_id and l.gmail_thread_id=m.gmail_thread_id
      cross join lateral jsonb_array_elements(m.attachment_metadata) a
      where m.inquiry_id=p_case_id and m.gmail_message_id=v_message
        and a->>'id'=v_current and a->>'part_id'=v_part and a->>'filename'=v_filename
        and lower(split_part(coalesce(a->>'mime_type',''),';',1))=v_mime
        and coalesce((a->>'size')::bigint,0)=(v_mapping->>'source_byte_size')::bigint
    ) then raise exception 'identity_current_attachment_mismatch'; end if;

    if v_kind='version' then
      select v.canonical_attachment_key into v_existing_key
      from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id
      where v.id=v_asset_id and c.portal_id=v_portal.id and v.archived_at is null
        and v.source_type in ('gmail_attachment','pa_attachment')
        and v.source_ref->>'gmail_message_id'=v_message and v.source_ref->>'gmail_attachment_id'=v_historical
        and v.display_filename=v_filename and v.mime_type=v_mime for update of v;
      if not found or (v_existing_key is not null and v_existing_key<>v_key) then raise exception 'identity_registered_asset_mismatch'; end if;
      update public.pa_portal_document_versions set source_provider='gmail',gmail_part_id=v_part,
        canonical_attachment_key=v_key,source_content_sha256=v_hash,source_byte_size=(v_mapping->>'source_byte_size')::bigint
        where id=v_asset_id;
    else
      select p.canonical_attachment_key into v_existing_key
      from public.pa_portal_photo_items p where p.id=v_asset_id and p.portal_id=v_portal.id and p.archived_at is null
        and p.source_type in ('gmail_attachment','pa_attachment')
        and p.source_ref->>'gmail_message_id'=v_message and p.source_ref->>'gmail_attachment_id'=v_historical
        and p.display_filename=v_filename and p.mime_type=v_mime for update;
      if not found or (v_existing_key is not null and v_existing_key<>v_key) then raise exception 'identity_registered_asset_mismatch'; end if;
      update public.pa_portal_photo_items set source_provider='gmail',gmail_part_id=v_part,
        canonical_attachment_key=v_key,source_content_sha256=v_hash,source_byte_size=(v_mapping->>'source_byte_size')::bigint
        where id=v_asset_id;
    end if;

    for v_candidate in select * from public.pa_portal_document_candidates d
      where d.portal_id=v_portal.id and d.status='pending'
        and d.gmail_message_id=v_message
        and (d.gmail_attachment_id=v_current or d.canonical_attachment_key=v_key)
      for update
    loop
      v_before=jsonb_build_object('category',v_candidate.suggested_category,'action',v_candidate.suggested_action,
        'card_id',v_candidate.suggested_card_id,'title',v_candidate.suggested_title,'confidence',v_candidate.confidence);
      v_after=jsonb_build_object('category',v_mapping->>'suggested_category','action',v_mapping->>'suggested_action',
        'card_id',nullif(v_mapping->>'suggested_card_id','')::uuid,'title',btrim(v_mapping->>'suggested_title'),'confidence',v_mapping->>'confidence');
      if v_before is distinct from v_after then
        insert into public.pa_portal_candidate_system_audit(candidate_id,portal_id,actor_id,action,event_key,before_state,after_state,detail)
        values(v_candidate.id,v_portal.id,p_actor_id,'SUGGESTION_RECALCULATED',
          'suggestion:'||encode(sha256(convert_to(v_after::text,'UTF8')),'hex'),v_before,v_after,
          jsonb_build_object('reason','classification_rules_calibrated')) on conflict do nothing;
        v_recalculated=v_recalculated+1;
      end if;
      update public.pa_portal_document_candidates set source_provider='gmail',gmail_part_id=v_part,
        canonical_attachment_key=v_key,source_content_sha256=v_hash,source_byte_size=(v_mapping->>'source_byte_size')::bigint,
        suggested_category=v_mapping->>'suggested_category',suggested_card_id=nullif(v_mapping->>'suggested_card_id','')::uuid,
        suggested_action=v_mapping->>'suggested_action',suggested_title=btrim(v_mapping->>'suggested_title'),
        confidence=v_mapping->>'confidence',suggestion_basis=btrim(v_mapping->>'suggestion_basis'),
        status='dismissed',updated_at=now() where id=v_candidate.id;
      insert into public.pa_portal_candidate_system_audit(candidate_id,portal_id,actor_id,action,event_key,before_state,after_state,detail)
      values(v_candidate.id,v_portal.id,p_actor_id,'RECONCILED_DUPLICATE_REGISTERED_ASSET','reconcile:'||v_key,
        jsonb_build_object('status','pending'),jsonb_build_object('status','dismissed'),
        jsonb_build_object('reason','duplicate_registered_asset','proof_type',v_proof,'canonical_attachment_key',v_key))
      on conflict do nothing;
      v_reconciled=v_reconciled+1;
    end loop;
  end loop;
  return jsonb_build_object('reconciled',v_reconciled,'suggestions_recalculated',v_recalculated);
end;
$$;

create or replace function public.pa_portal_fill_canonical_identity()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare v_portal_id uuid; v_case_id uuid; v_attachment jsonb; v_key text;
begin
  if new.source_type not in ('gmail_attachment','pa_attachment') then return new; end if;
  if tg_table_name='pa_portal_document_versions' then
    select c.portal_id,p.case_id into v_portal_id,v_case_id from public.pa_portal_document_cards c join public.pa_portals p on p.id=c.portal_id where c.id=new.card_id;
  else
    select p.id,p.case_id into v_portal_id,v_case_id from public.pa_portals p where p.id=new.portal_id;
  end if;
  select a into v_attachment from public.pa_gmail_message_index m
    cross join lateral jsonb_array_elements(m.attachment_metadata) a
    where m.inquiry_id=v_case_id and m.gmail_message_id=new.source_ref->>'gmail_message_id'
      and a->>'id'=new.source_ref->>'gmail_attachment_id' limit 1;
  if v_attachment is not null and char_length(coalesce(v_attachment->>'part_id','')) between 1 and 1000 then
    v_key='gmail:message-part:v1:'||encode(sha256(convert_to('gmail'||chr(31)||(new.source_ref->>'gmail_message_id')||chr(31)||(v_attachment->>'part_id'),'UTF8')),'hex');
    new.source_provider='gmail'; new.gmail_part_id=v_attachment->>'part_id'; new.canonical_attachment_key=v_key;
    new.source_byte_size=coalesce((v_attachment->>'size')::bigint,0);
    perform pg_advisory_xact_lock(hashtextextended(v_portal_id::text||chr(31)||v_key,0));
    if exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id
      where c.portal_id=v_portal_id and v.canonical_attachment_key=v_key and (tg_table_name<>'pa_portal_document_versions' or v.id<>new.id))
      or exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal_id and p.canonical_attachment_key=v_key
        and (tg_table_name<>'pa_portal_photo_items' or p.id<>new.id)) then raise exception 'portal_source_already_used'; end if;
  end if;
  return new;
end;
$$;

do $$ begin
  if not exists(select 1 from pg_trigger where tgname='pa_portal_versions_fill_canonical_identity') then
    create trigger pa_portal_versions_fill_canonical_identity before insert on public.pa_portal_document_versions
    for each row execute function public.pa_portal_fill_canonical_identity();
  end if;
  if not exists(select 1 from pg_trigger where tgname='pa_portal_photos_fill_canonical_identity') then
    create trigger pa_portal_photos_fill_canonical_identity before insert on public.pa_portal_photo_items
    for each row execute function public.pa_portal_fill_canonical_identity();
  end if;
end $$;

create or replace function public.pa_portal_candidate_detect(p_case_id uuid,p_actor_id uuid,p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_portal public.pa_portals%rowtype; v_message public.pa_gmail_message_index%rowtype; v_attachment jsonb; v_item jsonb;
  v_candidate public.pa_portal_document_candidates%rowtype; v_candidate_id uuid; v_card_id uuid; v_filename text; v_mime text;
  v_category text; v_action text; v_confidence text; v_part text; v_key text; v_expected_key text; v_before jsonb; v_after jsonb;
  v_inserted integer:=0; v_business_excluded integer:=0; v_signature_excluded integer:=0; v_recalculated integer:=0;
  v_size bigint; v_inline boolean;
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
    if jsonb_typeof(v_item)<>'object' or coalesce(v_item->>'gmail_message_id','') !~ '^[A-Za-z0-9_-]{1,200}$'
      or char_length(coalesce(v_item->>'gmail_attachment_id','')) not between 1 and 1000 then raise exception 'invalid_candidate_detection'; end if;
    select m.* into v_message from public.pa_gmail_message_index m
    join public.pa_gmail_thread_links l on l.inquiry_id=m.inquiry_id and l.gmail_thread_id=m.gmail_thread_id
    where m.inquiry_id=p_case_id and m.gmail_message_id=v_item->>'gmail_message_id';
    if not found then continue; end if;
    select a into v_attachment from jsonb_array_elements(v_message.attachment_metadata) a where a->>'id'=v_item->>'gmail_attachment_id' limit 1;
    if v_attachment is null then continue; end if;
    v_filename=btrim(coalesce(v_attachment->>'filename','')); v_mime=lower(split_part(coalesce(v_attachment->>'mime_type',''),';',1));
    if v_mime not in ('application/pdf','image/jpeg','image/png','image/webp') then
      v_mime=case when v_filename ~* '\.pdf$' then 'application/pdf' when v_filename ~* '\.png$' then 'image/png' when v_filename ~* '\.webp$' then 'image/webp' when v_filename ~* '\.jpe?g$' then 'image/jpeg' else '' end;
    end if;
    if char_length(v_filename) not between 1 and 255 or v_mime not in ('application/pdf','image/jpeg','image/png','image/webp') then continue; end if;
    if v_filename ~* '(見積|estimate|quotation|契約|contract|請求|invoice|領収|receipt|支払|payment)' then v_business_excluded=v_business_excluded+1; continue; end if;
    v_size=case when coalesce(v_attachment->>'size','') ~ '^[0-9]+$' then (v_attachment->>'size')::bigint else 0 end;
    v_inline=(case when lower(coalesce(v_attachment->>'inline','')) in ('true','false') then (v_attachment->>'inline')::boolean else false end) or coalesce(v_attachment->>'content_id','')<>'' or coalesce(v_attachment->>'content_disposition','') ~* '^inline(?:;|$)';
    if v_mime like 'image/%' and ((v_size between 1 and 4096) or (v_inline and v_filename ~* '(^|[._ -])(logo|signature|sig|facebook|instagram|twitter|x-icon|linkedin|youtube|social|icon|pixel|spacer|tracker|tracking|qr)([._ -]|$)' and (v_size=0 or v_size<=204800))) then v_signature_excluded=v_signature_excluded+1; continue; end if;

    v_part=nullif(v_item->>'gmail_part_id',''); v_key=nullif(v_item->>'canonical_attachment_key','');
    if v_part is not null or v_key is not null then
      v_expected_key='gmail:message-part:v1:'||encode(sha256(convert_to('gmail'||chr(31)||v_message.gmail_message_id||chr(31)||v_part,'UTF8')),'hex');
      if char_length(coalesce(v_part,'')) not between 1 and 1000 or v_key<>v_expected_key or v_attachment->>'part_id'<>v_part then raise exception 'invalid_canonical_identity'; end if;
    end if;
    if exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id
      where c.portal_id=v_portal.id and ((v.source_ref->>'gmail_message_id'=v_message.gmail_message_id and v.source_ref->>'gmail_attachment_id'=v_item->>'gmail_attachment_id') or (v_key is not null and v.canonical_attachment_key=v_key)))
      or exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and ((p.source_ref->>'gmail_message_id'=v_message.gmail_message_id and p.source_ref->>'gmail_attachment_id'=v_item->>'gmail_attachment_id') or (v_key is not null and p.canonical_attachment_key=v_key))) then continue; end if;

    v_category=v_item->>'suggested_category'; v_action=v_item->>'suggested_action'; v_confidence=v_item->>'confidence';
    if v_category not in ('timetable','script','layout','photo','performer','other') or v_action not in ('add_new_version','create_new_card','add_photo','hold_performer')
      or v_confidence not in ('high','medium','low') or char_length(btrim(coalesce(v_item->>'suggested_title',''))) not between 1 and 160
      or char_length(btrim(coalesce(v_item->>'suggestion_basis',''))) not between 1 and 500 then raise exception 'invalid_candidate_suggestion'; end if;
    v_card_id=null;
    if nullif(v_item->>'suggested_card_id','') is not null then
      select id into v_card_id from public.pa_portal_document_cards where id=(v_item->>'suggested_card_id')::uuid and portal_id=v_portal.id and category=v_category and archived_at is null;
      if not found then raise exception 'candidate_case_mismatch'; end if;
    elsif v_category in ('timetable','script') then select id into v_card_id from public.pa_portal_document_cards where portal_id=v_portal.id and category=v_category and card_kind='fixed' and archived_at is null limit 1;
    end if;

    select * into v_candidate from public.pa_portal_document_candidates d where d.portal_id=v_portal.id
      and ((v_key is not null and d.canonical_attachment_key=v_key) or (d.gmail_message_id=v_message.gmail_message_id and d.gmail_attachment_id=v_item->>'gmail_attachment_id'))
      order by (d.canonical_attachment_key=v_key) desc limit 1 for update;
    if found then
      if v_candidate.status='pending' then
        v_before=jsonb_build_object('category',v_candidate.suggested_category,'action',v_candidate.suggested_action,'card_id',v_candidate.suggested_card_id,'title',v_candidate.suggested_title,'confidence',v_candidate.confidence);
        v_after=jsonb_build_object('category',v_category,'action',v_action,'card_id',v_card_id,'title',btrim(v_item->>'suggested_title'),'confidence',v_confidence);
        update public.pa_portal_document_candidates set gmail_attachment_id=v_item->>'gmail_attachment_id',source_provider=case when v_key is null then source_provider else 'gmail' end,
          gmail_part_id=coalesce(v_part,gmail_part_id),canonical_attachment_key=coalesce(v_key,canonical_attachment_key),source_byte_size=nullif(v_size,0),
          suggested_category=v_category,suggested_card_id=v_card_id,suggested_action=v_action,suggested_title=btrim(v_item->>'suggested_title'),confidence=v_confidence,suggestion_basis=btrim(v_item->>'suggestion_basis'),updated_at=now()
          where id=v_candidate.id;
        if v_before is distinct from v_after then
          insert into public.pa_portal_candidate_system_audit(candidate_id,portal_id,actor_id,action,event_key,before_state,after_state,detail)
          values(v_candidate.id,v_portal.id,p_actor_id,'SUGGESTION_RECALCULATED','suggestion:'||encode(sha256(convert_to(v_after::text,'UTF8')),'hex'),v_before,v_after,jsonb_build_object('reason','classification_rules_calibrated')) on conflict do nothing;
          v_recalculated=v_recalculated+1;
        end if;
      end if;
      continue;
    end if;
    insert into public.pa_portal_document_candidates(portal_id,case_id,source_type,source_direction,gmail_message_id,gmail_attachment_id,display_filename,mime_type,source_created_at,source_subject,source_sender,suggested_category,suggested_card_id,suggested_action,suggested_title,confidence,suggestion_basis,source_provider,gmail_part_id,canonical_attachment_key,source_byte_size)
    values(v_portal.id,p_case_id,case when v_message.message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end,v_message.direction,v_message.gmail_message_id,v_item->>'gmail_attachment_id',v_filename,v_mime,coalesce(v_message.received_at,v_message.sent_at,v_message.indexed_at),v_message.subject,v_message.from_address,v_category,v_card_id,v_action,btrim(v_item->>'suggested_title'),v_confidence,btrim(v_item->>'suggestion_basis'),case when v_key is null then null else 'gmail' end,v_part,v_key,nullif(v_size,0)) returning id into v_candidate_id;
    v_inserted=v_inserted+1;
    insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,detail) values(v_candidate_id,v_portal.id,p_actor_id,'DETECTED',jsonb_build_object('source_direction',v_message.direction,'source_type',case when v_message.message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end));
    insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,after_target) values(v_candidate_id,v_portal.id,p_actor_id,'SUGGESTED',jsonb_build_object('category',v_category,'action',v_action,'card_id',v_card_id,'title',btrim(v_item->>'suggested_title'),'confidence',v_confidence));
  end loop;
  return jsonb_build_object('detected',v_inserted,'pending',(select count(*) from public.pa_portal_document_candidates where portal_id=v_portal.id and status='pending'),'business_excluded',v_business_excluded,'signature_excluded',v_signature_excluded,'suggestions_recalculated',v_recalculated);
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
    'pending_count',(select count(*) from public.pa_portal_document_candidates d where d.portal_id=v_portal.id and d.status='pending'
      and not exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where c.portal_id=v_portal.id and ((v.source_ref->>'gmail_message_id'=d.gmail_message_id and v.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id) or (d.canonical_attachment_key is not null and v.canonical_attachment_key=d.canonical_attachment_key)))
      and not exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and ((p.source_ref->>'gmail_message_id'=d.gmail_message_id and p.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id) or (d.canonical_attachment_key is not null and p.canonical_attachment_key=d.canonical_attachment_key)))),
    'candidates',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'source_type',d.source_type,'source_direction',d.source_direction,'display_filename',d.display_filename,'mime_type',d.mime_type,'source_created_at',d.source_created_at,'source_subject',d.source_subject,'source_sender',d.source_sender,'detected_at',d.detected_at,'suggested_category',d.suggested_category,'suggested_card_id',d.suggested_card_id,'suggested_action',d.suggested_action,'suggested_title',d.suggested_title,'confidence',d.confidence,'suggestion_basis',d.suggestion_basis) order by d.detected_at desc)
      from public.pa_portal_document_candidates d where d.portal_id=v_portal.id and d.status='pending'
      and not exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where c.portal_id=v_portal.id and ((v.source_ref->>'gmail_message_id'=d.gmail_message_id and v.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id) or (d.canonical_attachment_key is not null and v.canonical_attachment_key=d.canonical_attachment_key)))
      and not exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and ((p.source_ref->>'gmail_message_id'=d.gmail_message_id and p.source_ref->>'gmail_attachment_id'=d.gmail_attachment_id) or (d.canonical_attachment_key is not null and p.canonical_attachment_key=d.canonical_attachment_key)))),'[]'::jsonb),
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
  select * into v_candidate from public.pa_portal_document_candidates where id=p_candidate_id and case_id=p_case_id and status='pending';
  if not found then raise exception 'candidate_case_mismatch'; end if;
  if not exists(select 1 from public.pa_gmail_message_index m join public.pa_gmail_thread_links l on l.inquiry_id=m.inquiry_id and l.gmail_thread_id=m.gmail_thread_id cross join lateral jsonb_array_elements(m.attachment_metadata) a where m.inquiry_id=p_case_id and m.gmail_message_id=v_candidate.gmail_message_id and a->>'id'=v_candidate.gmail_attachment_id and a->>'filename'=v_candidate.display_filename and (case when lower(split_part(coalesce(a->>'mime_type',''),';',1)) in ('application/pdf','image/jpeg','image/png','image/webp') then lower(split_part(coalesce(a->>'mime_type',''),';',1)) when a->>'filename' ~* '\.pdf$' then 'application/pdf' when a->>'filename' ~* '\.png$' then 'image/png' when a->>'filename' ~* '\.webp$' then 'image/webp' when a->>'filename' ~* '\.jpe?g$' then 'image/jpeg' else '' end)=v_candidate.mime_type) then raise exception 'candidate_attachment_mismatch'; end if;
  return jsonb_build_object('source_type',v_candidate.source_type,'source_ref',jsonb_build_object('gmail_message_id',v_candidate.gmail_message_id,'gmail_attachment_id',v_candidate.gmail_attachment_id),'display_filename',v_candidate.display_filename,'mime_type',v_candidate.mime_type,'gmail_part_id',v_candidate.gmail_part_id,'canonical_attachment_key',v_candidate.canonical_attachment_key);
end;
$$;

do $outer$
begin
  if to_regclass('public.pa_portal_organizer_sessions') is not null
    and to_regclass('public.pa_portal_access_links') is not null then
    execute $definition$
      create or replace function public.pa_portal_organizer_asset(p_session_hash text,p_asset_ref text,p_asset_kind text)
      returns jsonb language plpgsql security definer set search_path='' as $function$
      declare v_session public.pa_portal_organizer_sessions%rowtype;v_link public.pa_portal_access_links%rowtype;v_portal public.pa_portals%rowtype;v_asset record;
      begin
        select * into v_session from public.pa_portal_organizer_sessions where session_hash=p_session_hash and revoked_at is null and expires_at>now();if not found then return jsonb_build_object('ok',false);end if;
        select * into v_link from public.pa_portal_access_links where id=v_session.access_link_id and revoked_at is null and (expires_at is null or expires_at>now());if not found then return jsonb_build_object('ok',false);end if;
        select * into v_portal from public.pa_portals where id=v_link.portal_id;if not found then return jsonb_build_object('ok',false);end if;
        if p_asset_kind='version' then select v.source_type,v.source_ref,v.display_filename,v.mime_type,v.gmail_part_id into v_asset from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where v.public_ref=p_asset_ref and c.portal_id=v_portal.id and v.archived_at is null;
        elsif p_asset_kind='photo' then select p.source_type,p.source_ref,p.display_filename,p.mime_type,p.gmail_part_id into v_asset from public.pa_portal_photo_items p where p.public_ref=p_asset_ref and p.portal_id=v_portal.id and p.archived_at is null;else return jsonb_build_object('ok',false);end if;
        if not found then return jsonb_build_object('ok',false);end if;
        return jsonb_build_object('ok',true,'case_id',v_portal.case_id,'source_type',v_asset.source_type,'source_ref',v_asset.source_ref,'display_filename',v_asset.display_filename,'mime_type',v_asset.mime_type,'gmail_part_id',v_asset.gmail_part_id);
      end;$function$;
    $definition$;
    execute 'revoke all on function public.pa_portal_organizer_asset(text,text,text) from public,anon,authenticated';
    execute 'grant execute on function public.pa_portal_organizer_asset(text,text,text) to service_role';
  end if;
end $outer$;

revoke all on function public.pa_portal_candidate_identity_context(uuid),public.pa_portal_candidate_reconcile(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pa_portal_candidate_identity_context(uuid),public.pa_portal_candidate_reconcile(uuid,uuid,jsonb) to service_role;
revoke all on function public.pa_portal_candidate_detect(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pa_portal_candidate_detect(uuid,uuid,jsonb) to service_role;
revoke all on function public.pa_portal_candidate_read(uuid),public.pa_portal_candidate_asset(uuid,uuid) from public,anon;
grant execute on function public.pa_portal_candidate_read(uuid),public.pa_portal_candidate_asset(uuid,uuid) to authenticated;
commit;

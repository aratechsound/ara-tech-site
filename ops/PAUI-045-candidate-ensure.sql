-- PAUI-045: REVIEW CANDIDATE ONLY. Do not apply without separate Owner DB approval.
-- Additive service-role-only insert-if-absent RPC. No existing function/table changes.
-- Existing case/thread/message/MIME-part validation and candidate audit are reused.
begin;
create or replace function public.pa_portal_candidate_ensure(p_case_id uuid,p_actor_id uuid,p_message_id text,p_thread_id text,p_items jsonb)
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
  if coalesce(p_message_id,'') !~ '^[A-Za-z0-9_-]{1,200}$' or coalesce(p_thread_id,'') !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception 'invalid_candidate_binding'; end if;
  if not exists(select 1 from public.pa_gmail_message_index m join public.pa_gmail_thread_links l on l.inquiry_id=m.inquiry_id and l.gmail_thread_id=m.gmail_thread_id where m.inquiry_id=p_case_id and m.gmail_message_id=p_message_id and m.gmail_thread_id=p_thread_id) then raise exception 'candidate_message_binding_mismatch'; end if;
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
    if not found or v_message.gmail_message_id<>p_message_id or v_message.gmail_thread_id<>p_thread_id then raise exception 'candidate_message_binding_mismatch'; end if;
    select a into v_attachment from jsonb_array_elements(v_message.attachment_metadata) a where a->>'id'=v_item->>'gmail_attachment_id' limit 1;
    if v_attachment is null then raise exception 'candidate_attachment_binding_mismatch'; end if;
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
    if v_part is null or v_key is null then raise exception 'candidate_identity_unavailable'; end if;
    if v_part is not null or v_key is not null then
      v_expected_key='gmail:message-part:v1:'||encode(sha256(convert_to('gmail'||chr(31)||v_message.gmail_message_id||chr(31)||v_part,'UTF8')),'hex');
      if char_length(coalesce(v_part,'')) not between 1 and 1000 or v_key<>v_expected_key or (v_attachment->>'part_id') is distinct from v_part then raise exception 'invalid_canonical_identity'; end if;
    end if;
    if exists(select 1 from public.pa_portal_document_candidates d where d.portal_id=v_portal.id and d.gmail_message_id=p_message_id and d.canonical_attachment_key is null and d.gmail_attachment_id<>v_item->>'gmail_attachment_id' and not exists(select 1 from jsonb_array_elements(v_message.attachment_metadata) a where a->>'id'=d.gmail_attachment_id))
      or exists(select 1 from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id where c.portal_id=v_portal.id and v.source_ref->>'gmail_message_id'=p_message_id and v.canonical_attachment_key is null and not exists(select 1 from jsonb_array_elements(v_message.attachment_metadata) a where a->>'id'=v.source_ref->>'gmail_attachment_id'))
      or exists(select 1 from public.pa_portal_photo_items p where p.portal_id=v_portal.id and p.source_ref->>'gmail_message_id'=p_message_id and p.canonical_attachment_key is null and not exists(select 1 from jsonb_array_elements(v_message.attachment_metadata) a where a->>'id'=p.source_ref->>'gmail_attachment_id')) then raise exception 'candidate_legacy_identity_unresolved'; end if;
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
      if v_candidate.gmail_message_id<>p_message_id or (v_candidate.canonical_attachment_key is not null and (v_candidate.canonical_attachment_key<>v_key or v_candidate.gmail_part_id<>v_part)) then raise exception 'candidate_identity_mismatch'; end if;
      continue; -- Every existing status, Owner suggestion and timestamp is preserved.
    end if;
    insert into public.pa_portal_document_candidates(portal_id,case_id,source_type,source_direction,gmail_message_id,gmail_attachment_id,display_filename,mime_type,source_created_at,source_subject,source_sender,suggested_category,suggested_card_id,suggested_action,suggested_title,confidence,suggestion_basis,source_provider,gmail_part_id,canonical_attachment_key,source_byte_size)
    values(v_portal.id,p_case_id,case when v_message.message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end,v_message.direction,v_message.gmail_message_id,v_item->>'gmail_attachment_id',v_filename,v_mime,coalesce(v_message.received_at,v_message.sent_at,v_message.indexed_at),v_message.subject,v_message.from_address,v_category,v_card_id,v_action,btrim(v_item->>'suggested_title'),v_confidence,btrim(v_item->>'suggestion_basis'),case when v_key is null then null else 'gmail' end,v_part,v_key,nullif(v_size,0)) on conflict do nothing returning id into v_candidate_id;
    if v_candidate_id is null then continue; end if;
    v_inserted=v_inserted+1;
    insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,detail) values(v_candidate_id,v_portal.id,p_actor_id,'DETECTED',jsonb_build_object('source_direction',v_message.direction,'source_type',case when v_message.message_source='pa_case_manager' then 'pa_attachment' else 'gmail_attachment' end));
    insert into public.pa_portal_candidate_audit(candidate_id,portal_id,actor_id,action,after_target) values(v_candidate_id,v_portal.id,p_actor_id,'SUGGESTED',jsonb_build_object('category',v_category,'action',v_action,'card_id',v_card_id,'title',btrim(v_item->>'suggested_title'),'confidence',v_confidence));
  end loop;
  return jsonb_build_object('detected',v_inserted,'pending',(select count(*) from public.pa_portal_document_candidates where portal_id=v_portal.id and status='pending'),'business_excluded',v_business_excluded,'signature_excluded',v_signature_excluded,'suggestions_recalculated',v_recalculated);
end;
$$;
revoke all on function public.pa_portal_candidate_ensure(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.pa_portal_candidate_ensure(uuid,uuid,text,text,jsonb) to service_role;
commit;

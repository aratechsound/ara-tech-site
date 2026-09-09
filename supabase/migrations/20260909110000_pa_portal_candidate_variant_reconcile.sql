-- PA event document portal Phase 1.2C-R1 follow-up
-- A pending candidate can carry a third historical Gmail attachment-ID variant.
-- Reconcile it only when the internal bounded loader proves its bytes equal the
-- registered asset and the current message-part attachment.

begin;

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
  if not found then return jsonb_build_object('registered','[]'::jsonb,'pending_candidates','[]'::jsonb); end if;
  return jsonb_build_object(
    'registered',coalesce((
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
    ),'[]'::jsonb),
    'pending_candidates',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',d.id,'status',d.status,'gmail_message_id',d.gmail_message_id,
        'gmail_attachment_id',d.gmail_attachment_id,'display_filename',d.display_filename,
        'mime_type',d.mime_type,'canonical_attachment_key',d.canonical_attachment_key
      ) order by d.detected_at,d.id)
      from public.pa_portal_document_candidates d
      where d.portal_id=v_portal.id and d.status='pending'
    ),'[]'::jsonb)
  );
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
  v_candidate_match jsonb; v_candidate_matches jsonb;
  v_kind text; v_asset_id uuid; v_message text; v_historical text; v_current text; v_part text; v_key text;
  v_filename text; v_mime text; v_hash text; v_proof text; v_expected_key text; v_existing_key text; v_existing_hash text;
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
    v_candidate_matches=coalesce(v_mapping->'candidate_matches','[]'::jsonb);
    v_expected_key='gmail:message-part:v1:'||encode(sha256(convert_to('gmail'||chr(31)||v_message||chr(31)||v_part,'UTF8')),'hex');
    if v_kind not in ('version','photo') or v_message !~ '^[A-Za-z0-9_-]{1,200}$'
      or char_length(v_historical) not between 1 and 1000 or char_length(v_current) not between 1 and 1000
      or char_length(v_part) not between 1 and 1000 or v_key<>v_expected_key
      or char_length(v_filename) not between 1 and 255
      or v_mime not in ('application/pdf','image/jpeg','image/png','image/webp')
      or coalesce((v_mapping->>'source_byte_size')::bigint,0) not between 1 and 10485760
      or v_proof not in ('exact_attachment_identity','same_message_content_sha256','registered_canonical_identity')
      or (v_proof='same_message_content_sha256' and coalesce(v_hash,'') !~ '^[a-f0-9]{64}$')
      or jsonb_typeof(v_candidate_matches)<>'array' or jsonb_array_length(v_candidate_matches)>500
      then raise exception 'invalid_identity_mapping'; end if;
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
      select v.canonical_attachment_key,v.source_content_sha256 into v_existing_key,v_existing_hash
      from public.pa_portal_document_versions v join public.pa_portal_document_cards c on c.id=v.card_id
      where v.id=v_asset_id and c.portal_id=v_portal.id and v.archived_at is null
        and v.source_type in ('gmail_attachment','pa_attachment')
        and v.source_ref->>'gmail_message_id'=v_message and v.source_ref->>'gmail_attachment_id'=v_historical
        and v.display_filename=v_filename and v.mime_type=v_mime for update of v;
      if not found or (v_existing_key is not null and v_existing_key<>v_key)
        or (v_proof='registered_canonical_identity' and (v_existing_key<>v_key
          or (v_hash is not null and v_existing_hash is distinct from v_hash))) then raise exception 'identity_registered_asset_mismatch'; end if;
      update public.pa_portal_document_versions set source_provider='gmail',gmail_part_id=v_part,
        canonical_attachment_key=v_key,source_content_sha256=coalesce(v_hash,source_content_sha256),source_byte_size=(v_mapping->>'source_byte_size')::bigint
        where id=v_asset_id;
    else
      select p.canonical_attachment_key,p.source_content_sha256 into v_existing_key,v_existing_hash
      from public.pa_portal_photo_items p where p.id=v_asset_id and p.portal_id=v_portal.id and p.archived_at is null
        and p.source_type in ('gmail_attachment','pa_attachment')
        and p.source_ref->>'gmail_message_id'=v_message and p.source_ref->>'gmail_attachment_id'=v_historical
        and p.display_filename=v_filename and p.mime_type=v_mime for update;
      if not found or (v_existing_key is not null and v_existing_key<>v_key)
        or (v_proof='registered_canonical_identity' and (v_existing_key<>v_key
          or (v_hash is not null and v_existing_hash is distinct from v_hash))) then raise exception 'identity_registered_asset_mismatch'; end if;
      update public.pa_portal_photo_items set source_provider='gmail',gmail_part_id=v_part,
        canonical_attachment_key=v_key,source_content_sha256=coalesce(v_hash,source_content_sha256),source_byte_size=(v_mapping->>'source_byte_size')::bigint
        where id=v_asset_id;
    end if;

    for v_candidate in select * from public.pa_portal_document_candidates d
      where d.portal_id=v_portal.id and d.status='pending' and d.gmail_message_id=v_message
        and d.display_filename=v_filename and d.mime_type=v_mime
        and (d.gmail_attachment_id=v_current or d.canonical_attachment_key=v_key
          or exists(select 1 from jsonb_array_elements(v_candidate_matches) cm
            where cm->>'candidate_id'=d.id::text and cm->>'gmail_attachment_id'=d.gmail_attachment_id))
      for update
    loop
      if v_candidate.gmail_attachment_id<>v_current and v_candidate.canonical_attachment_key is distinct from v_key then
        select value into v_candidate_match from jsonb_array_elements(v_candidate_matches)
          where value->>'candidate_id'=v_candidate.id::text
            and value->>'gmail_attachment_id'=v_candidate.gmail_attachment_id limit 1;
        if not found or v_candidate_match->>'proof_type'<>'same_message_content_sha256'
          or coalesce(v_candidate_match->>'content_sha256','') !~ '^[a-f0-9]{64}$'
          or v_hash is null or v_candidate_match->>'content_sha256'<>v_hash
          then raise exception 'identity_candidate_variant_mismatch'; end if;
      end if;
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
        canonical_attachment_key=v_key,source_content_sha256=coalesce(v_hash,source_content_sha256),source_byte_size=(v_mapping->>'source_byte_size')::bigint,
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

revoke all on function public.pa_portal_candidate_identity_context(uuid),public.pa_portal_candidate_reconcile(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pa_portal_candidate_identity_context(uuid),public.pa_portal_candidate_reconcile(uuid,uuid,jsonb) to service_role;

commit;

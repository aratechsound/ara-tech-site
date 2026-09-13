-- PA-EST-004R10: preserve the server-recovered Gmail original filename when
-- importing an estimate. The indexed attachment identity and MIME remain the
-- database authorization boundary; the filename is resolved from the freshly
-- fetched, case-bound Gmail part by the existing commercial function.
begin;

create or replace function public.pa_v5_import_sent_estimate(
  p_actor uuid,p_case uuid,p_expected_revision bigint,p_expected_current uuid,p_operation uuid,
  p_mode text,p_document_id uuid,p_filename text,p_content_base64 text,p_sha256 text,
  p_amount_minor bigint,p_currency text,p_tax_basis text,p_conditions jsonb,
  p_gmail_message_id text,p_gmail_attachment_id text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_case public.pa_inquiries%rowtype; v_state public.pa_case_commercial_state%rowtype;
  v_message public.pa_gmail_message_index%rowtype; v_attachment jsonb; v_bytes bytea;
  v_existing_evidence public.pa_estimate_delivery_evidence%rowtype;
  v_existing_estimate public.pa_estimate_revisions%rowtype; v_id uuid:=gen_random_uuid();
  v_number integer; v_count integer:=0; v_recipient text; v_source_sent_at timestamptz;
begin
  perform public.pa_v5_assert_admin(p_actor);
  if p_operation is null or p_mode not in ('current','historical') or p_amount_minor<=0
    or p_currency !~ '^[A-Z]{3}$' or p_tax_basis not in ('tax_included','tax_excluded','tax_exempt')
    or jsonb_typeof(p_conditions)<>'object' or char_length(p_filename) not between 1 and 500
    then raise exception 'invalid_estimate_recovery'; end if;
  select * into v_existing_evidence from public.pa_estimate_delivery_evidence where operation_id=p_operation;
  if found then
    if v_existing_evidence.inquiry_id<>p_case or v_existing_evidence.gmail_message_id<>p_gmail_message_id
      or v_existing_evidence.gmail_attachment_id<>p_gmail_attachment_id or v_existing_evidence.registration_mode<>p_mode
      or v_existing_evidence.requested_document_id<>p_document_id
      or not exists(select 1 from public.pa_estimate_revisions e join public.pa_commercial_documents d on d.id=e.document_id
        where e.id=v_existing_evidence.estimate_revision_id and e.inquiry_id=p_case and d.original_filename=p_filename
          and d.sha256=p_sha256 and e.amount_minor=p_amount_minor and e.currency=p_currency and e.tax_basis=p_tax_basis
          and e.conditions_snapshot=p_conditions) then raise exception 'idempotency_payload_mismatch'; end if;
    return jsonb_build_object('id',v_existing_evidence.estimate_revision_id,'already_committed',true,'delivery_evidence_id',v_existing_evidence.id);
  end if;
  select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update;
  if not found or v_case.status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
  v_state:=public.pa_v5_state(p_case);
  if v_state.revision<>p_expected_revision or v_state.current_estimate_revision_id is distinct from p_expected_current then raise exception 'commercial_state_changed'; end if;
  if p_mode='current' and exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'post_contract_change_required'; end if;
  select * into v_message from public.pa_gmail_message_index
    where inquiry_id=p_case and gmail_message_id=p_gmail_message_id and direction='outbound'
      and message_source in ('gmail_direct','pa_case_manager') for share;
  if not found then raise exception 'invalid_estimate_recovery'; end if;
  select a into v_attachment from jsonb_array_elements(v_message.attachment_metadata) a
    where a->>'id'=p_gmail_attachment_id limit 1;
  -- p_filename is deliberately not compared with the historical index value.
  -- It is supplied only by the server after re-reading this exact bound Gmail
  -- part, which allows a formerly mangled display name to be restored without
  -- rewriting the legacy message-index row.
  if v_attachment is null or lower(split_part(coalesce(v_attachment->>'mime_type',''),';',1))<>'application/pdf'
    then raise exception 'invalid_estimate_recovery'; end if;
  select value #>> '{}' into v_recipient from jsonb_array_elements(v_message.to_addresses) limit 1;
  if coalesce(v_recipient,'') not like '%@%' then raise exception 'invalid_estimate_recovery'; end if;
  v_source_sent_at:=coalesce(v_message.sent_at,v_message.indexed_at);
  select * into v_existing_evidence from public.pa_estimate_delivery_evidence
    where inquiry_id=p_case and gmail_message_id=p_gmail_message_id and gmail_attachment_id=p_gmail_attachment_id;
  if found then return jsonb_build_object('id',v_existing_evidence.estimate_revision_id,'duplicate',true,'delivery_evidence_id',v_existing_evidence.id); end if;
  v_bytes:=decode(p_content_base64,'base64');
  if p_document_id is null or octet_length(v_bytes)<20 or encode(sha256(v_bytes),'hex')<>p_sha256 then raise exception 'document_identity_mismatch'; end if;
  select e.* into v_existing_estimate from public.pa_estimate_revisions e
  join public.pa_commercial_documents d on d.id=e.document_id and d.inquiry_id=e.inquiry_id
    where e.inquiry_id=p_case and e.series='pre_contract' and d.sha256=p_sha256
      and e.amount_minor=p_amount_minor and e.currency=p_currency and e.tax_basis=p_tax_basis
      and e.conditions_snapshot=p_conditions
      and not exists(select 1 from public.pa_estimate_import_corrections c where c.estimate_revision_id=e.id)
    order by e.issued_at desc limit 1;
  if not found then
    select coalesce(max(revision_number),0)+1 into v_number from public.pa_estimate_revisions where inquiry_id=p_case and series='pre_contract';
    insert into public.pa_commercial_documents(id,inquiry_id,document_kind,source_kind,gmail_message_id,gmail_attachment_id,original_filename,mime_type,content,sha256,metadata,created_by)
      values(p_document_id,p_case,'estimate','sent_recovery',p_gmail_message_id,p_gmail_attachment_id,p_filename,'application/pdf',v_bytes,p_sha256,jsonb_build_object('source_sent_at',v_source_sent_at),p_actor);
    insert into public.pa_estimate_revisions(id,inquiry_id,revision_number,document_id,amount_minor,currency,tax_basis,conditions_snapshot,source_kind,lifecycle,source_sent_at,issued_by,operation_id)
      values(v_id,p_case,v_number,p_document_id,p_amount_minor,p_currency,p_tax_basis,p_conditions,'sent_recovery',case when p_mode='historical' then 'historical' else 'issued' end,v_source_sent_at,p_actor,p_operation)
      returning * into v_existing_estimate;
  else v_id:=v_existing_estimate.id; end if;
  insert into public.pa_estimate_delivery_evidence(id,inquiry_id,estimate_revision_id,gmail_message_id,gmail_attachment_id,registration_mode,requested_document_id,recipient,source_sent_at,operation_id,recorded_by)
    values(gen_random_uuid(),p_case,v_existing_estimate.id,p_gmail_message_id,p_gmail_attachment_id,p_mode,p_document_id,v_recipient,v_source_sent_at,p_operation,p_actor)
    returning * into v_existing_evidence;
  if p_mode='current' and v_state.current_estimate_revision_id is distinct from v_existing_estimate.id then
    for v_attachment in select jsonb_build_object('offer_id',t.offer_id) x from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=p_case and t.state='active' for update of t loop
      update public.pa_contract_tokens set state='revoked' where offer_id=(v_attachment->>'offer_id')::uuid;
      update public.pa_commercial_outbox set state='cancelled',finished_at=now(),last_error_code='estimate_superseded'
        where aggregate_id=(v_attachment->>'offer_id')::uuid and state in ('queued','failed');
      v_count:=v_count+1;
    end loop;
    update public.pa_case_commercial_state set current_estimate_revision_id=v_existing_estimate.id,estimate_change_state='ready',revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
  end if;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
    values(p_case,p_actor,case when p_mode='current' then 'sent_estimate_recovered_current' else 'sent_estimate_recovered_historical' end,
      jsonb_build_object('estimate_revision_id',v_existing_estimate.id,'gmail_message_id',p_gmail_message_id,'gmail_attachment_id',p_gmail_attachment_id,'source_sent_at',v_source_sent_at,'recorded_at',now(),'revoked_confirmations',v_count,'operation_id',p_operation));
  return jsonb_build_object('id',v_existing_estimate.id,'revision_number',v_existing_estimate.revision_number,'delivery_evidence_id',v_existing_evidence.id,'current',p_mode='current','linked_resend',v_id=v_existing_estimate.id and v_existing_estimate.operation_id<>p_operation,'revoked_confirmations',v_count,'already_committed',false);
end $$;

revoke all on function public.pa_v5_import_sent_estimate(uuid,uuid,bigint,uuid,uuid,text,uuid,text,text,text,bigint,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.pa_v5_import_sent_estimate(uuid,uuid,bigint,uuid,uuid,text,uuid,text,text,text,bigint,text,text,jsonb,text,text) to service_role;

commit;

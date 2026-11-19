begin;

create or replace function public.pa_v5_issue_estimate(
  p_actor uuid,p_case uuid,p_expected_revision bigint,p_expected_current uuid,p_operation uuid,
  p_document_id uuid,p_filename text,p_mime text,p_content_base64 text,p_sha256 text,
  p_amount_minor bigint,p_currency text,p_tax_basis text,p_conditions jsonb,p_source_kind text,p_source_sent_at timestamptz,
  p_recipient text,p_subject text,p_body text,p_reply_binding jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_case public.pa_inquiries%rowtype; v_state public.pa_case_commercial_state%rowtype; v_existing public.pa_estimate_revisions%rowtype; v_id uuid:=gen_random_uuid(); v_number integer; v_bytes bytea; v_outbox uuid:=gen_random_uuid();
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_existing from public.pa_estimate_revisions where operation_id=p_operation;
  if found then return jsonb_build_object('id',v_existing.id,'revision_number',v_existing.revision_number,'already_committed',true); end if;
  if p_document_id is null or p_operation is null or p_amount_minor<=0 or p_currency!~'^[A-Z]{3}$'
    or p_tax_basis not in ('tax_included','tax_excluded','tax_exempt') or p_source_kind not in ('managed_send','sent_recovery')
    or jsonb_typeof(p_conditions)<>'object' or jsonb_typeof(p_reply_binding)<>'object' then raise exception 'invalid_estimate'; end if;
  v_bytes:=decode(p_content_base64,'base64');
  if encode(sha256(v_bytes),'hex')<>p_sha256 then raise exception 'document_identity_mismatch'; end if;
  select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update;
  if not found or v_case.status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
  v_state:=public.pa_v5_state(p_case);
  if v_state.revision<>p_expected_revision or v_state.current_estimate_revision_id is distinct from p_expected_current then raise exception 'commercial_state_changed'; end if;
  if exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'post_contract_change_required'; end if;
  -- Only deliveries competing with this operation/current revision can stop it.
  -- Keep ambiguous provider failures and related expired processing leases on hold.
  if exists(select 1 from public.pa_commercial_outbox x where x.inquiry_id=p_case
    and (x.operation_id=p_operation
      or (x.job_kind='estimate' and x.aggregate_id=p_expected_current)
      or (x.job_kind in ('confirmation','confirmation_reminder') and exists(
        select 1 from public.pa_contract_offers o where o.id=x.aggregate_id
          and o.inquiry_id=p_case and o.estimate_revision_id=p_expected_current)))
    and public.pa_commercial_delivery_requires_review(x))
  then raise exception 'delivery_outcome_unresolved'; end if;
  -- The case lock serializes this check with confirmation issuance and revision start.
  -- Estimate issuance preserves an active confirmation and requires a separate revocation.
  if exists (
    select 1 from public.pa_contract_tokens t
    join public.pa_contract_offers o on o.id=t.offer_id
    where o.inquiry_id=p_case and t.state='active'
  ) then raise exception 'confirmation_already_active'; end if;
  select coalesce(max(revision_number),0)+1 into v_number from public.pa_estimate_revisions where inquiry_id=p_case and series='pre_contract';
  insert into public.pa_commercial_documents(id,inquiry_id,document_kind,source_kind,original_filename,mime_type,content,sha256,metadata,created_by)
    values(p_document_id,p_case,'estimate',p_source_kind,p_filename,p_mime,v_bytes,p_sha256,jsonb_build_object('source_sent_at',p_source_sent_at),p_actor);
  insert into public.pa_estimate_revisions(id,inquiry_id,revision_number,document_id,amount_minor,currency,tax_basis,conditions_snapshot,source_kind,source_sent_at,issued_by,operation_id)
    values(v_id,p_case,v_number,p_document_id,p_amount_minor,p_currency,p_tax_basis,p_conditions,p_source_kind,p_source_sent_at,p_actor,p_operation);
  update public.pa_case_commercial_state set current_estimate_revision_id=v_id,estimate_change_state='ready',revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
  if coalesce(p_reply_binding->>'confirmation_mode','LEGACY') not in ('LEGACY','DIRECT_CONFIRM_WITH_ESTIMATE')
    or (p_reply_binding->>'confirmation_mode'='DIRECT_CONFIRM_WITH_ESTIMATE' and (p_source_kind<>'managed_send' or p_source_sent_at is not null))
  then raise exception 'invalid_estimate'; end if;
  if p_source_kind='managed_send' and coalesce(p_reply_binding->>'confirmation_mode','LEGACY')='LEGACY' then
    insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids)
      values(v_outbox,p_case,p_operation,'estimate',v_id,p_recipient,p_subject,p_body,p_reply_binding,array[p_document_id]);
  else
    v_outbox:=null;
  end if;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'estimate_revision_issued',jsonb_build_object('estimate_revision_id',v_id,'revision_number',v_number,'amount_minor',p_amount_minor,'currency',p_currency,'document_sha256',p_sha256,'operation_id',p_operation));
  return jsonb_build_object('id',v_id,'revision_number',v_number,'outbox_id',v_outbox,'already_committed',false);
end $$;

commit;

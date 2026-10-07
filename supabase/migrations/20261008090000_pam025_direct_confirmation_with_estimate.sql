begin;
-- PAM-025 local migration candidate. No table/column or API signature changes.
-- Current main DB functions copied with scoped changes; no Production apply.
-- Existing SECURITY DEFINER privileges are preserved by CREATE OR REPLACE.
-- Preview remains read-only. Delivery is projected from the one confirmation
-- outbox row; immutable estimate/source snapshots are never rewritten.
create or replace function public.pa_v5_issue_estimate(
  p_actor uuid,p_case uuid,p_expected_revision bigint,p_expected_current uuid,p_operation uuid,
  p_document_id uuid,p_filename text,p_mime text,p_content_base64 text,p_sha256 text,
  p_amount_minor bigint,p_currency text,p_tax_basis text,p_conditions jsonb,p_source_kind text,p_source_sent_at timestamptz,
  p_recipient text,p_subject text,p_body text,p_reply_binding jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_case public.pa_inquiries%rowtype; v_state public.pa_case_commercial_state%rowtype; v_existing public.pa_estimate_revisions%rowtype; v_id uuid:=gen_random_uuid(); v_number integer; v_bytes bytea; v_token record; v_outbox uuid:=gen_random_uuid();
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
  if exists(select 1 from public.pa_commercial_outbox where inquiry_id=p_case and state in ('processing','unknown')) then raise exception 'delivery_outcome_unresolved'; end if;
  for v_token in select t.offer_id,o.estimate_revision_id from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=p_case and t.state='active' for update of t loop
    if v_token.estimate_revision_id is null then raise exception 'legacy_confirmation_reconciliation_required'; end if;
    update public.pa_contract_tokens set state='revoked' where offer_id=v_token.offer_id;
    insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'formal_contract_revoked',jsonb_build_object('offer_id',v_token.offer_id,'reason','estimate_superseded','operation_id',p_operation));
  end loop;
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

create or replace function public.pa_v5_issue_confirmation(
 p_actor uuid,p_case uuid,p_expected_revision bigint,p_estimate uuid,p_offer uuid,p_operation uuid,
 p_token_hash text,p_secret_envelope text,p_snapshot jsonb,p_recipient text,p_subject text,p_body text,p_reply_binding jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_case public.pa_inquiries%rowtype;
 v_state public.pa_case_commercial_state%rowtype;
 v_est public.pa_estimate_revisions%rowtype;
 v_doc public.pa_commercial_documents%rowtype;
 v_version integer;
 v_now timestamptz:=clock_timestamp();
 v_expires timestamptz;
 v_snapshot jsonb;
 v_outbox uuid:=gen_random_uuid();
 v_existing public.pa_contract_offers%rowtype;
 v_contact text;
 v_display text;
 v_event_time text;
 v_estimate_sent_at timestamptz;
 v_mode text:=coalesce(p_snapshot->>'confirmation_mode','LEGACY');
 v_prior_job public.pa_commercial_outbox%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 perform 1 from public.pa_inquiries where id=p_case for update;
 select o.* into v_existing
   from public.pa_contract_offers o
   join public.pa_commercial_outbox x on x.aggregate_id=o.id
  where x.operation_id=p_operation;
 if found then
   select * into v_prior_job from public.pa_commercial_outbox where operation_id=p_operation;
   if v_existing.inquiry_id is distinct from p_case
     or coalesce(v_existing.snapshot->>'confirmation_mode','LEGACY') is distinct from v_mode
     or v_existing.snapshot->'customer_acknowledgement'->>'preview_fingerprint' is distinct from p_snapshot->'customer_acknowledgement'->>'preview_fingerprint'
   then raise exception 'idempotency_payload_mismatch'; end if;
   return jsonb_build_object('id',v_existing.id,'version',v_existing.version,'outbox_id',v_prior_job.id,'already_committed',true);
 end if;
 if v_mode not in ('LEGACY','DIRECT_CONFIRM_WITH_ESTIMATE') then raise exception 'invalid_contract'; end if;

 if p_token_hash!~'^[a-f0-9]{64}$'
   or char_length(coalesce(p_secret_envelope,''))<40
   or jsonb_typeof(p_snapshot)<>'object'
   or jsonb_typeof(p_reply_binding)<>'object'
   or p_snapshot->>'snapshot_schema_version'<>'PA-FORMAL-V5-20260914-1'
   or jsonb_typeof(p_snapshot->'customer_acknowledgement')<>'object'
   or jsonb_typeof(p_snapshot->'conditions')<>'object'
   or jsonb_typeof(p_snapshot->'cancellation_bands')<>'array'
   or jsonb_typeof(p_snapshot->'other_terms_sections')<>'array'
   or coalesce(char_length(p_snapshot->>'payment_terms'),0) not between 1 and 10000
   or coalesce(char_length(p_snapshot->>'cancellation_terms'),0) not between 1 and 10000
   or coalesce(char_length(p_snapshot->>'business_terms'),0) not between 1 and 20000
   or coalesce(char_length(p_snapshot->>'terms_text'),0) not between 1 and 30000
 then raise exception 'invalid_contract'; end if;

 select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found or v_case.status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
 if lower(btrim(coalesce(p_recipient,'')))<>lower(btrim(coalesce(v_case.email,''))) then raise exception 'invalid_contract'; end if;
 if coalesce(char_length(btrim(v_case.event_name)),0)=0 or v_case.event_date is null
   or coalesce(char_length(btrim(v_case.venue)),0)=0
   or coalesce(char_length(btrim(v_case.request_summary)),0)=0
 then raise exception 'invalid_contract'; end if;

 v_state:=public.pa_v5_state(p_case);
 if v_state.revision<>p_expected_revision or v_state.current_estimate_revision_id<>p_estimate or v_state.estimate_change_state<>'ready' then raise exception 'commercial_state_changed'; end if;
 if exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'contract_already_accepted'; end if;
 if exists(select 1 from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=p_case and t.state='active') then raise exception 'confirmation_already_active'; end if;
 -- The legacy guard remains explicit; a prepared-only estimate is not sent.
 if v_mode='LEGACY' and not (
   exists(select 1 from public.pa_estimate_revisions e where e.id=p_estimate and e.inquiry_id=p_case and e.source_kind='sent_recovery' and e.source_sent_at is not null)
   or exists(select 1 from public.pa_commercial_outbox x where x.inquiry_id=p_case and x.job_kind='estimate' and x.aggregate_id=p_estimate and x.state='sent')
   or exists(select 1 from public.pa_commercial_outbox x join public.pa_contract_offers o on o.id=x.aggregate_id
     where x.inquiry_id=p_case and o.inquiry_id=p_case and o.estimate_revision_id=p_estimate
       and o.snapshot->>'confirmation_mode'='DIRECT_CONFIRM_WITH_ESTIMATE' and x.job_kind='confirmation'
       and x.state='sent' and x.provider_message_id is not null and x.provider_thread_id is not null)
 ) then raise exception 'estimate_delivery_not_confirmed'; end if;
 if v_mode='LEGACY' and exists(select 1 from public.pa_commercial_outbox where inquiry_id=p_case and job_kind='estimate' and aggregate_id=p_estimate and state not in ('sent','cancelled')) then raise exception 'estimate_delivery_not_confirmed'; end if;
 if v_mode='DIRECT_CONFIRM_WITH_ESTIMATE' and exists(select 1 from public.pa_commercial_outbox
   where inquiry_id=p_case and job_kind='estimate' and aggregate_id=p_estimate
     and (state in ('processing','unknown') or delivery_state='unknown_after_provider_start'
       or (state='failed' and provider_request_started and (not provider_response_received or provider_http_status>=500 or provider_http_status between 200 and 299))))
 then raise exception 'delivery_outcome_unresolved'; end if;

 select * into v_est from public.pa_estimate_revisions where id=p_estimate and inquiry_id=p_case;
 if not found then raise exception 'estimate_not_found'; end if;
 select * into v_doc from public.pa_commercial_documents where id=v_est.document_id and inquiry_id=p_case;
 if not found or v_doc.sha256<>encode(sha256(v_doc.content),'hex') or v_doc.mime_type<>'application/pdf' then raise exception 'document_identity_mismatch'; end if;

 v_contact:=coalesce(nullif(btrim(v_case.contact_name),''),nullif(btrim(v_case.customer_name),''));
 if v_contact is null then raise exception 'invalid_contract'; end if;
 v_display:=concat_ws(' ',nullif(btrim(v_case.organization_name),''),v_contact);
 v_event_time:=nullif(btrim(v_case.event_time),'');
 v_estimate_sent_at:=coalesce(v_est.source_sent_at,v_est.issued_at,v_doc.created_at);
 if v_mode='DIRECT_CONFIRM_WITH_ESTIMATE' then
   if p_reply_binding->>'confirmation_mode' is distinct from v_mode
     or p_snapshot->'preview_binding'->>'case_updated_at' is null
     or (p_snapshot->'preview_binding'->>'case_updated_at')::timestamptz is distinct from v_case.updated_at
     or p_snapshot->'preview_binding'->>'estimate_id' is distinct from v_est.id::text
     or (p_snapshot->'preview_binding'->>'revision_number')::integer is distinct from v_est.revision_number
     or (p_snapshot->'preview_binding'->>'amount_minor')::bigint is distinct from v_est.amount_minor
     or p_snapshot->'preview_binding'->>'document_id' is distinct from v_doc.id::text
     or p_snapshot->'preview_binding'->>'filename' is distinct from v_doc.original_filename
     or p_snapshot->'preview_binding'->>'sha256' is distinct from v_doc.sha256
     or p_snapshot->'conditions' is distinct from v_est.conditions_snapshot
     or p_snapshot->'customer_acknowledgement'->>'estimate_revision_id' is distinct from v_est.id::text
     or (p_snapshot->'customer_acknowledgement'->>'amount_minor')::bigint is distinct from v_est.amount_minor
     or p_snapshot->'preview_binding'->>'thread_id' is distinct from p_reply_binding->>'thread_id'
     or not exists(select 1 from public.pa_gmail_thread_links where inquiry_id=p_case
       and conversation_role='primary_conversation' and gmail_thread_id=p_reply_binding->>'thread_id')
   then raise exception 'stale_confirmation_preview'; end if;
   select x.finished_at into v_estimate_sent_at from public.pa_commercial_outbox x
     left join public.pa_contract_offers o on o.id=x.aggregate_id and o.inquiry_id=p_case
     where x.inquiry_id=p_case and x.state='sent'
       and x.provider_message_id is not null and x.provider_thread_id is not null
       and ((x.job_kind='estimate' and x.aggregate_id=p_estimate)
         or (x.job_kind='confirmation' and o.estimate_revision_id=p_estimate
           and o.snapshot->>'confirmation_mode'='DIRECT_CONFIRM_WITH_ESTIMATE'
           and o.snapshot->'estimate'->>'document_id'=v_doc.id::text
           and o.snapshot->'estimate'->>'sha256'=v_doc.sha256 and x.attachment_ids=array[v_doc.id]))
     order by x.finished_at asc nulls last,x.created_at asc limit 1;
   if v_est.source_kind='sent_recovery' then v_estimate_sent_at:=v_est.source_sent_at; end if;
   -- Supersede unsent estimate-only jobs under the same case lock. A single
   -- confirmation job supplies both delivery states and provider evidence.
   update public.pa_commercial_outbox set state='cancelled',delivery_state='cancelled',finished_at=v_now,
     last_error_code='estimate_presented_with_confirmation'
     where inquiry_id=p_case and job_kind='estimate' and aggregate_id=p_estimate and state in ('queued','failed');
 end if;

 select coalesce(max(version),0)+1 into v_version from public.pa_contract_offers where inquiry_id=p_case;
 v_expires:=(((v_now at time zone 'Asia/Tokyo')::date+7)::timestamp at time zone 'Asia/Tokyo');
 v_snapshot:=jsonb_build_object(
   'snapshot_schema_version','PA-FORMAL-V5-20260914-1',
   'presentation_version',5,
   'confirmation_mode',v_mode,
   'case',jsonb_build_object(
     'event_name',btrim(v_case.event_name),'event_date',v_case.event_date,'event_time',v_event_time,
     'venue',btrim(v_case.venue),'service_scope',btrim(v_case.request_summary)),
   'customer',jsonb_build_object(
     'organization',nullif(btrim(v_case.organization_name),''),'department',null,
     'contact_name',v_contact,'display_name',v_display),
   'estimate',jsonb_build_object(
     'estimate_id',v_est.id,'revision_number',v_est.revision_number,'amount_minor',v_est.amount_minor,
     'currency',v_est.currency,'original_filename',v_doc.original_filename,'document_id',v_doc.id,
     'mime_type',v_doc.mime_type,'sha256',v_doc.sha256,'sent_at',v_estimate_sent_at),
   'terms',jsonb_build_object(
     'terms_version',p_snapshot->>'terms_version','payment_terms',p_snapshot->>'payment_terms',
     'payment_due_date',p_snapshot->>'payment_due_date','payment_summary',p_snapshot->>'payment_summary',
     'banking_day_treatment',p_snapshot->>'banking_day_treatment','transfer_fee_terms',p_snapshot->>'transfer_fee_terms',
     'cancellation_terms',p_snapshot->>'cancellation_terms','cancellation_bands',p_snapshot->'cancellation_bands',
     'weather_change_terms',p_snapshot->>'weather_change_terms','invoice_terms',p_snapshot->>'invoice_terms',
     'payment_consult_terms',p_snapshot->>'payment_consult_terms','business_terms',p_snapshot->>'business_terms',
     'other_terms_sections',p_snapshot->'other_terms_sections','terms_text',p_snapshot->>'terms_text'),
   'issuance',jsonb_build_object('issued_at',v_now,'expires_at',v_expires),
   'customer_acknowledgement',p_snapshot->'customer_acknowledgement',
   'conditions',p_snapshot->'conditions',
   -- Flat aliases are retained only for established internal/admin consumers.
   'event_name',btrim(v_case.event_name),'event_date',v_case.event_date,'recipient',btrim(v_case.email),
   'customer_name',v_display,'confirmer_name',v_contact,'amount',v_est.amount_minor,'amount_minor',v_est.amount_minor,
   'currency',v_est.currency,'order_scope',jsonb_build_object('performance_time',v_event_time,'venue',btrim(v_case.venue),'services',btrim(v_case.request_summary)),
   'request_summary',btrim(v_case.request_summary),'payment_due_date',p_snapshot->>'payment_due_date',
   'payment_summary',p_snapshot->>'payment_summary','payment_terms',p_snapshot->>'payment_terms',
   'cancellation_terms',p_snapshot->>'cancellation_terms','cancellation_bands',p_snapshot->'cancellation_bands',
   'business_terms',p_snapshot->>'business_terms','other_terms_sections',p_snapshot->'other_terms_sections',
   'terms_text',p_snapshot->>'terms_text',
   'quote',jsonb_build_object('filename',v_doc.original_filename,'mime_type',v_doc.mime_type,'sha256',v_doc.sha256,'size',octet_length(v_doc.content)),
   'related_documents','[]'::jsonb,'case_id',p_case,'contract_id',p_offer,'contract_version',v_version,
   'estimate_revision_id',p_estimate,'estimate_revision_number',v_est.revision_number,'estimate_sha256',v_doc.sha256,
   'issued_by',p_actor,'issued_at',v_now,'expires_at',v_expires
 );

 insert into public.pa_contract_offers(id,inquiry_id,version,issued_at,expires_at,issued_by,snapshot,snapshot_sha256,quote_pdf,quote_sha256,estimate_revision_id)
 values(p_offer,p_case,v_version,v_now,v_expires,p_actor,v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),v_doc.content,v_doc.sha256,p_estimate);
 insert into public.pa_contract_tokens(offer_id,token_hash) values(p_offer,p_token_hash);
 insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids,secret_envelope)
 values(v_outbox,p_case,p_operation,'confirmation',p_offer,btrim(v_case.email),p_subject,p_body,p_reply_binding,array[v_doc.id],p_secret_envelope);
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
 values(p_case,p_actor,'formal_contract_issued',jsonb_build_object('contract_id',p_offer,'version',v_version,'estimate_revision_id',p_estimate,'snapshot_schema_version','PA-FORMAL-V5-20260914-1','operation_id',p_operation));
 return jsonb_build_object('id',p_offer,'version',v_version,'expires_at',v_expires,'outbox_id',v_outbox,'already_committed',false);
end $$;

create or replace function public.pa_v5_outbox_claim(p_actor uuid,p_job uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.pa_commercial_outbox%rowtype; v_job_case uuid; v_current uuid; v_token text; v_expiry timestamptz;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select inquiry_id into v_job_case from public.pa_commercial_outbox where id=p_job;
 if not found then raise exception 'outbox_not_found'; end if;
 perform 1 from public.pa_inquiries where id=v_job_case for update;
 select * into v_job from public.pa_commercial_outbox where id=p_job for update;
 if not found or v_job.inquiry_id<>v_job_case then raise exception 'outbox_not_found'; end if;
 if v_job.state='sent' then return jsonb_build_object('id',v_job.id,'state','sent','already_committed',true); end if;
 if v_job.state='cancelled' then return jsonb_build_object('id',v_job.id,'state','cancelled','already_committed',true); end if;
 if v_job.state='unknown' or v_job.delivery_state='unknown_after_provider_start' then raise exception 'outbox_unknown_requires_reconciliation'; end if;
 if v_job.state='processing' and v_job.lease_expires_at>now() then raise exception 'outbox_busy'; end if;
 if v_job.state='processing' and v_job.reply_binding->>'confirmation_mode'='DIRECT_CONFIRM_WITH_ESTIMATE'
 then raise exception 'outbox_unknown_requires_reconciliation'; end if;
 select current_estimate_revision_id into v_current from public.pa_case_commercial_state where inquiry_id=v_job.inquiry_id for update;
 if v_job.job_kind='estimate' and v_job.aggregate_id is distinct from v_current then
   update public.pa_commercial_outbox set state='cancelled',delivery_state='cancelled',finished_at=now(),last_error_code='estimate_superseded' where id=p_job;
   return jsonb_build_object('id',p_job,'state','cancelled','reason','estimate_superseded');
 end if;
 if v_job.job_kind in ('confirmation','confirmation_reminder') then
   select t.state,o.expires_at into v_token,v_expiry from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.id=v_job.aggregate_id and o.inquiry_id=v_job.inquiry_id for update of t;
   if v_token is distinct from 'active' or v_expiry<=now() or not exists(select 1 from public.pa_contract_offers o where o.id=v_job.aggregate_id and o.estimate_revision_id=v_current) then
     update public.pa_commercial_outbox set state='cancelled',delivery_state='cancelled',finished_at=now(),last_error_code='confirmation_unavailable' where id=p_job;
     return jsonb_build_object('id',p_job,'state','cancelled','reason','confirmation_unavailable');
   end if;
 end if;
 if v_job.reply_binding->>'confirmation_mode'='DIRECT_CONFIRM_WITH_ESTIMATE' and v_job.job_kind='confirmation' then
   if exists(select 1 from public.pa_case_commercial_state where inquiry_id=v_job.inquiry_id and estimate_change_state<>'ready')
     or not exists(select 1 from public.pa_contract_offers o
       join public.pa_estimate_revisions e on e.id=o.estimate_revision_id and e.inquiry_id=o.inquiry_id
       join public.pa_commercial_documents d on d.id=e.document_id and d.inquiry_id=o.inquiry_id
       join public.pa_inquiries i on i.id=o.inquiry_id
       join public.pa_gmail_thread_links l on l.inquiry_id=o.inquiry_id and l.conversation_role='primary_conversation'
       where o.id=v_job.aggregate_id and o.inquiry_id=v_job.inquiry_id and o.estimate_revision_id=v_current
         and v_job.recipient=i.email and l.gmail_thread_id=v_job.reply_binding->>'thread_id'
         and o.quote_pdf=d.content and o.quote_sha256=d.sha256 and d.sha256=encode(sha256(d.content),'hex')
         and (o.snapshot->'estimate'->>'amount_minor')::bigint=e.amount_minor
         and (o.snapshot->'estimate'->>'revision_number')::integer=e.revision_number
         and o.snapshot->'estimate'->>'original_filename'=d.original_filename
         and v_job.attachment_ids=array[d.id])
   then raise exception 'confirmation_send_authority_changed'; end if;
 end if;
 if v_job.job_kind='confirmation' and (
   v_job.confirmation_send_authorized_at is null or v_job.confirmation_send_authorized_by is distinct from p_actor
   or v_job.confirmation_send_authority_sha256 is null
   or v_job.confirmation_send_authorized_at<clock_timestamp()-interval '10 minutes'
 ) then raise exception 'confirmation_send_owner_approval_required'; end if;
 if v_job.job_kind='accept_receipt' and not exists(
   select 1 from public.pa_contracts c join public.pa_contract_tokens t on t.offer_id=c.id
    where c.id=v_job.aggregate_id and c.inquiry_id=v_job.inquiry_id and t.state='accepted')
 then
   update public.pa_commercial_outbox set state='cancelled',delivery_state='cancelled',finished_at=now(),last_error_code='accepted_contract_unavailable' where id=p_job;
   return jsonb_build_object('id',p_job,'state','cancelled','reason','accepted_contract_unavailable');
 end if;
 if v_job.job_kind='change_proposal' and not exists(select 1 from public.pa_change_orders where id=v_job.aggregate_id and inquiry_id=v_job.inquiry_id and state in ('proposal','customer_acknowledged')) then
   update public.pa_commercial_outbox set state='cancelled',delivery_state='cancelled',finished_at=now(),last_error_code='change_proposal_unavailable' where id=p_job;
   return jsonb_build_object('id',p_job,'state','cancelled','reason','change_proposal_unavailable');
 end if;
 if v_job.job_kind='confirmation' then perform set_config('ara_tech.pa_confirmation_claim_job',p_job::text,true); end if;
 update public.pa_commercial_outbox set
   state='processing',delivery_state='processing',lease_id=p_lease,lease_expires_at=now()+interval '10 minutes',
   attempt_count=attempt_count+1,last_error_code=null,failure_phase=null,failure_code=null,safe_error_message=null,
   provider_message_id=null,provider_thread_id=null,provider_request_started=false,provider_response_received=false,
   provider_http_status=null,finished_at=null,
   confirmation_send_authorized_at=case when job_kind='confirmation' then null else confirmation_send_authorized_at end,
   confirmation_send_authorized_by=case when job_kind='confirmation' then null else confirmation_send_authorized_by end,
   confirmation_send_authority_sha256=case when job_kind='confirmation' then null else confirmation_send_authority_sha256 end
 where id=p_job returning * into v_job;
 return to_jsonb(v_job)-'secret_envelope'-'body_text';
end $$;

create or replace function public.pa_contract_accept(p_token_hash text,p_offer_id uuid,p_snapshot_sha256 text,p_name text,p_agree boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_o public.pa_contract_offers%rowtype;
 v_state text;
 v_current uuid;
 v_snapshot jsonb;
 v_now timestamptz;
 v_status text;
 v_source public.pa_commercial_outbox%rowtype;
 v_receipt_job uuid;
begin
 select o.* into v_o from public.pa_contract_offers o join public.pa_contract_tokens t on t.offer_id=o.id where t.token_hash=p_token_hash;
 if not found or v_o.id<>p_offer_id or v_o.estimate_revision_id is null then raise exception 'invalid_link'; end if;
 select status into v_status from public.pa_inquiries where id=v_o.inquiry_id and deleted_at is null for update;
 if not found or v_status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
 perform public.pa_v5_state(v_o.inquiry_id);
 select current_estimate_revision_id into v_current from public.pa_case_commercial_state where inquiry_id=v_o.inquiry_id for update;
 select state into v_state from public.pa_contract_tokens where offer_id=v_o.id for update;
 select id into v_receipt_job from public.pa_commercial_outbox where job_kind='accept_receipt' and aggregate_id=v_o.id;
 if v_state='accepted' then
   return jsonb_build_object('state','accepted','id',v_o.id,'already_received',true,'outbox_id',v_receipt_job,'actor_id',v_o.issued_by);
 end if;
 if v_state<>'active' or v_current<>v_o.estimate_revision_id then raise exception 'invalid_link'; end if;
 v_now:=clock_timestamp();
 if v_now>=v_o.expires_at then raise exception 'expired_link'; end if;
 if p_snapshot_sha256 is distinct from v_o.snapshot_sha256 then raise exception 'contract_changed'; end if;
 if p_agree is distinct from true or p_name is null or length(trim(p_name)) not between 1 and 120 or p_name~'[[:cntrl:]]' then raise exception 'consent_required'; end if;
 if v_o.quote_sha256<>encode(sha256(v_o.quote_pdf),'hex') then raise exception 'quote_identity_mismatch'; end if;
 v_snapshot:=v_o.snapshot||jsonb_build_object(
   'confirmer_name',trim(p_name),'confirmed_at',v_now,
   'confirmed_at_jst',to_char(v_now at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:MI:SS')||' JST','agreed',true,
   'acceptance',jsonb_build_object('confirmer_name',trim(p_name),'confirmed_at',v_now,'agreed',true));
 if v_o.snapshot->>'confirmation_mode'='DIRECT_CONFIRM_WITH_ESTIMATE' then
   v_snapshot:=v_snapshot||jsonb_build_object('explicit_consent',jsonb_build_object(
     'estimate_revision_id',v_o.estimate_revision_id,'amount_minor',v_o.snapshot->'estimate'->'amount_minor',
     'quote_sha256',v_o.quote_sha256,'terms_version',v_o.snapshot->'terms'->>'terms_version',
     'estimate',true,'cancellation',true,'payment',true,'formal_order',true,'confirmed_at',v_now));
 end if;
 insert into public.pa_contracts values(v_o.id,v_o.inquiry_id,v_o.version,v_now,v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'));
 update public.pa_contract_tokens set state='accepted' where offer_id=v_o.id;
 update public.pa_case_progress set formal_contract_id=v_o.id,booking_confirmed_on=(v_now at time zone 'Asia/Tokyo')::date,
   estimate_approved_on=(v_now at time zone 'Asia/Tokyo')::date,
   confirmed_event_date=coalesce(v_snapshot->'case'->>'event_date',v_snapshot->>'event_date')::date,
   estimate_amount=coalesce(v_snapshot->'estimate'->>'amount_minor',v_snapshot->>'amount_minor',v_snapshot->>'amount')::numeric,
   current_step=greatest(current_step,9),updated_at=v_now where inquiry_id=v_o.inquiry_id;
 if v_o.snapshot->>'snapshot_schema_version'='PA-FORMAL-V5-20260914-1' then
   select * into v_source from public.pa_commercial_outbox
    where aggregate_id=v_o.id and job_kind='confirmation' order by created_at desc limit 1;
   if not found then raise exception 'invalid_contract'; end if;
   v_receipt_job:=gen_random_uuid();
   insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids)
   values(v_receipt_job,v_o.inquiry_id,v_o.id,'accept_receipt',v_o.id,v_source.recipient,
     '【ARA-TECH】正式受注確認完了｜'||(v_snapshot->'case'->>'event_name'),
      (case when btrim(v_snapshot->'customer'->>'contact_name')~'(様|御中|殿|先生|各位)$'
        then btrim(v_snapshot->'customer'->>'contact_name') else btrim(v_snapshot->'customer'->>'contact_name')||' 様' end)
      ||E'\n\nお世話になっております。\nARA-TECHの荒殿（アラドノ）です。\n\nこのたびは正式にご依頼いただき、\nありがとうございます。\n\n「'||(v_snapshot->'case'->>'event_name')||E'」につきまして、\n正式受注確認を承りました。\n\nご確認いただいた内容を\nPDFにて添付しておりますので、\nお手元に保管いただけますと幸いです。\n\nご不明な点や、\n今後内容の変更等がございましたら、\nお気軽にご連絡ください。\n\n今後ともよろしくお願いいたします。\n\nARA-TECH\n荒殿',
     v_source.reply_binding-'confirmation_token','{}'::uuid[]);
 end if;
 insert into public.pa_inquiry_audit(inquiry_id,action,details)
 values(v_o.inquiry_id,'formal_contract_accepted',jsonb_build_object('contract_id',v_o.id,'version',v_o.version,'estimate_revision_id',v_o.estimate_revision_id,'confirmed_at',v_now,'receipt_outbox_id',v_receipt_job));
 return jsonb_build_object('state','accepted','id',v_o.id,'already_received',false,'outbox_id',v_receipt_job,'actor_id',v_o.issued_by);
end $$;
commit;

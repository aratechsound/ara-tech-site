-- PA-EST-004R1: recovery, reminder and post-contract change workflow.
-- Forward-only local candidate. Production application requires a separate release gate.
begin;

do $$
begin
  if to_regclass('public.pa_commercial_outbox') is null
    or to_regclass('public.pa_estimate_revisions') is null
    or to_regclass('public.pa_change_orders') is null
    or to_regprocedure('public.pa_v5_assert_admin(uuid)') is null
  then raise exception 'PA-EST-004R1 prerequisites are missing'; end if;
end;
$$;

alter table public.pa_commercial_outbox drop constraint pa_commercial_outbox_job_kind_check;
alter table public.pa_commercial_outbox add constraint pa_commercial_outbox_job_kind_check
  check (job_kind in ('estimate','confirmation','confirmation_reminder','invoice','change_proposal'));

create table public.pa_estimate_delivery_evidence (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  estimate_revision_id uuid not null,
  gmail_message_id text not null,
  gmail_attachment_id text not null,
  registration_mode text not null check (registration_mode in ('current','historical')),
  requested_document_id uuid not null,
  recipient text not null check (recipient like '%@%'),
  source_sent_at timestamptz not null,
  operation_id uuid not null unique,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references auth.users(id),
  foreign key (estimate_revision_id,inquiry_id)
    references public.pa_estimate_revisions(id,inquiry_id) on delete restrict,
  unique (inquiry_id,gmail_message_id,gmail_attachment_id)
);

create table public.pa_estimate_import_corrections (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  estimate_revision_id uuid not null,
  operation_id uuid not null unique,
  reason text not null check (char_length(reason) between 1 and 2000),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references auth.users(id),
  foreign key (estimate_revision_id,inquiry_id)
    references public.pa_estimate_revisions(id,inquiry_id) on delete restrict
);

alter table public.pa_change_orders add column proposal_document_id uuid;
alter table public.pa_change_orders add column agreement_operation_id uuid unique;
alter table public.pa_change_orders add column agreed_at timestamptz;
alter table public.pa_change_orders add column agreed_by uuid references auth.users(id);
alter table public.pa_change_orders add column updated_at timestamptz not null default now();
alter table public.pa_change_orders add constraint pa_change_orders_document_fk
  foreign key (proposal_document_id,inquiry_id)
  references public.pa_commercial_documents(id,inquiry_id) on delete restrict;
alter table public.pa_change_orders add constraint pa_change_orders_agreement_shape
  check ((state='agreed' and agreement_evidence is not null and agreed_amount_minor is not null and agreed_at is not null and agreed_by is not null)
      or state<>'agreed');

-- A manually verified prepayment exists before a final billing row.  Keep it in
-- the existing append-only payment ledger with a null billing_id, then bind it
-- atomically when the first billing is created for the case.
alter table public.pa_payment_adjustments alter column billing_id drop not null;

create function public.pa_v5_bind_case_prepayments() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer:=0; v_amount bigint:=0;
begin
  update public.pa_payment_records set billing_id=new.id
    where inquiry_id=new.inquiry_id and billing_id is null;
  get diagnostics v_count=row_count;
  if v_count>0 then
    select coalesce(sum(round(amount)::bigint),0) into v_amount
      from public.pa_payment_records where billing_id=new.id;
    insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
      values(new.inquiry_id,new.created_by,'prepayments_bound_to_billing',jsonb_build_object('billing_id',new.id,'record_count',v_count,'gross_amount_minor',v_amount));
  end if;
  return new;
end $$;

create or replace function public.pa_v5_payment_and_close(p_actor uuid,p_case uuid,p_billing uuid,p_expected_revision bigint,p_operation uuid,p_payment_date date,p_new_payment_minor bigint,p_method text,p_memo text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_case public.pa_inquiries%rowtype; v_state public.pa_case_commercial_state%rowtype; v_bill public.pa_billings%rowtype; v_paid bigint; v_payment uuid;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
 v_state:=public.pa_v5_state(p_case);
 if v_state.closed_operation_id=p_operation then return jsonb_build_object('state','closed','already_committed',true); end if;
 if v_state.revision<>p_expected_revision or v_state.fulfillment_state<>'confirmed' or v_state.settlement_state<>'confirmed' or v_state.unresolved_changes then raise exception 'case_not_ready_to_close'; end if;
 select * into v_bill from public.pa_billings where id=p_billing and inquiry_id=p_case for update; if not found or v_bill.state<>'open' then raise exception 'billing_not_open'; end if;
 if v_bill.invoice_policy='separate_pdf' and v_bill.invoice_delivery_state<>'sent' then raise exception 'invoice_not_sent'; end if;
 if p_new_payment_minor<0 then raise exception 'invalid_payment'; end if;
 if p_new_payment_minor>0 then
   if p_payment_date is null or p_method not in ('bank_transfer','cash','other') then raise exception 'invalid_payment'; end if;
   v_payment:=gen_random_uuid();
   insert into public.pa_payment_records(id,inquiry_id,confirmation_source,payment_date,amount,payment_method,confirmation_memo,confirmed_by,confirmed_by_label,confirmed_at,billing_id,operation_id,recorded_only)
   values(v_payment,p_case,'manual',p_payment_date,p_new_payment_minor::numeric,p_method,nullif(btrim(coalesce(p_memo,'')),''),p_actor,p_actor::text,now(),p_billing,p_operation,false);
 end if;
 select coalesce(sum(round(p.amount)::bigint),0)
   +coalesce((select sum(a.delta_minor) from public.pa_payment_adjustments a
     where a.billing_id=p_billing or (a.billing_id is null and exists(select 1 from public.pa_payment_records ap where ap.id=a.payment_id and ap.billing_id=p_billing))),0)
   into v_paid from public.pa_payment_records p where p.billing_id=p_billing;
 if v_paid<>v_bill.amount_minor or v_paid<>v_state.final_settlement_minor then raise exception 'payment_balance_not_zero'; end if;
 update public.pa_billings set state='paid',updated_at=now() where id=p_billing;
 update public.pa_case_progress set current_step=14,is_on_hold=false,close_reason='payment_received',closed_from_step=13,closed_at=now(),updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
 update public.pa_inquiries set status='closed' where id=p_case;
 update public.pa_case_commercial_state set closed_operation_id=p_operation,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'payment_confirmed_and_closed_v5',jsonb_build_object('billing_id',p_billing,'payment_id',v_payment,'confirmed_total_minor',v_paid,'operation_id',p_operation));
 return jsonb_build_object('state','closed','payment_id',v_payment,'confirmed_total_minor',v_paid,'already_committed',false);
end $$;
create trigger pa_v5_bind_case_prepayments after insert on public.pa_billings
  for each row execute function public.pa_v5_bind_case_prepayments();

create function public.pa_v5_record_prepayment(p_actor uuid,p_case uuid,p_operation uuid,p_payment_date date,p_amount_minor bigint,p_method text,p_memo text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid(); v_existing public.pa_payment_records%rowtype; v_case public.pa_inquiries%rowtype;
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_existing from public.pa_payment_records where operation_id=p_operation;
  if found then
    if v_existing.inquiry_id<>p_case or v_existing.billing_id is not null or v_existing.payment_date<>p_payment_date
      or round(v_existing.amount)::bigint<>p_amount_minor or v_existing.payment_method<>p_method
      or coalesce(v_existing.confirmation_memo,'')<>btrim(coalesce(p_memo,'')) then raise exception 'idempotency_payload_mismatch'; end if;
    return jsonb_build_object('id',v_existing.id,'already_committed',true);
  end if;
  if p_operation is null or p_amount_minor<=0 or p_method not in ('bank_transfer','cash','other') or p_payment_date is null then raise exception 'invalid_payment'; end if;
  select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update;
  if not found or v_case.status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
  perform public.pa_v5_state(p_case);
  if not exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'accepted_contract_required'; end if;
  if exists(select 1 from public.pa_billings where inquiry_id=p_case and state='open') then raise exception 'billing_already_exists'; end if;
  insert into public.pa_payment_records(id,inquiry_id,confirmation_source,payment_date,amount,payment_method,confirmation_memo,confirmed_by,confirmed_by_label,confirmed_at,external_transaction_id,billing_id,operation_id,recorded_only)
    values(v_id,p_case,'manual',p_payment_date,p_amount_minor::numeric,p_method,nullif(btrim(coalesce(p_memo,'')),''),p_actor,p_actor::text,now(),null,null,p_operation,true);
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
    values(p_case,p_actor,'prepayment_recorded',jsonb_build_object('payment_id',v_id,'amount_minor',p_amount_minor,'payment_date',p_payment_date,'operation_id',p_operation));
  return jsonb_build_object('id',v_id,'already_committed',false);
end $$;

create or replace function public.pa_v5_adjust_payment(p_actor uuid,p_case uuid,p_billing uuid,p_payment uuid,p_operation uuid,p_delta_minor bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid(); v_existing public.pa_payment_adjustments%rowtype; v_payment public.pa_payment_records%rowtype;
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_existing from public.pa_payment_adjustments where operation_id=p_operation;
  if found then
    if v_existing.inquiry_id<>p_case or v_existing.payment_id<>p_payment or v_existing.billing_id is distinct from p_billing
      or v_existing.delta_minor<>p_delta_minor or v_existing.reason<>btrim(coalesce(p_reason,'')) then raise exception 'idempotency_payload_mismatch'; end if;
    return jsonb_build_object('id',v_existing.id,'already_committed',true);
  end if;
  if p_operation is null or p_delta_minor=0 or char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_payment_adjustment'; end if;
  perform 1 from public.pa_inquiries where id=p_case for update; if not found then raise exception 'case_unavailable'; end if;
  select * into v_payment from public.pa_payment_records where id=p_payment and inquiry_id=p_case for share;
  if not found or v_payment.billing_id is distinct from p_billing then raise exception 'payment_not_found'; end if;
  insert into public.pa_payment_adjustments(id,inquiry_id,billing_id,payment_id,delta_minor,reason,operation_id,adjusted_at,adjusted_by)
    values(v_id,p_case,p_billing,p_payment,p_delta_minor,btrim(p_reason),p_operation,now(),p_actor);
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
    values(p_case,p_actor,'payment_adjusted',jsonb_build_object('payment_id',p_payment,'billing_id',p_billing,'delta_minor',p_delta_minor,'reason',btrim(p_reason),'operation_id',p_operation));
  return jsonb_build_object('id',v_id,'already_committed',false);
end $$;

create function public.pa_v5_delivery_evidence_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin raise exception 'commercial_history_immutable' using errcode='42501'; end $$;
create trigger pa_estimate_delivery_evidence_immutable before update or delete on public.pa_estimate_delivery_evidence
  for each row execute function public.pa_v5_delivery_evidence_immutable();
create trigger pa_estimate_import_corrections_immutable before update or delete on public.pa_estimate_import_corrections
  for each row execute function public.pa_v5_delivery_evidence_immutable();

create function public.pa_v5_import_sent_estimate(
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
    or jsonb_typeof(p_conditions)<>'object' then raise exception 'invalid_estimate_recovery'; end if;
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
  if v_attachment is null or lower(split_part(coalesce(v_attachment->>'mime_type',''),';',1))<>'application/pdf'
    or coalesce(v_attachment->>'filename','')<>p_filename then raise exception 'invalid_estimate_recovery'; end if;
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

create function public.pa_v5_correct_estimate_import(p_actor uuid,p_case uuid,p_estimate uuid,p_expected_revision bigint,p_operation uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_est public.pa_estimate_revisions%rowtype; v_state public.pa_case_commercial_state%rowtype; v_existing public.pa_estimate_import_corrections%rowtype; v_token record; v_id uuid:=gen_random_uuid();
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_existing from public.pa_estimate_import_corrections where operation_id=p_operation;
  if found then
    if v_existing.inquiry_id<>p_case or v_existing.estimate_revision_id<>p_estimate or v_existing.reason<>btrim(p_reason) then raise exception 'idempotency_payload_mismatch'; end if;
    return jsonb_build_object('id',v_existing.id,'already_committed',true);
  end if;
  if char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'estimate_correction_reason_required'; end if;
  perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
  v_state:=public.pa_v5_state(p_case); if v_state.revision<>p_expected_revision then raise exception 'commercial_state_changed'; end if;
  select * into v_est from public.pa_estimate_revisions where id=p_estimate and inquiry_id=p_case and source_kind='sent_recovery';
  if not found then raise exception 'estimate_not_recoverable'; end if;
  if exists(select 1 from public.pa_contract_offers o join public.pa_contracts c on c.id=o.id where o.estimate_revision_id=p_estimate) then raise exception 'accepted_contract_immutable'; end if;
  if exists(select 1 from public.pa_estimate_import_corrections where estimate_revision_id=p_estimate) then raise exception 'estimate_already_corrected'; end if;
  for v_token in select t.offer_id from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=p_case and o.estimate_revision_id=p_estimate and t.state='active' for update of t loop
    update public.pa_contract_tokens set state='revoked' where offer_id=v_token.offer_id;
    update public.pa_commercial_outbox set state='cancelled',finished_at=now(),last_error_code='estimate_corrected' where aggregate_id=v_token.offer_id and state in ('queued','failed');
  end loop;
  insert into public.pa_estimate_import_corrections values(v_id,p_case,p_estimate,p_operation,btrim(p_reason),now(),p_actor);
  update public.pa_case_commercial_state set current_estimate_revision_id=case when current_estimate_revision_id=p_estimate then null else current_estimate_revision_id end,estimate_change_state=case when current_estimate_revision_id=p_estimate then 'reconfirming' else estimate_change_state end,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'sent_estimate_import_corrected',jsonb_build_object('estimate_revision_id',p_estimate,'reason',btrim(p_reason),'operation_id',p_operation,'accepted_contract_changed',false));
  return jsonb_build_object('id',v_id,'revision',v_state.revision,'already_committed',false);
end $$;

create function public.pa_v5_queue_confirmation_reminder(p_actor uuid,p_case uuid,p_offer uuid,p_expected_revision bigint,p_operation uuid,p_subject text,p_body text,p_reply_binding jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype; v_offer public.pa_contract_offers%rowtype; v_token text; v_original public.pa_commercial_outbox%rowtype; v_existing public.pa_commercial_outbox%rowtype; v_id uuid:=gen_random_uuid();
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_existing from public.pa_commercial_outbox where operation_id=p_operation;
  if found then
    if v_existing.inquiry_id<>p_case or v_existing.aggregate_id<>p_offer or v_existing.job_kind<>'confirmation_reminder' or v_existing.subject<>p_subject or v_existing.body_text<>p_body then raise exception 'idempotency_payload_mismatch'; end if;
    return jsonb_build_object('outbox_id',v_existing.id,'offer_id',p_offer,'already_committed',true);
  end if;
  if position('{{CONFIRMATION_URL}}' in p_body)=0 or char_length(p_subject) not between 1 and 998 or jsonb_typeof(p_reply_binding)<>'object' then raise exception 'invalid_confirmation_reminder'; end if;
  perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
  v_state:=public.pa_v5_state(p_case); if v_state.revision<>p_expected_revision or v_state.estimate_change_state<>'ready' then raise exception 'commercial_state_changed'; end if;
  select o.* into v_offer from public.pa_contract_offers o where o.id=p_offer and o.inquiry_id=p_case;
  if not found then raise exception 'confirmation_not_remindable'; end if;
  select state into v_token from public.pa_contract_tokens where offer_id=p_offer for update;
  if not found or v_token<>'active' or v_offer.expires_at<=now() or v_offer.estimate_revision_id<>v_state.current_estimate_revision_id then raise exception 'confirmation_not_remindable'; end if;
  if exists(select 1 from public.pa_contracts where id=p_offer) then raise exception 'contract_already_accepted'; end if;
  select * into v_original from public.pa_commercial_outbox where aggregate_id=p_offer and job_kind='confirmation' and state='sent' and secret_envelope is not null order by finished_at desc limit 1;
  if not found then raise exception 'confirmation_reminder_secret_unavailable'; end if;
  if exists(select 1 from public.pa_commercial_outbox where aggregate_id=p_offer and job_kind='confirmation_reminder' and state in ('queued','processing','unknown')) then raise exception 'delivery_outcome_unresolved'; end if;
  insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids,secret_envelope)
    values(v_id,p_case,p_operation,'confirmation_reminder',p_offer,v_original.recipient,p_subject,p_body,p_reply_binding,'{}',v_original.secret_envelope);
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'formal_contract_reminder_queued',jsonb_build_object('offer_id',p_offer,'outbox_id',v_id,'same_confirmation_identity',true,'operation_id',p_operation));
  return jsonb_build_object('outbox_id',v_id,'offer_id',p_offer,'same_confirmation_identity',true,'already_committed',false);
end $$;

create function public.pa_v5_create_change_proposal(
  p_actor uuid,p_case uuid,p_expected_revision bigint,p_operation uuid,p_contract uuid,p_estimate uuid,p_document uuid,
  p_filename text,p_content_base64 text,p_sha256 text,p_amount_minor bigint,p_currency text,p_tax_basis text,p_conditions jsonb,
  p_recipient text,p_subject text,p_body text,p_reply_binding jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype; v_existing public.pa_change_orders%rowtype; v_bytes bytea; v_number integer; v_revision uuid:=p_estimate; v_change uuid:=gen_random_uuid(); v_outbox uuid:=gen_random_uuid();
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_existing from public.pa_change_orders where operation_id=p_operation;
  if found then
    if v_existing.inquiry_id<>p_case or v_existing.contract_id<>p_contract or v_existing.estimate_revision_id<>p_estimate then raise exception 'idempotency_payload_mismatch'; end if;
    return jsonb_build_object('id',v_existing.id,'estimate_revision_id',v_existing.estimate_revision_id,'already_committed',true);
  end if;
  if p_operation is null or p_amount_minor<=0 or p_currency !~ '^[A-Z]{3}$' or p_tax_basis not in ('tax_included','tax_excluded','tax_exempt') or jsonb_typeof(p_conditions)<>'object' or jsonb_typeof(p_reply_binding)<>'object' then raise exception 'invalid_change_proposal'; end if;
  perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
  v_state:=public.pa_v5_state(p_case); if v_state.revision<>p_expected_revision then raise exception 'commercial_state_changed'; end if;
  if not exists(select 1 from public.pa_contracts where id=p_contract and inquiry_id=p_case) then raise exception 'contract_not_found'; end if;
  if exists(select 1 from public.pa_billings where inquiry_id=p_case and state in ('open','paid')) then raise exception 'change_after_billing_not_allowed'; end if;
  if exists(select 1 from public.pa_change_orders where inquiry_id=p_case and state in ('proposal','customer_acknowledged')) then raise exception 'change_proposal_already_active'; end if;
  v_bytes:=decode(p_content_base64,'base64'); if p_document is null or p_estimate is null or encode(sha256(v_bytes),'hex')<>p_sha256 then raise exception 'document_identity_mismatch'; end if;
  select coalesce(max(revision_number),0)+1 into v_number from public.pa_estimate_revisions where inquiry_id=p_case and series='change_order';
  insert into public.pa_commercial_documents(id,inquiry_id,document_kind,source_kind,original_filename,mime_type,content,sha256,created_by)
    values(p_document,p_case,'change_proposal','private_upload',p_filename,'application/pdf',v_bytes,p_sha256,p_actor);
  insert into public.pa_estimate_revisions(id,inquiry_id,revision_number,series,parent_contract_id,document_id,amount_minor,currency,tax_basis,conditions_snapshot,source_kind,lifecycle,issued_by,operation_id)
    values(v_revision,p_case,v_number,'change_order',p_contract,p_document,p_amount_minor,p_currency,p_tax_basis,p_conditions,'managed_send','issued',p_actor,p_operation);
  insert into public.pa_change_orders(id,inquiry_id,contract_id,estimate_revision_id,state,operation_id,created_by,proposal_document_id)
    values(v_change,p_case,p_contract,v_revision,'proposal',p_operation,p_actor,p_document);
  insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids)
    values(v_outbox,p_case,p_operation,'change_proposal',v_change,p_recipient,p_subject,p_body,p_reply_binding,array[p_document]);
  update public.pa_case_commercial_state set estimate_change_state='post_contract_change',unresolved_changes=true,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'change_proposal_issued',jsonb_build_object('change_order_id',v_change,'estimate_revision_id',v_revision,'contract_id',p_contract,'amount_minor',p_amount_minor,'operation_id',p_operation));
  return jsonb_build_object('id',v_change,'estimate_revision_id',v_revision,'outbox_id',v_outbox,'revision_number',v_number,'already_committed',false);
end $$;

create function public.pa_v5_record_change_agreement(p_actor uuid,p_case uuid,p_change uuid,p_expected_revision bigint,p_operation uuid,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype; v_change public.pa_change_orders%rowtype; v_amount bigint;
begin
  perform public.pa_v5_assert_admin(p_actor);
  if p_operation is null or jsonb_typeof(p_evidence)<>'object' or p_evidence->>'source' not in ('customer_email','phone_record','signed_document') or char_length(btrim(coalesce(p_evidence->>'reference',''))) not between 1 and 500 then raise exception 'change_agreement_evidence_required'; end if;
  perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
  v_state:=public.pa_v5_state(p_case); if v_state.revision<>p_expected_revision then raise exception 'commercial_state_changed'; end if;
  select * into v_change from public.pa_change_orders where id=p_change and inquiry_id=p_case for update; if not found then raise exception 'change_proposal_not_found'; end if;
  if v_change.agreement_operation_id=p_operation and v_change.state='agreed' then return jsonb_build_object('id',v_change.id,'state','agreed','already_committed',true); end if;
  if v_change.agreement_operation_id is not null and v_change.agreement_operation_id<>p_operation then raise exception 'change_already_agreed'; end if;
  if v_change.state not in ('proposal','customer_acknowledged') then raise exception 'change_not_agreeable'; end if;
  if not exists(select 1 from public.pa_commercial_outbox where aggregate_id=p_change and job_kind='change_proposal' and state='sent')
    or exists(select 1 from public.pa_commercial_outbox where aggregate_id=p_change and job_kind='change_proposal' and state<>'sent') then raise exception 'change_proposal_not_sent'; end if;
  select amount_minor into v_amount from public.pa_estimate_revisions where id=v_change.estimate_revision_id and inquiry_id=p_case;
  update public.pa_change_orders set state='agreed',agreement_evidence=p_evidence,agreed_amount_minor=v_amount,agreement_operation_id=p_operation,agreed_at=now(),agreed_by=p_actor,updated_at=now() where id=p_change returning * into v_change;
  update public.pa_case_commercial_state set unresolved_changes=false,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'change_agreement_recorded',jsonb_build_object('change_order_id',p_change,'contract_id',v_change.contract_id,'agreed_amount_minor',v_amount,'evidence',p_evidence,'operation_id',p_operation));
  return jsonb_build_object('id',p_change,'state','agreed','agreed_amount_minor',v_amount,'revision',v_state.revision,'already_committed',false);
end $$;

create or replace function public.pa_v5_confirm_fulfillment_and_settlement(p_actor uuid,p_case uuid,p_expected_revision bigint,p_operation uuid,p_amount_minor bigint,p_unresolved boolean,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype; v_contract public.pa_contracts%rowtype; v_expected bigint; v_pending integer;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_operation is null or p_amount_minor<0 or jsonb_typeof(p_evidence)<>'object' then raise exception 'invalid_settlement'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
 v_state:=public.pa_v5_state(p_case); if v_state.settlement_operation_id=p_operation then return to_jsonb(v_state)||jsonb_build_object('already_committed',true); end if; if v_state.revision<>p_expected_revision then raise exception 'commercial_state_changed'; end if;
 select * into v_contract from public.pa_contracts where inquiry_id=p_case order by confirmed_at desc limit 1;
 if found then
   select count(*)::integer into v_pending from public.pa_change_orders where inquiry_id=p_case and state in ('proposal','customer_acknowledged');
   v_expected:=coalesce((v_contract.snapshot->>'amount_minor')::bigint,0)+coalesce((select sum(agreed_amount_minor) from public.pa_change_orders where inquiry_id=p_case and state='agreed'),0);
   if v_pending>0 and not p_unresolved then raise exception 'unresolved_change_orders'; end if;
   if not p_unresolved and p_amount_minor<>v_expected then raise exception 'settlement_amount_mismatch'; end if;
 end if;
 update public.pa_case_commercial_state set fulfillment_state='confirmed',fulfillment_confirmed_at=now(),fulfillment_confirmed_by=p_actor,settlement_state=case when p_unresolved then 'difference_review' else 'confirmed' end,final_settlement_minor=p_amount_minor,unresolved_changes=p_unresolved,settlement_evidence=p_evidence,settlement_operation_id=p_operation,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'fulfillment_settlement_confirmed',jsonb_build_object('amount_minor',p_amount_minor,'unresolved_changes',p_unresolved,'evidence',p_evidence,'operation_id',p_operation));
 return to_jsonb(v_state);
end $$;

create or replace function public.pa_v5_outbox_claim(p_actor uuid,p_job uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.pa_commercial_outbox%rowtype; v_current uuid; v_token text; v_expiry timestamptz;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select * into v_job from public.pa_commercial_outbox where id=p_job for update;
 if not found then raise exception 'outbox_not_found'; end if;
 if v_job.state='sent' then return jsonb_build_object('id',v_job.id,'state','sent','already_committed',true); end if;
 if v_job.state='cancelled' then return jsonb_build_object('id',v_job.id,'state','cancelled','already_committed',true); end if;
 if v_job.state='unknown' then raise exception 'outbox_unknown_requires_reconciliation'; end if;
 if v_job.state='processing' and v_job.lease_expires_at>now() then raise exception 'outbox_busy'; end if;
 perform 1 from public.pa_inquiries where id=v_job.inquiry_id for update;
 select current_estimate_revision_id into v_current from public.pa_case_commercial_state where inquiry_id=v_job.inquiry_id for update;
 if v_job.job_kind='estimate' and v_job.aggregate_id is distinct from v_current then
   update public.pa_commercial_outbox set state='cancelled',finished_at=now(),last_error_code='estimate_superseded' where id=p_job;
   return jsonb_build_object('id',p_job,'state','cancelled','reason','estimate_superseded');
 end if;
 if v_job.job_kind in ('confirmation','confirmation_reminder') then
   select t.state,o.expires_at into v_token,v_expiry from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.id=v_job.aggregate_id and o.inquiry_id=v_job.inquiry_id for update of t;
   if v_token is distinct from 'active' or v_expiry<=now() or not exists(select 1 from public.pa_contract_offers o where o.id=v_job.aggregate_id and o.estimate_revision_id=v_current) then
     update public.pa_commercial_outbox set state='cancelled',finished_at=now(),last_error_code='confirmation_unavailable' where id=p_job;
     return jsonb_build_object('id',p_job,'state','cancelled','reason','confirmation_unavailable');
   end if;
 end if;
 if v_job.job_kind='change_proposal' and not exists(select 1 from public.pa_change_orders where id=v_job.aggregate_id and inquiry_id=v_job.inquiry_id and state in ('proposal','customer_acknowledged')) then
   update public.pa_commercial_outbox set state='cancelled',finished_at=now(),last_error_code='change_proposal_unavailable' where id=p_job;
   return jsonb_build_object('id',p_job,'state','cancelled','reason','change_proposal_unavailable');
 end if;
 update public.pa_commercial_outbox set state='processing',lease_id=p_lease,lease_expires_at=now()+interval '10 minutes',attempt_count=attempt_count+1,last_error_code=null where id=p_job returning * into v_job;
 return to_jsonb(v_job)-'secret_envelope';
end $$;

alter table public.pa_estimate_delivery_evidence enable row level security;
alter table public.pa_estimate_import_corrections enable row level security;
revoke all on public.pa_estimate_delivery_evidence,public.pa_estimate_import_corrections from public,anon,authenticated;
grant select,insert on public.pa_estimate_delivery_evidence,public.pa_estimate_import_corrections to service_role;

revoke all on function public.pa_v5_delivery_evidence_immutable(),public.pa_v5_bind_case_prepayments(),public.pa_v5_record_prepayment(uuid,uuid,uuid,date,bigint,text,text),public.pa_v5_import_sent_estimate(uuid,uuid,bigint,uuid,uuid,text,uuid,text,text,text,bigint,text,text,jsonb,text,text),public.pa_v5_correct_estimate_import(uuid,uuid,uuid,bigint,uuid,text),public.pa_v5_queue_confirmation_reminder(uuid,uuid,uuid,bigint,uuid,text,text,jsonb),public.pa_v5_create_change_proposal(uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,jsonb,text,text,text,jsonb),public.pa_v5_record_change_agreement(uuid,uuid,uuid,bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pa_v5_record_prepayment(uuid,uuid,uuid,date,bigint,text,text),public.pa_v5_import_sent_estimate(uuid,uuid,bigint,uuid,uuid,text,uuid,text,text,text,bigint,text,text,jsonb,text,text),public.pa_v5_correct_estimate_import(uuid,uuid,uuid,bigint,uuid,text),public.pa_v5_queue_confirmation_reminder(uuid,uuid,uuid,bigint,uuid,text,text,jsonb),public.pa_v5_create_change_proposal(uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,jsonb,text,text,text,jsonb),public.pa_v5_record_change_agreement(uuid,uuid,uuid,bigint,uuid,jsonb) to service_role;

commit;

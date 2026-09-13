-- PA-EST-004: immutable estimates, bound confirmations, billing, payments and close.
-- Forward-only local candidate. Production application requires a separate release gate.
begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regclass('public.pa_case_progress') is null
    or to_regclass('public.pa_payment_records') is null
    or to_regclass('public.pa_contract_offers') is null
    or to_regclass('public.pa_contract_tokens') is null
    or to_regclass('public.pa_contracts') is null
    or to_regprocedure('public.is_work_admin()') is null
  then
    raise exception 'PA-EST-004 prerequisites are missing';
  end if;
end;
$$;

create table public.pa_commercial_documents (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  document_kind text not null check (document_kind in ('estimate','invoice','change_proposal','supporting')),
  source_kind text not null check (source_kind in ('managed_send','sent_recovery','private_upload')),
  gmail_message_id text,
  gmail_attachment_id text,
  original_filename text not null check (char_length(original_filename) between 1 and 500),
  mime_type text not null,
  content bytea not null check (octet_length(content) between 20 and 5242880),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$' and sha256 = encode(sha256(content),'hex')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (id, inquiry_id)
);
create unique index pa_commercial_documents_gmail_identity
  on public.pa_commercial_documents(inquiry_id,gmail_message_id,gmail_attachment_id,document_kind)
  where gmail_message_id is not null and gmail_attachment_id is not null;

create table public.pa_estimate_revisions (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  revision_number integer not null check (revision_number > 0),
  series text not null default 'pre_contract' check (series in ('pre_contract','change_order')),
  parent_contract_id uuid references public.pa_contracts(id) on delete restrict,
  document_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'JPY' check (currency ~ '^[A-Z]{3}$'),
  tax_basis text not null check (tax_basis in ('tax_included','tax_excluded','tax_exempt')),
  conditions_snapshot jsonb not null check (jsonb_typeof(conditions_snapshot) = 'object'),
  source_kind text not null check (source_kind in ('managed_send','sent_recovery')),
  lifecycle text not null default 'issued' check (lifecycle in ('issued','historical','corrected')),
  source_sent_at timestamptz,
  issued_at timestamptz not null default now(),
  issued_by uuid not null references auth.users(id),
  operation_id uuid not null unique,
  foreign key (document_id,inquiry_id) references public.pa_commercial_documents(id,inquiry_id) on delete restrict,
  unique (id,inquiry_id),
  unique (inquiry_id,series,revision_number),
  check ((series='pre_contract' and parent_contract_id is null) or (series='change_order' and parent_contract_id is not null))
);

create table public.pa_case_commercial_state (
  inquiry_id uuid primary key references public.pa_inquiries(id) on delete restrict,
  revision bigint not null default 0,
  current_estimate_revision_id uuid,
  estimate_change_state text not null default 'ready'
    check (estimate_change_state in ('ready','reconfirming','post_contract_change')),
  fulfillment_state text not null default 'not_confirmed'
    check (fulfillment_state in ('not_confirmed','confirmed','postponed','cancelled')),
  fulfillment_confirmed_at timestamptz,
  fulfillment_confirmed_by uuid references auth.users(id),
  settlement_state text not null default 'unsettled'
    check (settlement_state in ('unsettled','confirmed','difference_review')),
  final_settlement_minor bigint check (final_settlement_minor is null or final_settlement_minor >= 0),
  settlement_currency text not null default 'JPY' check (settlement_currency ~ '^[A-Z]{3}$'),
  unresolved_changes boolean not null default false,
  settlement_evidence jsonb,
  revision_start_operation_id uuid unique,
  settlement_operation_id uuid unique,
  closed_operation_id uuid unique,
  reopen_operation_id uuid unique,
  reopened_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  foreign key (current_estimate_revision_id,inquiry_id)
    references public.pa_estimate_revisions(id,inquiry_id) on delete restrict
);

create table public.pa_commercial_outbox (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  operation_id uuid not null unique,
  job_kind text not null check (job_kind in ('estimate','confirmation','confirmation_reminder','invoice')),
  aggregate_id uuid not null,
  state text not null default 'queued' check (state in ('queued','processing','sent','failed','unknown','cancelled')),
  recipient text not null check (recipient like '%@%'),
  subject text not null check (char_length(subject) between 1 and 998),
  body_text text not null check (char_length(body_text) between 1 and 20000),
  reply_binding jsonb not null check (jsonb_typeof(reply_binding) = 'object'),
  attachment_ids uuid[] not null default '{}',
  secret_envelope text,
  lease_id uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  provider_thread_id text,
  attempt_count integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id,inquiry_id)
);
create unique index pa_commercial_outbox_active_aggregate
  on public.pa_commercial_outbox(job_kind,aggregate_id)
  where state in ('queued','processing','unknown');

alter table public.pa_contract_offers
  add column estimate_revision_id uuid;
alter table public.pa_contract_offers
  add constraint pa_contract_offers_estimate_revision_fk
  foreign key (estimate_revision_id,inquiry_id)
  references public.pa_estimate_revisions(id,inquiry_id) on delete restrict;
create unique index pa_contract_offers_one_active_estimate
  on public.pa_contract_offers(inquiry_id,estimate_revision_id)
  where estimate_revision_id is not null;

create table public.pa_billings (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  billing_number integer not null check (billing_number > 0),
  contract_id uuid not null references public.pa_contracts(id) on delete restrict,
  estimate_revision_id uuid not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'JPY' check (currency ~ '^[A-Z]{3}$'),
  invoice_policy text not null check (invoice_policy in ('separate_pdf','no_separate_invoice')),
  invoice_document_id uuid,
  invoice_delivery_state text not null
    check (invoice_delivery_state in ('not_required','registered','queued','sent','failed','unknown')),
  due_date date,
  due_basis jsonb not null check (jsonb_typeof(due_basis)='object'),
  customer_planned_payment_on date,
  agreement_evidence jsonb not null check (jsonb_typeof(agreement_evidence)='object'),
  state text not null default 'open' check (state in ('open','paid','void')),
  operation_id uuid not null unique,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (id,inquiry_id),
  unique (inquiry_id,billing_number),
  foreign key (estimate_revision_id,inquiry_id) references public.pa_estimate_revisions(id,inquiry_id) on delete restrict,
  foreign key (invoice_document_id,inquiry_id) references public.pa_commercial_documents(id,inquiry_id) on delete restrict,
  check ((invoice_policy='separate_pdf' and invoice_document_id is not null and invoice_delivery_state<>'not_required')
      or (invoice_policy='no_separate_invoice' and invoice_delivery_state='not_required')),
  check (due_date is not null or due_basis->>'status'='unconfirmed')
);
create unique index pa_billings_one_open_case on public.pa_billings(inquiry_id) where state='open';

drop index if exists public.pa_payment_records_one_close_per_case;
alter table public.pa_payment_records add column billing_id uuid;
alter table public.pa_payment_records add column operation_id uuid;
alter table public.pa_payment_records add column recorded_only boolean not null default true;
alter table public.pa_payment_records
  add constraint pa_payment_records_billing_fk foreign key (billing_id,inquiry_id)
  references public.pa_billings(id,inquiry_id) on delete restrict;
create unique index pa_payment_records_operation_id on public.pa_payment_records(operation_id) where operation_id is not null;

create table public.pa_payment_adjustments (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  billing_id uuid not null,
  payment_id uuid not null references public.pa_payment_records(id) on delete restrict,
  delta_minor bigint not null check (delta_minor <> 0),
  reason text not null check (char_length(reason) between 1 and 2000),
  operation_id uuid not null unique,
  adjusted_at timestamptz not null default now(),
  adjusted_by uuid not null references auth.users(id),
  foreign key (billing_id,inquiry_id) references public.pa_billings(id,inquiry_id) on delete restrict
);

create table public.pa_change_orders (
  id uuid primary key,
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  contract_id uuid not null references public.pa_contracts(id) on delete restrict,
  estimate_revision_id uuid not null,
  state text not null default 'proposal' check (state in ('proposal','customer_acknowledged','agreed','withdrawn')),
  agreement_evidence jsonb,
  agreed_amount_minor bigint,
  operation_id uuid not null unique,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (estimate_revision_id,inquiry_id) references public.pa_estimate_revisions(id,inquiry_id) on delete restrict
);

create function public.pa_v5_immutable_history() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin raise exception 'commercial_history_immutable' using errcode='42501'; end $$;
create trigger pa_commercial_documents_immutable before update or delete on public.pa_commercial_documents for each row execute function public.pa_v5_immutable_history();
create trigger pa_estimate_revisions_immutable before update or delete on public.pa_estimate_revisions for each row execute function public.pa_v5_immutable_history();
create trigger pa_payment_adjustments_immutable before update or delete on public.pa_payment_adjustments for each row execute function public.pa_v5_immutable_history();

create function public.pa_v5_outbox_guard() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  if old.inquiry_id<>new.inquiry_id or old.operation_id<>new.operation_id or old.job_kind<>new.job_kind
    or old.aggregate_id<>new.aggregate_id or old.recipient<>new.recipient or old.subject<>new.subject
    or old.body_text<>new.body_text or old.reply_binding<>new.reply_binding
    or old.attachment_ids<>new.attachment_ids or old.secret_envelope is distinct from new.secret_envelope
    or old.created_at<>new.created_at then raise exception 'outbox_payload_immutable'; end if;
  if old.state in ('sent','cancelled') then raise exception 'outbox_terminal'; end if;
  if old.state='unknown' and new.state not in ('unknown','cancelled') then raise exception 'outbox_unknown_requires_reconciliation'; end if;
  return new;
end $$;
create trigger pa_commercial_outbox_guard before update or delete on public.pa_commercial_outbox for each row execute function public.pa_v5_outbox_guard();

create function public.pa_v5_assert_admin(p_actor uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_actor is null or not exists(select 1 from public.work_admins where user_id=p_actor) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
end $$;

create function public.pa_v5_state(p_case uuid) returns public.pa_case_commercial_state
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype;
begin
  insert into public.pa_case_commercial_state(inquiry_id) values(p_case) on conflict do nothing;
  select * into v_state from public.pa_case_commercial_state where inquiry_id=p_case for update;
  return v_state;
end $$;

create function public.pa_v5_begin_estimate_revision(
  p_actor uuid,p_case uuid,p_expected_revision bigint,p_operation uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_case public.pa_inquiries%rowtype; v_state public.pa_case_commercial_state%rowtype; v_token record; v_count integer:=0;
begin
  perform public.pa_v5_assert_admin(p_actor);
  if p_operation is null or char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_revision_start'; end if;
  select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update;
  if not found or v_case.status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
  v_state:=public.pa_v5_state(p_case);
  if v_state.revision_start_operation_id=p_operation then return jsonb_build_object('revision',v_state.revision,'already_committed',true,'state',v_state.estimate_change_state); end if;
  if v_state.revision<>p_expected_revision then raise exception 'commercial_state_changed'; end if;
  if exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'post_contract_change_required'; end if;
  for v_token in select t.offer_id,o.estimate_revision_id from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=p_case and t.state='active' for update of t loop
    if v_token.estimate_revision_id is null then raise exception 'legacy_confirmation_reconciliation_required'; end if;
    update public.pa_contract_tokens set state='revoked' where offer_id=v_token.offer_id;
    v_count:=v_count+1;
    insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'formal_contract_revoked',jsonb_build_object('offer_id',v_token.offer_id,'reason','estimate_revision_started','operation_id',p_operation));
  end loop;
  update public.pa_case_commercial_state set estimate_change_state='reconfirming',revision_start_operation_id=p_operation,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'estimate_revision_started',jsonb_build_object('reason',btrim(p_reason),'revoked_confirmations',v_count,'operation_id',p_operation));
  return jsonb_build_object('revision',v_state.revision,'revoked_confirmations',v_count,'state',v_state.estimate_change_state);
end $$;

create function public.pa_v5_issue_estimate(
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
  if p_source_kind='managed_send' then
    insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids)
      values(v_outbox,p_case,p_operation,'estimate',v_id,p_recipient,p_subject,p_body,p_reply_binding,array[p_document_id]);
  else
    v_outbox:=null;
  end if;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'estimate_revision_issued',jsonb_build_object('estimate_revision_id',v_id,'revision_number',v_number,'amount_minor',p_amount_minor,'currency',p_currency,'document_sha256',p_sha256,'operation_id',p_operation));
  return jsonb_build_object('id',v_id,'revision_number',v_number,'outbox_id',v_outbox,'already_committed',false);
end $$;

create function public.pa_v5_issue_confirmation(
 p_actor uuid,p_case uuid,p_expected_revision bigint,p_estimate uuid,p_offer uuid,p_operation uuid,
 p_token_hash text,p_secret_envelope text,p_snapshot jsonb,p_recipient text,p_subject text,p_body text,p_reply_binding jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_case public.pa_inquiries%rowtype; v_state public.pa_case_commercial_state%rowtype; v_est public.pa_estimate_revisions%rowtype; v_doc public.pa_commercial_documents%rowtype; v_version integer; v_expires timestamptz; v_snapshot jsonb; v_outbox uuid:=gen_random_uuid(); v_existing public.pa_contract_offers%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select o.* into v_existing from public.pa_contract_offers o join public.pa_commercial_outbox x on x.aggregate_id=o.id where x.operation_id=p_operation;
 if found then return jsonb_build_object('id',v_existing.id,'version',v_existing.version,'already_committed',true); end if;
 if p_token_hash!~'^[a-f0-9]{64}$' or char_length(coalesce(p_secret_envelope,''))<40 or jsonb_typeof(p_snapshot)<>'object' or jsonb_typeof(p_reply_binding)<>'object' then raise exception 'invalid_contract'; end if;
 select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found or v_case.status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
 v_state:=public.pa_v5_state(p_case);
 if v_state.revision<>p_expected_revision or v_state.current_estimate_revision_id<>p_estimate or v_state.estimate_change_state<>'ready' then raise exception 'commercial_state_changed'; end if;
 if exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'contract_already_accepted'; end if;
 if exists(select 1 from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=p_case and t.state='active') then raise exception 'confirmation_already_active'; end if;
 if exists(select 1 from public.pa_commercial_outbox where inquiry_id=p_case and job_kind='estimate' and aggregate_id=p_estimate and state<>'sent') then raise exception 'estimate_delivery_not_confirmed'; end if;
 select * into v_est from public.pa_estimate_revisions where id=p_estimate and inquiry_id=p_case;
 if not found then raise exception 'estimate_not_found'; end if;
 select * into v_doc from public.pa_commercial_documents where id=v_est.document_id and inquiry_id=p_case;
 select coalesce(max(version),0)+1 into v_version from public.pa_contract_offers where inquiry_id=p_case;
 v_expires:=(((now() at time zone 'Asia/Tokyo')::date+7)::timestamp at time zone 'Asia/Tokyo');
 v_snapshot:=p_snapshot||jsonb_build_object('case_id',p_case,'contract_id',p_offer,'contract_version',v_version,'estimate_revision_id',p_estimate,'estimate_revision_number',v_est.revision_number,'amount_minor',v_est.amount_minor,'currency',v_est.currency,'issued_by',p_actor,'issued_at',now(),'expires_at',v_expires);
 insert into public.pa_contract_offers(id,inquiry_id,version,issued_at,expires_at,issued_by,snapshot,snapshot_sha256,quote_pdf,quote_sha256,estimate_revision_id)
 values(p_offer,p_case,v_version,now(),v_expires,p_actor,v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),v_doc.content,v_doc.sha256,p_estimate);
 insert into public.pa_contract_tokens(offer_id,token_hash) values(p_offer,p_token_hash);
 insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids,secret_envelope)
 values(v_outbox,p_case,p_operation,'confirmation',p_offer,p_recipient,p_subject,p_body,p_reply_binding,array[v_doc.id],p_secret_envelope);
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'formal_contract_issued',jsonb_build_object('contract_id',p_offer,'version',v_version,'estimate_revision_id',p_estimate,'operation_id',p_operation));
 return jsonb_build_object('id',p_offer,'version',v_version,'expires_at',v_expires,'outbox_id',v_outbox,'already_committed',false);
end $$;

create function public.pa_v5_revoke_confirmation(p_actor uuid,p_case uuid,p_offer uuid,p_operation uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state text; v_est uuid;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'revoke_reason_required'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found then raise exception 'case_unavailable'; end if;
 perform public.pa_v5_state(p_case);
 select t.state,o.estimate_revision_id into v_state,v_est from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.id=p_offer and o.inquiry_id=p_case for update of t;
 if not found then raise exception 'invalid_confirmation'; end if;
 if v_est is null then raise exception 'legacy_confirmation_reconciliation_required'; end if;
 if v_state='accepted' or exists(select 1 from public.pa_contracts where id=p_offer) then raise exception 'accepted_contract_immutable'; end if;
 if v_state='revoked' then return jsonb_build_object('id',p_offer,'state','revoked','already_committed',true); end if;
 update public.pa_contract_tokens set state='revoked' where offer_id=p_offer;
 update public.pa_commercial_outbox set state='cancelled',finished_at=now(),last_error_code='confirmation_revoked' where aggregate_id=p_offer and state in ('queued','failed');
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'formal_contract_revoked',jsonb_build_object('offer_id',p_offer,'reason',btrim(p_reason),'operation_id',p_operation));
 return jsonb_build_object('id',p_offer,'state','revoked','already_committed',false);
end $$;

create or replace function public.pa_contract_accept(p_token_hash text,p_offer_id uuid,p_snapshot_sha256 text,p_name text,p_agree boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_o public.pa_contract_offers%rowtype; v_state text; v_current uuid; v_snapshot jsonb; v_now timestamptz; v_status text;
begin
 select o.* into v_o from public.pa_contract_offers o join public.pa_contract_tokens t on t.offer_id=o.id where t.token_hash=p_token_hash;
 if not found or v_o.id<>p_offer_id or v_o.estimate_revision_id is null then raise exception 'invalid_link'; end if;
 select status into v_status from public.pa_inquiries where id=v_o.inquiry_id and deleted_at is null for update;
 if not found or v_status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
 perform public.pa_v5_state(v_o.inquiry_id);
 select current_estimate_revision_id into v_current from public.pa_case_commercial_state where inquiry_id=v_o.inquiry_id for update;
 select state into v_state from public.pa_contract_tokens where offer_id=v_o.id for update;
 if v_state='accepted' then return jsonb_build_object('state','accepted','id',v_o.id,'already_received',true); end if;
 if v_state<>'active' or v_current<>v_o.estimate_revision_id then raise exception 'invalid_link'; end if;
 v_now:=clock_timestamp();
 if v_now>=v_o.expires_at then raise exception 'expired_link'; end if;
 if p_snapshot_sha256 is distinct from v_o.snapshot_sha256 then raise exception 'contract_changed'; end if;
 if p_agree is distinct from true or p_name is null or length(trim(p_name)) not between 1 and 120 or p_name~'[[:cntrl:]]' then raise exception 'consent_required'; end if;
 if v_o.quote_sha256<>encode(sha256(v_o.quote_pdf),'hex') then raise exception 'quote_identity_mismatch'; end if;
 v_snapshot:=v_o.snapshot||jsonb_build_object('confirmer_name',trim(p_name),'confirmed_at',v_now,'confirmed_at_jst',to_char(v_now at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:MI:SS')||' JST','agreed',true);
 insert into public.pa_contracts values(v_o.id,v_o.inquiry_id,v_o.version,v_now,v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'));
 update public.pa_contract_tokens set state='accepted' where offer_id=v_o.id;
 update public.pa_case_progress set formal_contract_id=v_o.id,booking_confirmed_on=(v_now at time zone 'Asia/Tokyo')::date,estimate_approved_on=(v_now at time zone 'Asia/Tokyo')::date,confirmed_event_date=(v_snapshot->>'event_date')::date,estimate_amount=(v_snapshot->>'amount_minor')::numeric,current_step=greatest(current_step,9),updated_at=v_now where inquiry_id=v_o.inquiry_id;
 insert into public.pa_inquiry_audit(inquiry_id,action,details) values(v_o.inquiry_id,'formal_contract_accepted',jsonb_build_object('contract_id',v_o.id,'version',v_o.version,'estimate_revision_id',v_o.estimate_revision_id,'confirmed_at',v_now));
 return jsonb_build_object('state','accepted','id',v_o.id,'already_received',false);
end $$;

create function public.pa_v5_outbox_claim(p_actor uuid,p_job uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.pa_commercial_outbox%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select * into v_job from public.pa_commercial_outbox where id=p_job for update;
 if not found then raise exception 'outbox_not_found'; end if;
 if v_job.state='sent' then return jsonb_build_object('id',v_job.id,'state','sent','already_committed',true); end if;
 if v_job.state='unknown' then raise exception 'outbox_unknown_requires_reconciliation'; end if;
 if v_job.state='processing' and v_job.lease_expires_at>now() then raise exception 'outbox_busy'; end if;
 update public.pa_commercial_outbox set state='processing',lease_id=p_lease,lease_expires_at=now()+interval '10 minutes',attempt_count=attempt_count+1,last_error_code=null where id=p_job returning * into v_job;
 return to_jsonb(v_job)-'secret_envelope';
end $$;

create function public.pa_v5_outbox_finish(p_actor uuid,p_job uuid,p_lease uuid,p_state text,p_message text,p_thread text,p_error text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.pa_commercial_outbox%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_state not in ('sent','failed','unknown') then raise exception 'invalid_outbox_result'; end if;
 select * into v_job from public.pa_commercial_outbox where id=p_job for update;
 if not found or v_job.state<>'processing' or v_job.lease_id<>p_lease then raise exception 'outbox_lease_changed'; end if;
 update public.pa_commercial_outbox set state=p_state,provider_message_id=case when p_state='sent' then p_message end,provider_thread_id=case when p_state='sent' then p_thread end,last_error_code=case when p_state='sent' then null else p_error end,finished_at=now(),lease_expires_at=null where id=p_job returning * into v_job;
 if v_job.job_kind='invoice' then
   update public.pa_billings set invoice_delivery_state=p_state,updated_at=now() where id=v_job.aggregate_id;
 end if;
 return to_jsonb(v_job)-'secret_envelope';
end $$;

create function public.pa_v5_confirm_fulfillment_and_settlement(p_actor uuid,p_case uuid,p_expected_revision bigint,p_operation uuid,p_amount_minor bigint,p_unresolved boolean,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_operation is null or p_amount_minor<0 or jsonb_typeof(p_evidence)<>'object' then raise exception 'invalid_settlement'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
 v_state:=public.pa_v5_state(p_case); if v_state.settlement_operation_id=p_operation then return to_jsonb(v_state)||jsonb_build_object('already_committed',true); end if; if v_state.revision<>p_expected_revision then raise exception 'commercial_state_changed'; end if;
 update public.pa_case_commercial_state set fulfillment_state='confirmed',fulfillment_confirmed_at=now(),fulfillment_confirmed_by=p_actor,settlement_state=case when p_unresolved then 'difference_review' else 'confirmed' end,final_settlement_minor=p_amount_minor,unresolved_changes=p_unresolved,settlement_evidence=p_evidence,settlement_operation_id=p_operation,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'fulfillment_settlement_confirmed',jsonb_build_object('amount_minor',p_amount_minor,'unresolved_changes',p_unresolved,'evidence',p_evidence,'operation_id',p_operation));
 return to_jsonb(v_state);
end $$;

create function public.pa_v5_create_billing(p_actor uuid,p_case uuid,p_expected_revision bigint,p_operation uuid,p_contract uuid,p_estimate uuid,p_amount_minor bigint,p_policy text,p_document_id uuid,p_filename text,p_content_base64 text,p_sha256 text,p_due date,p_due_basis jsonb,p_customer_planned date,p_evidence jsonb,p_recipient text,p_subject text,p_body text,p_reply_binding jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype; v_id uuid:=gen_random_uuid(); v_number integer; v_bytes bytea; v_existing public.pa_billings%rowtype; v_outbox uuid;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select * into v_existing from public.pa_billings where operation_id=p_operation; if found then return to_jsonb(v_existing)||jsonb_build_object('already_committed',true); end if;
 if p_policy not in ('separate_pdf','no_separate_invoice') or jsonb_typeof(p_due_basis)<>'object' or jsonb_typeof(p_evidence)<>'object' or jsonb_typeof(p_reply_binding)<>'object' then raise exception 'invalid_billing'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
 v_state:=public.pa_v5_state(p_case);
 if v_state.revision<>p_expected_revision or v_state.fulfillment_state<>'confirmed' or v_state.settlement_state<>'confirmed' or v_state.unresolved_changes or v_state.final_settlement_minor<>p_amount_minor then raise exception 'settlement_not_ready'; end if;
 if not exists(select 1 from public.pa_contracts where id=p_contract and inquiry_id=p_case) then raise exception 'contract_not_found'; end if;
 if not exists(select 1 from public.pa_estimate_revisions where id=p_estimate and inquiry_id=p_case) then raise exception 'estimate_not_found'; end if;
 if p_due is null and p_due_basis->>'status'<>'unconfirmed' then raise exception 'due_date_evidence_required'; end if;
 if p_policy='separate_pdf' then
   v_bytes:=decode(p_content_base64,'base64'); if p_document_id is null or encode(sha256(v_bytes),'hex')<>p_sha256 then raise exception 'document_identity_mismatch'; end if;
   insert into public.pa_commercial_documents(id,inquiry_id,document_kind,source_kind,original_filename,mime_type,content,sha256,created_by) values(p_document_id,p_case,'invoice','private_upload',p_filename,'application/pdf',v_bytes,p_sha256,p_actor);
 elsif p_document_id is not null or coalesce(p_content_base64,'')<>'' then raise exception 'invoice_document_not_allowed'; end if;
 select coalesce(max(billing_number),0)+1 into v_number from public.pa_billings where inquiry_id=p_case;
 insert into public.pa_billings(id,inquiry_id,billing_number,contract_id,estimate_revision_id,amount_minor,invoice_policy,invoice_document_id,invoice_delivery_state,due_date,due_basis,customer_planned_payment_on,agreement_evidence,operation_id,created_by)
 values(v_id,p_case,v_number,p_contract,p_estimate,p_amount_minor,p_policy,p_document_id,case when p_policy='separate_pdf' then 'registered' else 'not_required' end,p_due,p_due_basis,p_customer_planned,p_evidence,p_operation,p_actor);
 if p_policy='separate_pdf' then
   if p_recipient not like '%@%' or char_length(coalesce(p_subject,'')) not between 1 and 998 or char_length(coalesce(p_body,'')) not between 1 and 20000 then raise exception 'invalid_billing_mail'; end if;
   v_outbox:=gen_random_uuid();
   insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids)
   values(v_outbox,p_case,p_operation,'invoice',v_id,p_recipient,p_subject,p_body,p_reply_binding,array[p_document_id]);
   update public.pa_billings set invoice_delivery_state='queued' where id=v_id;
 end if;
 update public.pa_case_progress set invoice_amount=p_amount_minor::numeric,invoice_issued_on=case when p_policy='separate_pdf' then (now() at time zone 'Asia/Tokyo')::date else invoice_issued_on end,payment_due_on=p_due,invoice_sent=(p_policy='no_separate_invoice'),invoice_memo=case when p_policy='no_separate_invoice' then '既存書類を使用・請求書は別途発行しない' else invoice_memo end,updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'billing_created',jsonb_build_object('billing_id',v_id,'invoice_policy',p_policy,'amount_minor',p_amount_minor,'due_date',p_due,'operation_id',p_operation));
 return jsonb_build_object('id',v_id,'billing_number',v_number,'outbox_id',v_outbox,'already_committed',false);
end $$;

create function public.pa_v5_record_payment(p_actor uuid,p_case uuid,p_billing uuid,p_operation uuid,p_payment_date date,p_amount_minor bigint,p_method text,p_memo text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid; v_existing uuid;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select id into v_existing from public.pa_payment_records where operation_id=p_operation; if found then return jsonb_build_object('id',v_existing,'already_committed',true); end if;
 if p_amount_minor<=0 or p_method not in ('bank_transfer','cash','other') or p_payment_date is null then raise exception 'invalid_payment'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update; if not found then raise exception 'case_unavailable'; end if;
 perform public.pa_v5_state(p_case);
 perform 1 from public.pa_billings where id=p_billing and inquiry_id=p_case and state='open' for update; if not found then raise exception 'billing_not_open'; end if;
 v_id:=gen_random_uuid();
 insert into public.pa_payment_records(id,inquiry_id,confirmation_source,payment_date,amount,payment_method,confirmation_memo,confirmed_by,confirmed_by_label,confirmed_at,external_transaction_id,billing_id,operation_id,recorded_only)
 values(v_id,p_case,'manual',p_payment_date,p_amount_minor::numeric,p_method,nullif(btrim(coalesce(p_memo,'')),''),p_actor,p_actor::text,now(),null,p_billing,p_operation,true);
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'payment_recorded',jsonb_build_object('payment_id',v_id,'billing_id',p_billing,'amount_minor',p_amount_minor,'payment_date',p_payment_date,'operation_id',p_operation));
 return jsonb_build_object('id',v_id,'already_committed',false);
end $$;

create function public.pa_v5_adjust_payment(p_actor uuid,p_case uuid,p_billing uuid,p_payment uuid,p_operation uuid,p_delta_minor bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid(); v_existing uuid;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select id into v_existing from public.pa_payment_adjustments where operation_id=p_operation; if found then return jsonb_build_object('id',v_existing,'already_committed',true); end if;
 if p_delta_minor=0 or char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_payment_adjustment'; end if;
 perform 1 from public.pa_inquiries where id=p_case for update; if not found then raise exception 'case_unavailable'; end if;
 perform 1 from public.pa_payment_records where id=p_payment and inquiry_id=p_case and billing_id=p_billing for share; if not found then raise exception 'payment_not_found'; end if;
 insert into public.pa_payment_adjustments values(v_id,p_case,p_billing,p_payment,p_delta_minor,btrim(p_reason),p_operation,now(),p_actor);
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'payment_adjusted',jsonb_build_object('payment_id',p_payment,'billing_id',p_billing,'delta_minor',p_delta_minor,'reason',btrim(p_reason),'operation_id',p_operation));
 return jsonb_build_object('id',v_id,'already_committed',false);
end $$;

create function public.pa_v5_payment_and_close(p_actor uuid,p_case uuid,p_billing uuid,p_expected_revision bigint,p_operation uuid,p_payment_date date,p_new_payment_minor bigint,p_method text,p_memo text)
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
 select coalesce(sum(round(p.amount)::bigint),0)+coalesce((select sum(a.delta_minor) from public.pa_payment_adjustments a where a.billing_id=p_billing),0) into v_paid from public.pa_payment_records p where p.billing_id=p_billing;
 if v_paid<>v_bill.amount_minor or v_paid<>v_state.final_settlement_minor then raise exception 'payment_balance_not_zero'; end if;
 update public.pa_billings set state='paid',updated_at=now() where id=p_billing;
 update public.pa_case_progress set current_step=14,is_on_hold=false,close_reason='payment_received',closed_from_step=13,closed_at=now(),updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
 update public.pa_inquiries set status='closed' where id=p_case;
 update public.pa_case_commercial_state set closed_operation_id=p_operation,revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'payment_confirmed_and_closed_v5',jsonb_build_object('billing_id',p_billing,'payment_id',v_payment,'confirmed_total_minor',v_paid,'operation_id',p_operation));
 return jsonb_build_object('state','closed','payment_id',v_payment,'confirmed_total_minor',v_paid,'already_committed',false);
end $$;

create function public.pa_v5_reopen_case(p_actor uuid,p_case uuid,p_operation uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.pa_case_commercial_state%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_operation is null or char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'reopen_reason_required'; end if;
 perform 1 from public.pa_inquiries where id=p_case for update; if not found then raise exception 'case_unavailable'; end if;
 v_state:=public.pa_v5_state(p_case);
 if v_state.reopen_operation_id=p_operation then return to_jsonb(v_state)||jsonb_build_object('already_committed',true); end if;
 update public.pa_case_progress set current_step=13,close_reason=null,closed_from_step=null,closed_at=null,updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
 update public.pa_inquiries set status='schedule_confirmed' where id=p_case and status='closed';
 update public.pa_billings set state='open',updated_at=now() where inquiry_id=p_case and state='paid';
 update public.pa_case_commercial_state set closed_operation_id=null,reopen_operation_id=p_operation,reopened_at=now(),revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case returning * into v_state;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'case_reopened_v5',jsonb_build_object('reason',btrim(p_reason),'operation_id',p_operation,'payments_preserved',true,'contract_preserved',true));
 return to_jsonb(v_state);
end $$;

create function public.pa_v5_purge_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.pa_estimate_revisions where inquiry_id=old.id)
   or exists(select 1 from public.pa_contracts where inquiry_id=old.id)
   or exists(select 1 from public.pa_billings where inquiry_id=old.id)
   or exists(select 1 from public.pa_payment_records where inquiry_id=old.id)
 then raise exception 'commercial_history_requires_retention'; end if;
 return old;
end $$;
create trigger pa_v5_purge_guard before delete on public.pa_inquiries for each row execute function public.pa_v5_purge_guard();

alter table public.pa_commercial_documents enable row level security;
alter table public.pa_estimate_revisions enable row level security;
alter table public.pa_case_commercial_state enable row level security;
alter table public.pa_commercial_outbox enable row level security;
alter table public.pa_billings enable row level security;
alter table public.pa_payment_adjustments enable row level security;
alter table public.pa_change_orders enable row level security;

revoke all on public.pa_commercial_documents,public.pa_estimate_revisions,public.pa_case_commercial_state,public.pa_commercial_outbox,public.pa_billings,public.pa_payment_adjustments,public.pa_change_orders from public,anon,authenticated;
grant select,insert on public.pa_commercial_documents,public.pa_estimate_revisions,public.pa_payment_adjustments,public.pa_change_orders to service_role;
grant select,insert,update on public.pa_case_commercial_state,public.pa_commercial_outbox,public.pa_billings to service_role;

revoke all on function public.pa_contract_issue(uuid,uuid,uuid,text,jsonb,text) from service_role;
revoke all on function public.pa_v5_immutable_history(),public.pa_v5_outbox_guard(),public.pa_v5_purge_guard(),public.pa_v5_assert_admin(uuid),public.pa_v5_state(uuid) from public,anon,authenticated;
revoke all on function public.pa_v5_begin_estimate_revision(uuid,uuid,bigint,uuid,text) from public,anon,authenticated;
revoke all on function public.pa_v5_issue_estimate(uuid,uuid,bigint,uuid,uuid,uuid,text,text,text,text,bigint,text,text,jsonb,text,timestamptz,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.pa_v5_issue_confirmation(uuid,uuid,bigint,uuid,uuid,uuid,text,text,jsonb,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.pa_v5_revoke_confirmation(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.pa_v5_outbox_claim(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.pa_v5_outbox_finish(uuid,uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.pa_v5_confirm_fulfillment_and_settlement(uuid,uuid,bigint,uuid,bigint,boolean,jsonb) from public,anon,authenticated;
revoke all on function public.pa_v5_create_billing(uuid,uuid,bigint,uuid,uuid,uuid,bigint,text,uuid,text,text,text,date,jsonb,date,jsonb,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.pa_v5_record_payment(uuid,uuid,uuid,uuid,date,bigint,text,text) from public,anon,authenticated;
revoke all on function public.pa_v5_adjust_payment(uuid,uuid,uuid,uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function public.pa_v5_payment_and_close(uuid,uuid,uuid,bigint,uuid,date,bigint,text,text) from public,anon,authenticated;
revoke all on function public.pa_v5_reopen_case(uuid,uuid,uuid,text) from public,anon,authenticated;

grant execute on function public.pa_v5_begin_estimate_revision(uuid,uuid,bigint,uuid,text) to service_role;
grant execute on function public.pa_v5_issue_estimate(uuid,uuid,bigint,uuid,uuid,uuid,text,text,text,text,bigint,text,text,jsonb,text,timestamptz,text,text,text,jsonb) to service_role;
grant execute on function public.pa_v5_issue_confirmation(uuid,uuid,bigint,uuid,uuid,uuid,text,text,jsonb,text,text,text,jsonb) to service_role;
grant execute on function public.pa_v5_revoke_confirmation(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.pa_v5_outbox_claim(uuid,uuid,uuid),public.pa_v5_outbox_finish(uuid,uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.pa_v5_confirm_fulfillment_and_settlement(uuid,uuid,bigint,uuid,bigint,boolean,jsonb) to service_role;
grant execute on function public.pa_v5_create_billing(uuid,uuid,bigint,uuid,uuid,uuid,bigint,text,uuid,text,text,text,date,jsonb,date,jsonb,text,text,text,jsonb) to service_role;
grant execute on function public.pa_v5_record_payment(uuid,uuid,uuid,uuid,date,bigint,text,text),public.pa_v5_adjust_payment(uuid,uuid,uuid,uuid,uuid,bigint,text) to service_role;
grant execute on function public.pa_v5_payment_and_close(uuid,uuid,uuid,bigint,uuid,date,bigint,text,text),public.pa_v5_reopen_case(uuid,uuid,uuid,text) to service_role;

commit;

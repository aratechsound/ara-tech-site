-- PAUI-057 candidate ONLY. Never apply to Production without exact-SHA approval.
-- Records already delivered originals; creates NO outbox, token, mail or receipt.
begin;
create table public.pa_sent_quote_adoptions_v1 (
 id uuid primary key default gen_random_uuid(),
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 operation_id uuid not null unique,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 gmail_message_id text not null, gmail_thread_id text not null, part_id text not null,
 quote_sha256 text not null check(quote_sha256 ~ '^[a-f0-9]{64}$'),
 approval_message_id text not null, approval_thread_id text not null,
 contract_id uuid references public.pa_contracts(id) on delete restrict,
 estimate_revision_id uuid not null references public.pa_estimate_revisions(id) on delete restrict,
 change_order_id uuid references public.pa_change_orders(id) on delete restrict,
 adoption_event_id uuid references public.pa_change_evidence_events(id) on delete restrict,
 document_amount_minor bigint not null check(document_amount_minor>0),
 revised_total_minor bigint not null check(revised_total_minor>0),
 additional_amount_minor bigint not null check(additional_amount_minor>=0),
 amount_basis text not null check(amount_basis in ('initial_total','revised_total')),
 request jsonb not null check(jsonb_typeof(request)='object'),
 evidence jsonb not null check(jsonb_typeof(evidence)='object'),
 unique(inquiry_id,gmail_message_id,part_id,quote_sha256),
 check((contract_id is null and change_order_id is null and adoption_event_id is null and amount_basis='initial_total' and additional_amount_minor=0)
    or(contract_id is not null and change_order_id is not null and adoption_event_id is not null and amount_basis<>'initial_total'))
);
alter table public.pa_sent_quote_adoptions_v1 enable row level security;
revoke all on public.pa_sent_quote_adoptions_v1 from public,anon,authenticated,service_role;
grant select on public.pa_sent_quote_adoptions_v1 to service_role;
create trigger pa_sent_quote_adoptions_v1_immutable before update or delete on public.pa_sent_quote_adoptions_v1
 for each row execute function public.pa_v5_immutable_history();

create function public.pa_sent_quote_adopt_v1(
 p_actor uuid,p_case uuid,p_operation uuid,p_request jsonb,p_evidence jsonb,p_content_base64 text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 r public.pa_sent_quote_adoptions_v1%rowtype; c public.pa_contracts%rowtype;
 s public.pa_case_commercial_state%rowtype; q public.pa_gmail_message_index%rowtype;
 a public.pa_gmail_message_index%rowtype; old public.pa_change_evidence_events%rowtype;
 last_event public.pa_change_evidence_events%rowtype; att jsonb; b bytea;
 doc_id uuid:=gen_random_uuid(); est_id uuid:=gen_random_uuid(); change_id uuid:=gen_random_uuid();
 event_id uuid; operation_result jsonb; evidence jsonb; q_amount bigint; total bigint; delta bigint; base bigint;
 n integer; mode text; tax text; conditions jsonb; contract_id uuid; row_id uuid; sent_at timestamptz; approval_at timestamptz;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_operation is null or jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_evidence) is distinct from 'object'
   or octet_length(p_request::text)>50000 or octet_length(p_evidence::text)>250000
   or coalesce(p_request->>'preview_fingerprint','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_sent_quote';end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null and status not in ('closed','cancelled','declined','schedule_unavailable') for update;
 if not found then raise exception 'case_unavailable';end if;
 select * into r from public.pa_sent_quote_adoptions_v1 where operation_id=p_operation;
 if found then
  if r.created_by<>p_actor or r.inquiry_id<>p_case or r.request<>p_request then raise exception 'idempotency_payload_mismatch';end if;
  return jsonb_build_object('id',r.id,'complete',true,'already_committed',true);
 end if;
 if exists(select 1 from public.pa_sent_quote_adoptions_v1 where inquiry_id=p_case and gmail_message_id=p_request->>'gmail_message_id'
    and part_id=p_request->>'part_id' and quote_sha256=p_request->>'sha256') then raise exception 'sent_quote_already_registered';end if;
 if exists(select 1 from public.pa_commercial_outbox where inquiry_id=p_case and state in ('unknown','processing')) then raise exception 'sent_quote_commercial_hold';end if;
 s:=public.pa_v5_state(p_case);
 if s.revision is distinct from (p_request->>'expected_revision')::bigint
   or s.current_estimate_revision_id is distinct from nullif(p_request->>'expected_current','')::uuid then raise exception 'commercial_state_changed';end if;
 if p_evidence->>'case_id' is distinct from p_case::text or p_evidence->'quote'->>'message_id' is distinct from p_request->>'gmail_message_id'
  or p_evidence->'quote'->>'thread_id' is distinct from p_request->>'gmail_thread_id'
  or p_evidence->'quote'->>'part_id' is distinct from p_request->>'part_id'
  or p_evidence->'quote'->>'sha256' is distinct from p_request->>'sha256'
  or p_evidence->'approval'->>'message_id' is distinct from p_request->>'approval_message_id'
  or p_evidence->'approval'->>'thread_id' is distinct from p_request->>'approval_thread_id'
  or coalesce(p_evidence->'approval'->>'status','') not in ('verified','owner_reviewed')
  or p_evidence->'approval'->>'status'='verified' and p_evidence->'approval'->>'exact_quote_reference' is distinct from 'true'
  or p_evidence->'approval'->>'status'='owner_reviewed' and (p_request->>'owner_approval_confirmed' is distinct from 'true'
    or char_length(btrim(coalesce(p_request->>'owner_approval_reason',''))) not between 10 and 2000
    or p_evidence->>'owner_reason' is distinct from p_request->>'owner_approval_reason')
  or p_evidence->'approval'->>'linked' is distinct from 'true'
  or p_evidence->>'owner_confirmed' is distinct from 'true' then raise exception 'sent_quote_identity_mismatch';end if;
 select * into q from public.pa_gmail_message_index where inquiry_id=p_case and gmail_message_id=p_request->>'gmail_message_id'
  and gmail_thread_id=p_request->>'gmail_thread_id' and direction='outbound' and message_source in ('gmail_direct','pa_case_manager');
 if not found then raise exception 'sent_quote_identity_mismatch';end if;
 if nullif(p_request->>'reply_operation_id','') is not null then
  if not exists(select 1 from public.pa_reply_operations_v1 o join lateral(select state,evidence from public.pa_reply_operation_events_v1 where operation_id=o.operation_id order by seq desc limit 1) e on true
   where o.operation_id=(p_request->>'reply_operation_id')::uuid and o.inquiry_id=p_case and o.actor_id=p_actor and o.binding->>'thread_id'=q.gmail_thread_id
    and e.state='SENT' and e.evidence->>'gmail_message_id'=q.gmail_message_id) then raise exception 'sent_quote_identity_mismatch';end if;
 else
  if exists(select 1 from public.pa_reply_operations_v1 o join lateral(select state from public.pa_reply_operation_events_v1 where operation_id=o.operation_id order by seq desc limit 1) e on true
   where o.inquiry_id=p_case and o.binding->>'thread_id'=q.gmail_thread_id and e.state in ('SENDING','UNKNOWN')) then raise exception 'sent_quote_commercial_hold';end if;
 end if;
 select value into att from jsonb_array_elements(q.attachment_metadata) where value->>'id'=p_evidence->'quote'->>'attachment_id' and value->>'part_id'=p_request->>'part_id';
 if att is null or att->>'mime_type'<>'application/pdf'
  or (select count(*) from jsonb_array_elements(q.attachment_metadata) x where x->>'id'=p_evidence->'quote'->>'attachment_id' and x->>'part_id'=p_request->>'part_id')<>1
  or p_evidence->'quote'->>'source' is distinct from 'gmail' then raise exception 'sent_quote_identity_mismatch';end if;
 select * into a from public.pa_gmail_message_index where inquiry_id=p_case and gmail_message_id=p_request->>'approval_message_id'
  and gmail_thread_id=p_request->>'approval_thread_id' and direction='inbound';
 sent_at:=(p_evidence->'quote'->>'sent_at')::timestamptz;approval_at:=(p_evidence->'approval'->>'occurred_at')::timestamptz;
 if not found or sent_at is null or approval_at is null or approval_at<sent_at
  or q.sent_at is not null and q.sent_at<>sent_at or a.received_at is not null and a.received_at<>approval_at
  or exists(select 1 from public.pa_gmail_message_index where gmail_message_id in (q.gmail_message_id,a.gmail_message_id) and inquiry_id<>p_case)
  or exists(select 1 from public.pa_gmail_thread_links where gmail_thread_id in(q.gmail_thread_id,a.gmail_thread_id) and inquiry_id<>p_case)
  then raise exception 'sent_quote_identity_mismatch';end if;
 b:=decode(p_content_base64,'base64');
 if octet_length(b) not between 20 and 1500000 or encode(sha256(b),'hex') is distinct from p_request->>'sha256'
  or substring(b from 1 for 5)<>decode('255044462d','hex') then raise exception 'document_identity_mismatch';end if;
 q_amount:=(p_request->>'document_amount_minor')::bigint;total:=(p_request->>'revised_total_minor')::bigint;
 delta:=(p_request->>'additional_amount_minor')::bigint;mode:=p_request->>'amount_basis';tax:=p_request->>'tax_basis';conditions:=p_request->'conditions';
 if q_amount is null or total is null or delta is null or q_amount not between 1 and 9999999999 or total not between 1 and 9999999999
  or delta not between 0 and 9999999999 or coalesce(tax,'') not in ('tax_included','tax_excluded','tax_exempt') or jsonb_typeof(conditions) is distinct from 'object'
  or p_request->>'currency' is distinct from 'JPY' or p_request->>'owner_amounts_confirmed' is distinct from 'true'
  or p_evidence->'quote'->>'amount_minor' is distinct from q_amount::text or p_evidence->'quote'->>'tax_basis' is distinct from tax then raise exception 'sent_quote_amounts_unconfirmed';end if;
 contract_id:=nullif(p_request->>'contract_id','')::uuid;
 select * into last_event from public.pa_change_evidence_events where inquiry_id=p_case order by event_number desc limit 1;
 if last_event.id is distinct from nullif(p_request->>'previous_event_id','')::uuid then raise exception 'change_evidence_changed';end if;
 if contract_id is null then
  if exists(select 1 from public.pa_contracts where inquiry_id=p_case) or mode is distinct from 'initial_total' or total<>q_amount or delta<>0
   then raise exception 'post_contract_change_required';end if;
  operation_result:=public.pa_v5_import_sent_estimate(p_actor,p_case,s.revision,s.current_estimate_revision_id,p_operation,'current',doc_id,
   p_evidence->'quote'->>'filename',encode(b,'base64'),p_request->>'sha256',q_amount,'JPY',tax,conditions,q.gmail_message_id,att->>'id');
  est_id:=(operation_result->>'id')::uuid;change_id:=null;
 else
  select * into c from public.pa_contracts where id=contract_id and inquiry_id=p_case;
  if not found or (select count(*) from public.pa_contracts where inquiry_id=p_case)<>1
   or sent_at<c.confirmed_at
   or p_evidence->>'contract_sha256' is distinct from encode(sha256(convert_to(c.snapshot::text,'UTF8')),'hex')
   then raise exception 'sent_quote_identity_mismatch';end if;
  if s.settlement_state<>'unsettled' or s.unresolved_changes or exists(select 1 from public.pa_billings where inquiry_id=p_case)
   or exists(select 1 from public.pa_change_orders where inquiry_id=p_case and state in ('proposal','customer_acknowledged')) then raise exception 'sent_quote_commercial_hold';end if;
  if tax not in ('tax_included','tax_exempt') or coalesce(c.snapshot->>'currency','JPY')<>'JPY' or not exists(select 1 from public.pa_estimate_revisions e
    where e.id=(c.snapshot->>'estimate_revision_id')::uuid and e.inquiry_id=p_case and e.tax_basis=tax)
   then raise exception 'sent_quote_amounts_unconfirmed';end if;
  base:=(c.snapshot->>'amount_minor')::bigint+coalesce((select sum(agreed_amount_minor) from public.pa_change_orders where inquiry_id=p_case and state='agreed'),0);
  if base is null or base<=0 or delta<=0 or total<>base+delta or (p_request->>'base_amount_minor')::bigint is distinct from base
    or mode is distinct from 'revised_total' or q_amount<>total
    then raise exception 'sent_quote_amounts_unconfirmed';end if;
  -- Existing originals are immutable. Ambiguous historical imports are reviewed,
  -- never relabelled, converted to current, overwritten or silently duplicated.
  if exists(select 1 from public.pa_commercial_documents where inquiry_id=p_case and (sha256=p_request->>'sha256' or gmail_message_id=q.gmail_message_id and gmail_attachment_id=att->>'id'))
    then raise exception 'sent_quote_existing_registration_hold';end if;
  select coalesce(max(revision_number),0)+1 into n from public.pa_estimate_revisions where inquiry_id=p_case and series='change_order';
  insert into public.pa_commercial_documents(id,inquiry_id,document_kind,source_kind,gmail_message_id,gmail_attachment_id,original_filename,mime_type,content,sha256,metadata,created_by)
   values(doc_id,p_case,'estimate','sent_recovery',q.gmail_message_id,att->>'id',p_evidence->'quote'->>'filename','application/pdf',b,p_request->>'sha256',
    jsonb_build_object('source_sent_at',sent_at,'registration_source','PAUI-057','amount_basis',mode,'document_amount_minor',q_amount,'revised_total_minor',total,'additional_amount_minor',delta),p_actor);
  insert into public.pa_estimate_revisions(id,inquiry_id,revision_number,series,parent_contract_id,document_id,amount_minor,currency,tax_basis,conditions_snapshot,source_kind,lifecycle,source_sent_at,issued_by,operation_id)
   values(est_id,p_case,n,'change_order',contract_id,doc_id,q_amount,'JPY',tax,conditions,'sent_recovery','issued',sent_at,p_actor,p_operation);
  -- Reuse the existing immutable delivery-evidence reader. 'historical' here
  -- records delivery only; the separate verified agreement below is required.
  insert into public.pa_estimate_delivery_evidence(id,inquiry_id,estimate_revision_id,gmail_message_id,gmail_attachment_id,registration_mode,requested_document_id,recipient,source_sent_at,operation_id,recorded_by)
   values(gen_random_uuid(),p_case,est_id,q.gmail_message_id,att->>'id','historical',doc_id,p_evidence->'quote'->'recipients'->>0,sent_at,p_operation,p_actor);
  -- This is a new verified already-delivered agreement contract. It does NOT
  -- manufacture a managed-send ACK or relax pa_v5_record_change_agreement.
  insert into public.pa_change_orders(id,inquiry_id,contract_id,estimate_revision_id,proposal_document_id,state,agreement_evidence,agreed_amount_minor,operation_id,created_by,agreement_operation_id,agreed_at,agreed_by)
   values(change_id,p_case,contract_id,est_id,doc_id,'agreed',jsonb_build_object('source','customer_email','reference',a.gmail_message_id,'registration_source','PAUI-057','quote_sha256',p_request->>'sha256'),delta,p_operation,p_actor,p_operation,now(),p_actor);
  if nullif(p_request->>'existing_adoption_id','') is not null then
   select * into old from public.pa_change_evidence_events where inquiry_id=p_case and event_kind in ('adopted','revoked') order by event_number desc limit 1;
   if old.id is distinct from (p_request->>'existing_adoption_id')::uuid or old.event_kind<>'adopted' or old.contract_id<>contract_id
    or old.evidence->>'contract_sha256' is distinct from p_evidence->>'contract_sha256'
    or old.evidence->'quote'->>'sha256' is distinct from p_request->>'sha256'
    or old.evidence->'quote'->>'message_id' is distinct from q.gmail_message_id
    or old.evidence->'quote'->>'thread_id' is distinct from q.gmail_thread_id
    or old.evidence->'quote'->>'part_id' is distinct from p_request->>'part_id'
    or old.evidence->'quote'->>'amount_minor' is distinct from q_amount::text
    or old.evidence->'quote'->>'tax_basis' is distinct from tax
    or old.evidence->'approval'->>'message_id' is distinct from a.gmail_message_id
    or old.evidence->'approval'->>'thread_id' is distinct from a.gmail_thread_id then raise exception 'change_evidence_changed';end if;
   event_id:=old.id;
  else
   evidence:=jsonb_set(jsonb_set(p_evidence,'{quote,estimate_id}',to_jsonb(est_id::text)),'{quote,document_id}',to_jsonb(doc_id::text));
   operation_result:=public.pa_change_evidence_append(p_actor,p_case,contract_id,p_operation,last_event.id,'adopted',evidence,p_evidence->>'owner_reason','[]'::jsonb);
   event_id:=(operation_result->>'id')::uuid;
  end if;
  update public.pa_case_commercial_state set revision=revision+1,updated_at=now(),updated_by=p_actor where inquiry_id=p_case;
 end if;
 insert into public.pa_sent_quote_adoptions_v1(inquiry_id,operation_id,created_by,gmail_message_id,gmail_thread_id,part_id,quote_sha256,approval_message_id,approval_thread_id,
  contract_id,estimate_revision_id,change_order_id,adoption_event_id,document_amount_minor,revised_total_minor,additional_amount_minor,amount_basis,request,evidence)
 values(p_case,p_operation,p_actor,q.gmail_message_id,q.gmail_thread_id,p_request->>'part_id',p_request->>'sha256',a.gmail_message_id,a.gmail_thread_id,
  contract_id,est_id,change_id,event_id,q_amount,total,delta,mode,p_request,p_evidence) returning id into row_id;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'sent_quote_adopted',jsonb_build_object('registration_id',row_id,'operation_id',p_operation,'estimate_revision_id',est_id,'change_order_id',change_id,'no_send',true));
 return jsonb_build_object('id',row_id,'complete',true,'already_committed',false);
end $$;
revoke all on function public.pa_sent_quote_adopt_v1(uuid,uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.pa_sent_quote_adopt_v1(uuid,uuid,uuid,jsonb,jsonb,text) to service_role;
commit;

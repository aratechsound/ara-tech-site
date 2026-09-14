-- PA-EST-007R1: owner-controlled Production E2E clone and delivery recovery.
-- Every mutation is restricted to an audited clone of the named source case and
-- the single owner mailbox. The real case is only read under row locks.
begin;

do $$
begin
  if to_regclass('public.pa_commercial_outbox') is null
    or to_regclass('public.pa_gmail_thread_links') is null
    or to_regprocedure('public.pa_v5_assert_admin(uuid)') is null
  then raise exception 'PA-EST-007R1 prerequisites are missing'; end if;
end $$;

create table public.pa_production_e2e_tests (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  source_case_id uuid not null references public.pa_inquiries(id) on delete restrict,
  test_case_id uuid not null unique references public.pa_inquiries(id) on delete restrict,
  source_estimate_id uuid not null references public.pa_estimate_revisions(id) on delete restrict,
  test_estimate_id uuid not null unique references public.pa_estimate_revisions(id) on delete restrict,
  source_document_id uuid not null references public.pa_commercial_documents(id) on delete restrict,
  test_document_id uuid not null unique references public.pa_commercial_documents(id) on delete restrict,
  allowed_recipient text not null check (lower(btrim(allowed_recipient))='tonokun@gmail.com'),
  source_estimate_sha text not null check (source_estimate_sha='79d0357eb94d7c9aeb81e0d1621aa9119242c76cd0f3ed3f0d7456d879972f6a'),
  source_confirmation_subject text not null check (char_length(source_confirmation_subject) between 1 and 998),
  state text not null default 'active' check (state in ('active','archived')),
  failpoint_operation_id uuid unique,
  failpoint_armed_at timestamptz,
  failpoint_fired_at timestamptz,
  failpoint_job_id uuid unique references public.pa_commercial_outbox(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  check ((state='active' and archived_at is null) or (state='archived' and archived_at is not null)),
  check (failpoint_fired_at is null or (failpoint_armed_at is not null and failpoint_job_id is not null))
);

alter table public.pa_production_e2e_tests enable row level security;
create policy "PA admins read Production E2E tests"
  on public.pa_production_e2e_tests for select to authenticated
  using (public.is_work_admin());
revoke all on public.pa_production_e2e_tests from public,anon,authenticated;
grant select on public.pa_production_e2e_tests to authenticated;

create function public.pa_production_e2e_clone_case(
  p_actor uuid,p_source_case uuid,p_allowed_recipient text,p_operation uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  c_source constant uuid:='cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3';
  c_sha constant text:='79d0357eb94d7c9aeb81e0d1621aa9119242c76cd0f3ed3f0d7456d879972f6a';
  c_marker constant text:='[TEST] 2026龍姫湖まつり 正式受注E2E';
  v_existing public.pa_production_e2e_tests%rowtype;
  v_case public.pa_inquiries%rowtype;
  v_progress public.pa_case_progress%rowtype;
  v_state public.pa_case_commercial_state%rowtype;
  v_estimate public.pa_estimate_revisions%rowtype;
  v_document public.pa_commercial_documents%rowtype;
  v_test_case uuid:=gen_random_uuid();
  v_test_estimate uuid:=gen_random_uuid();
  v_test_document uuid:=gen_random_uuid();
  v_subject text;
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_existing from public.pa_production_e2e_tests where operation_id=p_operation;
  if found then
    return jsonb_build_object('test_case_id',v_existing.test_case_id,'test_estimate_id',v_existing.test_estimate_id,
      'test_document_id',v_existing.test_document_id,'estimate_sha',v_existing.source_estimate_sha,'already_committed',true);
  end if;
  if p_source_case is distinct from c_source or lower(btrim(coalesce(p_allowed_recipient,'')))<>'tonokun@gmail.com' then
    raise exception 'invalid_production_e2e_test';
  end if;

  select * into v_case from public.pa_inquiries where id=c_source and deleted_at is null for share;
  if not found or lower(btrim(v_case.email))<>'t.takebayashi515@akiota.jp'
    or btrim(v_case.event_name)<>'2026龍姫湖まつり' or v_case.event_date<>date '2026-10-18'
    or btrim(v_case.event_time)<>'10:00〜15:00'
    or btrim(v_case.venue)<>'温井ダム堤体横駐車場（広島県山県郡安芸太田町加計1956-2）'
  then raise exception 'invalid_production_e2e_test'; end if;
  select * into v_progress from public.pa_case_progress where inquiry_id=c_source for share;
  select * into v_state from public.pa_case_commercial_state where inquiry_id=c_source for share;
  select * into v_estimate from public.pa_estimate_revisions
    where id=v_state.current_estimate_revision_id and inquiry_id=c_source for share;
  select * into v_document from public.pa_commercial_documents
    where id=v_estimate.document_id and inquiry_id=c_source for share;
  if v_estimate.revision_number<>2 or v_estimate.amount_minor<>198550 or v_estimate.currency<>'JPY'
    or v_document.original_filename<>'見積書 2026.09.11 龍姫湖まつり（改訂）.pdf'
    or v_document.sha256<>c_sha or v_document.sha256<>encode(sha256(v_document.content),'hex')
  then raise exception 'invalid_production_e2e_test'; end if;
  select x.subject into v_subject
    from public.pa_contract_offers o
    join public.pa_contract_tokens t on t.offer_id=o.id and t.state='active'
    join public.pa_commercial_outbox x on x.aggregate_id=o.id and x.job_kind='confirmation'
   where o.inquiry_id=c_source and o.version=6
   order by x.created_at desc limit 1;
  if v_subject is null then raise exception 'invalid_production_e2e_test'; end if;

  insert into public.pa_inquiries(
    id,inquiry_number,received_at,created_at,updated_at,created_by,submission_source,status,schedule_state,
    customer_name,organization_name,email,phone,event_name,event_date,event_time,venue,request_summary,
    first_form_data,internal_memo,public_addressee,public_event_name,public_event_date,public_event_time,
    public_venue,public_request_summary,public_guidance,public_conditions,response_deadline,
    second_form_issued_at,second_form_answered_at,schedule_confirmed_at,customer_confirmation_sent_at,
    revision,submission_key,contact_name,requested_services,schedule_result_kind,schedule_result_sent_at,
    schedule_result_delivery_id,deleted_at,delete_reason,deleted_by)
  values(
    v_test_case,public.next_pa_inquiry_number(),now(),now(),now(),p_actor,'manual',v_case.status,v_case.schedule_state,
    v_case.customer_name,v_case.organization_name,'tonokun@gmail.com',v_case.phone,v_case.event_name,v_case.event_date,
    v_case.event_time,v_case.venue,v_case.request_summary,'{}'::jsonb,
    left(c_marker||case when nullif(btrim(v_case.internal_memo),'') is null then '' else E'\n\n'||v_case.internal_memo end,10000),
    v_case.public_addressee,v_case.public_event_name,v_case.public_event_date,v_case.public_event_time,
    v_case.public_venue,v_case.public_request_summary,v_case.public_guidance,v_case.public_conditions,
    v_case.response_deadline,v_case.second_form_issued_at,v_case.second_form_answered_at,v_case.schedule_confirmed_at,
    v_case.customer_confirmation_sent_at,1,null,v_case.contact_name,v_case.requested_services,
    v_case.schedule_result_kind,v_case.schedule_result_sent_at,null,null,null,null);

  update public.pa_case_progress set
    current_step=8,is_on_hold=false,estimate_amount=198550,
    estimate_created_on=v_progress.estimate_created_on,estimate_sent_on=v_progress.estimate_sent_on,
    estimate_adjusting=false,estimate_approved_on=null,estimate_memo=v_progress.estimate_memo,
    booking_confirmed_on=null,confirmed_event_date=coalesce(v_progress.confirmed_event_date,v_case.event_date),
    event_preparing=false,event_preparation_completed_on=null,event_completed_on=null,event_memo=v_progress.event_memo,
    invoice_amount=null,invoice_issued_on=null,payment_due_on=null,invoice_sent=false,invoice_memo=null,
    close_reason=null,closed_from_step=null,closed_at=null,formal_contract_id=null,updated_at=now(),updated_by=p_actor
  where inquiry_id=v_test_case;

  insert into public.pa_commercial_documents(
    id,inquiry_id,document_kind,source_kind,gmail_message_id,gmail_attachment_id,original_filename,mime_type,
    content,sha256,metadata,created_at,created_by)
  values(v_test_document,v_test_case,v_document.document_kind,v_document.source_kind,null,null,
    v_document.original_filename,v_document.mime_type,v_document.content,v_document.sha256,
    v_document.metadata||jsonb_build_object('production_e2e_clone',true,'source_case_id',c_source,'source_document_id',v_document.id),
    v_document.created_at,p_actor);
  insert into public.pa_estimate_revisions(
    id,inquiry_id,revision_number,series,parent_contract_id,document_id,amount_minor,currency,tax_basis,
    conditions_snapshot,source_kind,lifecycle,source_sent_at,issued_at,issued_by,operation_id)
  values(v_test_estimate,v_test_case,v_estimate.revision_number,v_estimate.series,null,v_test_document,
    v_estimate.amount_minor,v_estimate.currency,v_estimate.tax_basis,v_estimate.conditions_snapshot,
    v_estimate.source_kind,'issued',v_estimate.source_sent_at,v_estimate.issued_at,p_actor,gen_random_uuid());
  insert into public.pa_case_commercial_state(
    inquiry_id,revision,current_estimate_revision_id,estimate_change_state,fulfillment_state,settlement_state,
    settlement_currency,unresolved_changes,updated_at,updated_by)
  values(v_test_case,1,v_test_estimate,'ready','not_confirmed','unsettled','JPY',false,now(),p_actor);
  insert into public.pa_production_e2e_tests(
    operation_id,source_case_id,test_case_id,source_estimate_id,test_estimate_id,source_document_id,test_document_id,
    allowed_recipient,source_estimate_sha,source_confirmation_subject,created_by)
  values(p_operation,c_source,v_test_case,v_estimate.id,v_test_estimate,v_document.id,v_test_document,
    'tonokun@gmail.com',c_sha,v_subject,p_actor);
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
  values(v_test_case,p_actor,'production_e2e_clone_created',jsonb_build_object(
    'source_case_id',c_source,'source_estimate_id',v_estimate.id,'test_estimate_id',v_test_estimate,
    'source_document_id',v_document.id,'test_document_id',v_test_document,'estimate_sha',c_sha,
    'allowed_recipient','tonokun@gmail.com','operation_id',p_operation));
  return jsonb_build_object('test_case_id',v_test_case,'test_estimate_id',v_test_estimate,
    'test_document_id',v_test_document,'estimate_sha',c_sha,'already_committed',false);
end $$;

create function public.pa_production_e2e_arm_failpoint(p_actor uuid,p_case uuid,p_operation uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_test public.pa_production_e2e_tests%rowtype;
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_test from public.pa_production_e2e_tests where test_case_id=p_case for update;
  if not found or v_test.state<>'active' then raise exception 'production_e2e_test_not_found'; end if;
  if v_test.failpoint_fired_at is not null or v_test.failpoint_armed_at is not null then raise exception 'production_e2e_failpoint_already_used'; end if;
  if exists(select 1 from public.pa_contract_offers where inquiry_id=p_case)
    or exists(select 1 from public.pa_commercial_outbox where inquiry_id=p_case)
  then raise exception 'invalid_production_e2e_test'; end if;
  update public.pa_production_e2e_tests set failpoint_operation_id=p_operation,failpoint_armed_at=now()
   where id=v_test.id;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
  values(p_case,p_actor,'production_e2e_failpoint_armed',jsonb_build_object('operation_id',p_operation));
  return jsonb_build_object('armed',true,'case_id',p_case);
end $$;

create function public.pa_production_e2e_consume_failpoint(p_actor uuid,p_case uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_test public.pa_production_e2e_tests%rowtype; v_job public.pa_commercial_outbox%rowtype;
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_test from public.pa_production_e2e_tests where test_case_id=p_case and state='active' for update;
  if not found then raise exception 'production_e2e_test_not_found'; end if;
  if v_test.failpoint_armed_at is null then return jsonb_build_object('fired',false); end if;
  if v_test.failpoint_fired_at is not null then return jsonb_build_object('fired',false,'already_consumed',true); end if;
  select * into v_job from public.pa_commercial_outbox where id=p_job and inquiry_id=p_case for update;
  if not found or v_job.job_kind<>'confirmation' or v_job.state<>'processing' or v_job.attempt_count<>1
    or lower(btrim(v_job.recipient))<>'tonokun@gmail.com'
    or coalesce(v_job.reply_binding->>'delivery_mode','')<>'standalone_production_e2e'
  then raise exception 'invalid_production_e2e_test'; end if;
  update public.pa_production_e2e_tests set failpoint_fired_at=now(),failpoint_job_id=p_job where id=v_test.id;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
  values(p_case,p_actor,'production_e2e_failpoint_fired',jsonb_build_object('outbox_id',p_job));
  return jsonb_build_object('fired',true,'job_id',p_job);
end $$;

create or replace function public.pa_v5_outbox_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if old.inquiry_id<>new.inquiry_id or old.operation_id<>new.operation_id or old.job_kind<>new.job_kind
    or old.aggregate_id<>new.aggregate_id or old.recipient<>new.recipient or old.subject<>new.subject
    or old.body_text<>new.body_text or old.reply_binding<>new.reply_binding
    or old.attachment_ids<>new.attachment_ids or old.secret_envelope is distinct from new.secret_envelope
    or old.created_at<>new.created_at then raise exception 'outbox_payload_immutable'; end if;
  if old.state in ('sent','cancelled') then raise exception 'outbox_terminal'; end if;
  if old.state='unknown' and new.state not in ('unknown','cancelled') then
    if not (new.state='sent'
      and coalesce(current_setting('ara_tech.pa_e2e_reconcile_job',true)=old.id::text,false)
      and exists(select 1 from public.pa_production_e2e_tests t
        where t.test_case_id=old.inquiry_id and t.state='active' and t.failpoint_job_id=old.id and t.failpoint_fired_at is not null))
    then raise exception 'outbox_unknown_requires_reconciliation'; end if;
  end if;
  return new;
end $$;

create function public.pa_production_e2e_reconcile_unknown(
  p_actor uuid,p_case uuid,p_job uuid,p_message text,p_thread text,p_sent_at timestamptz
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.pa_commercial_outbox%rowtype; v_test public.pa_production_e2e_tests%rowtype;
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_test from public.pa_production_e2e_tests where test_case_id=p_case and state='active' for update;
  select * into v_job from public.pa_commercial_outbox where id=p_job and inquiry_id=p_case for update;
  if not found or v_test.id is null or v_test.failpoint_job_id<>p_job or v_test.failpoint_fired_at is null
    or v_job.job_kind<>'confirmation' or lower(btrim(v_job.recipient))<>'tonokun@gmail.com'
    or p_message!~'^[A-Za-z0-9_-]{1,200}$' or p_thread!~'^[A-Za-z0-9_-]{1,200}$' or p_sent_at is null
  then raise exception 'invalid_production_e2e_test'; end if;
  if v_job.state='sent' then
    if v_job.provider_message_id<>p_message or v_job.provider_thread_id<>p_thread then raise exception 'production_e2e_delivery_mismatch'; end if;
    return jsonb_build_object('state','sent','already_committed',true,'provider_message_id',p_message,'provider_thread_id',p_thread);
  end if;
  if v_job.state<>'unknown' then raise exception 'invalid_production_e2e_test'; end if;
  perform set_config('ara_tech.pa_e2e_reconcile_job',p_job::text,true);
  update public.pa_commercial_outbox set state='sent',provider_message_id=p_message,provider_thread_id=p_thread,
    finished_at=coalesce(p_sent_at,now()),lease_id=null,lease_expires_at=null,last_error_code=null where id=p_job;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
  values(p_case,p_actor,'production_e2e_unknown_reconciled',jsonb_build_object(
    'outbox_id',p_job,'provider_message_id',p_message,'provider_thread_id',p_thread,'sent_at',p_sent_at));
  return jsonb_build_object('state','sent','already_committed',false,'provider_message_id',p_message,'provider_thread_id',p_thread);
end $$;

create function public.pa_production_e2e_archive_case(p_actor uuid,p_case uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_test public.pa_production_e2e_tests%rowtype;
begin
  perform public.pa_v5_assert_admin(p_actor);
  select * into v_test from public.pa_production_e2e_tests where test_case_id=p_case for update;
  if not found then raise exception 'production_e2e_test_not_found'; end if;
  if v_test.state='archived' then return jsonb_build_object('archived',true,'already_committed',true); end if;
  if coalesce(char_length(btrim(p_reason)),0) not between 1 and 2000 then raise exception 'invalid_production_e2e_test'; end if;
  perform set_config('app.pa_case_delete_mode','trash',true);
  update public.pa_inquiries set deleted_at=now(),delete_reason='test_case',deleted_by=p_actor,updated_at=now() where id=p_case and deleted_at is null;
  update public.pa_production_e2e_tests set state='archived',archived_at=now() where id=v_test.id;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
  values(p_case,p_actor,'production_e2e_test_archived',jsonb_build_object('reason',btrim(p_reason)));
  return jsonb_build_object('archived',true,'already_committed',false);
end $$;

revoke all on function public.pa_production_e2e_clone_case(uuid,uuid,text,uuid),
  public.pa_production_e2e_arm_failpoint(uuid,uuid,uuid),
  public.pa_production_e2e_consume_failpoint(uuid,uuid,uuid),
  public.pa_production_e2e_reconcile_unknown(uuid,uuid,uuid,text,text,timestamptz),
  public.pa_production_e2e_archive_case(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.pa_production_e2e_clone_case(uuid,uuid,text,uuid),
  public.pa_production_e2e_arm_failpoint(uuid,uuid,uuid),
  public.pa_production_e2e_consume_failpoint(uuid,uuid,uuid),
  public.pa_production_e2e_reconcile_unknown(uuid,uuid,uuid,text,text,timestamptz),
  public.pa_production_e2e_archive_case(uuid,uuid,text) to service_role;

commit;

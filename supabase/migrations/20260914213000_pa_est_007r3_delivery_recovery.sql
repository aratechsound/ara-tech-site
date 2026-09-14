-- PA-EST-007R3: concrete delivery diagnostics and same-confirmation recovery.
-- The one Production repair below is guarded to the already-issued TEST v1
-- outbox. It does not create or modify offers, tokens, snapshots or URLs.
begin;

do $$
begin
  if to_regclass('public.pa_commercial_outbox') is null
    or to_regclass('public.pa_production_e2e_tests') is null
    or to_regprocedure('public.pa_v5_assert_admin(uuid)') is null
  then raise exception 'PA-EST-007R3 prerequisites are missing'; end if;
end $$;

alter table public.pa_commercial_outbox
  add column if not exists delivery_state text,
  add column if not exists failure_phase text,
  add column if not exists failure_code text,
  add column if not exists safe_error_message text,
  add column if not exists provider_request_started boolean,
  add column if not exists provider_response_received boolean,
  add column if not exists provider_http_status integer;

-- Defaults apply only to newly queued work. Existing terminal rows deliberately
-- remain NULL so this migration does not rewrite historical Production delivery
-- evidence unrelated to the guarded TEST job below.
alter table public.pa_commercial_outbox alter column delivery_state set default 'queued';
alter table public.pa_commercial_outbox alter column provider_request_started set default false;
alter table public.pa_commercial_outbox alter column provider_response_received set default false;

alter table public.pa_commercial_outbox drop constraint if exists pa_commercial_outbox_delivery_state_check;
alter table public.pa_commercial_outbox add constraint pa_commercial_outbox_delivery_state_check
  check (delivery_state is null or delivery_state in ('queued','processing','failed_before_provider','failed_after_provider_response','unknown_after_provider_start','sent','cancelled'));
alter table public.pa_commercial_outbox drop constraint if exists pa_commercial_outbox_delivery_diagnostics_check;
alter table public.pa_commercial_outbox add constraint pa_commercial_outbox_delivery_diagnostics_check check (
  (failure_phase is null or failure_phase ~ '^[a-z][a-z0-9_]{0,99}$')
  and (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,99}$')
  and (safe_error_message is null or (char_length(safe_error_message) between 1 and 500
    and safe_error_message !~ '[[:cntrl:]]' and safe_error_message !~* 'https?://'))
  and (provider_response_received is distinct from true or provider_request_started is true)
  and (provider_http_status is null or (provider_response_received is true and provider_http_status between 100 and 599))
);

create or replace function public.pa_v5_outbox_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then raise exception 'outbox_payload_immutable'; end if;
  if old.inquiry_id<>new.inquiry_id or old.operation_id<>new.operation_id or old.job_kind<>new.job_kind
    or old.aggregate_id<>new.aggregate_id or old.recipient<>new.recipient or old.subject<>new.subject
    or old.body_text<>new.body_text or old.reply_binding<>new.reply_binding
    or old.attachment_ids<>new.attachment_ids or old.secret_envelope is distinct from new.secret_envelope
    or old.created_at<>new.created_at then raise exception 'outbox_payload_immutable'; end if;
  if old.state in ('sent','cancelled') then raise exception 'outbox_terminal'; end if;
  if old.state='unknown' and new.state not in ('unknown','cancelled') then
    if not (
      (new.state='sent'
        and coalesce(current_setting('ara_tech.pa_e2e_reconcile_job',true)=old.id::text,false)
        and exists(select 1 from public.pa_production_e2e_tests t where t.test_case_id=old.inquiry_id and t.state='active'))
      or
      (new.state='failed' and new.delivery_state='failed_before_provider'
        and coalesce(current_setting('ara_tech.pa_e2e_not_sent_job',true)=old.id::text,false)
        and exists(select 1 from public.pa_production_e2e_tests t where t.test_case_id=old.inquiry_id and t.state='active'))
    ) then raise exception 'outbox_unknown_requires_reconciliation'; end if;
  end if;
  return new;
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
 if v_job.state='unknown' or v_job.delivery_state='unknown_after_provider_start' then raise exception 'outbox_unknown_requires_reconciliation'; end if;
 if v_job.state='processing' and v_job.lease_expires_at>now() then raise exception 'outbox_busy'; end if;
 perform 1 from public.pa_inquiries where id=v_job.inquiry_id for update;
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
 update public.pa_commercial_outbox set
   state='processing',delivery_state='processing',lease_id=p_lease,lease_expires_at=now()+interval '10 minutes',
   attempt_count=attempt_count+1,last_error_code=null,failure_phase=null,failure_code=null,safe_error_message=null,
   provider_message_id=null,provider_thread_id=null,provider_request_started=false,provider_response_received=false,
   provider_http_status=null,finished_at=null
 where id=p_job returning * into v_job;
 return to_jsonb(v_job)-'secret_envelope'-'body_text';
end $$;

create or replace function public.pa_v5_outbox_finish_v2(
  p_actor uuid,p_job uuid,p_lease uuid,p_state text,p_message text,p_thread text,p_error text,
  p_delivery_state text,p_failure_phase text,p_failure_code text,p_safe_message text,
  p_provider_started boolean,p_provider_response boolean,p_provider_status integer
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.pa_commercial_outbox%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_state not in ('sent','failed','unknown')
   or p_delivery_state not in ('failed_before_provider','failed_after_provider_response','unknown_after_provider_start','sent')
   or (p_state='sent') is distinct from (p_delivery_state='sent')
   or (p_state='unknown') is distinct from (p_delivery_state='unknown_after_provider_start')
   or p_provider_response and not p_provider_started
   or (p_provider_status is not null and (not p_provider_response or p_provider_status not between 100 and 599))
   or (p_state<>'sent' and (p_failure_phase is null or p_failure_phase!~'^[a-z][a-z0-9_]{0,99}$'
      or p_failure_code is null or p_failure_code!~'^[a-z][a-z0-9_]{0,99}$'
      or p_safe_message is null or char_length(p_safe_message) not between 1 and 500
      or p_safe_message~'[[:cntrl:]]' or p_safe_message~*'https?://'))
   or (p_message is not null and (char_length(p_message) not between 1 and 200 or p_message~'[[:cntrl:]]'))
   or (p_thread is not null and (char_length(p_thread) not between 1 and 200 or p_thread~'[[:cntrl:]]'))
 then raise exception 'invalid_outbox_result'; end if;
 select * into v_job from public.pa_commercial_outbox where id=p_job for update;
 if not found or v_job.state<>'processing' or v_job.lease_id<>p_lease then raise exception 'outbox_lease_changed'; end if;
 update public.pa_commercial_outbox set
   state=p_state,delivery_state=p_delivery_state,
   provider_message_id=case when p_state='sent' or p_message is not null then p_message end,
   provider_thread_id=case when p_state='sent' or p_thread is not null then p_thread end,
   last_error_code=case when p_state='sent' then null else p_error end,
   failure_phase=case when p_state='sent' then null else p_failure_phase end,
   failure_code=case when p_state='sent' then null else p_failure_code end,
   safe_error_message=case when p_state='sent' then null else p_safe_message end,
   provider_request_started=p_provider_started,provider_response_received=p_provider_response,
   provider_http_status=p_provider_status,finished_at=now(),lease_expires_at=null
 where id=p_job returning * into v_job;
 if v_job.job_kind='invoice' then update public.pa_billings set invoice_delivery_state=p_state,updated_at=now() where id=v_job.aggregate_id; end if;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
 values(v_job.inquiry_id,p_actor,'commercial_outbox_delivery_finished',jsonb_build_object(
   'outbox_id',v_job.id,'state',p_state,'delivery_state',p_delivery_state,'failure_phase',p_failure_phase,
   'failure_code',p_failure_code,'provider_request_started',p_provider_started,
   'provider_response_received',p_provider_response,'provider_http_status',p_provider_status));
 return to_jsonb(v_job)-'secret_envelope'-'body_text';
end $$;

create or replace function public.pa_production_e2e_reconcile_delivery(
  p_actor uuid,p_case uuid,p_job uuid,p_message text,p_thread text,p_sent_at timestamptz
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.pa_commercial_outbox%rowtype; v_test public.pa_production_e2e_tests%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 select * into v_test from public.pa_production_e2e_tests where test_case_id=p_case and state='active' for update;
 select * into v_job from public.pa_commercial_outbox where id=p_job and inquiry_id=p_case for update;
 if not found or v_test.id is null or v_job.job_kind<>'confirmation'
   or lower(btrim(v_job.recipient))<>'tonokun@gmail.com'
   or coalesce(v_job.reply_binding->>'delivery_mode','')<>'standalone_production_e2e'
   or p_message!~'^[A-Za-z0-9_-]{1,200}$' or p_thread!~'^[A-Za-z0-9_-]{1,200}$' or p_sent_at is null
 then raise exception 'invalid_production_e2e_test'; end if;
 if v_job.state='sent' then
   if v_job.provider_message_id<>p_message or v_job.provider_thread_id<>p_thread then raise exception 'production_e2e_delivery_mismatch'; end if;
   return jsonb_build_object('state','sent','already_committed',true,'provider_message_id',p_message,'provider_thread_id',p_thread);
 end if;
 if v_job.state not in ('failed','unknown') then raise exception 'invalid_production_e2e_test'; end if;
 perform set_config('ara_tech.pa_e2e_reconcile_job',p_job::text,true);
 update public.pa_commercial_outbox set state='sent',delivery_state='sent',provider_message_id=p_message,provider_thread_id=p_thread,
   finished_at=coalesce(p_sent_at,now()),lease_id=null,lease_expires_at=null,last_error_code=null,
   failure_phase=null,failure_code=null,safe_error_message=null,provider_request_started=true,
   provider_response_received=true,provider_http_status=200 where id=p_job;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
 values(p_case,p_actor,'production_e2e_delivery_reconciled',jsonb_build_object(
   'outbox_id',p_job,'provider_message_id',p_message,'provider_thread_id',p_thread,'sent_at',p_sent_at));
 return jsonb_build_object('state','sent','already_committed',false,'provider_message_id',p_message,'provider_thread_id',p_thread);
end $$;

do $$
declare
  c_case constant uuid:='21073084-a71f-4892-b97d-7717aeda0672';
  c_job constant uuid:='a74497c3-9ce1-453f-ae55-c950391fb30d';
  c_offer constant uuid:='53084cdf-90fc-45fc-8bc1-e0c27cbafc4f';
  v_job public.pa_commercial_outbox%rowtype;
  v_actor uuid;
begin
 select * into v_job from public.pa_commercial_outbox where id=c_job;
 if not found then return; end if;
 if v_job.inquiry_id<>c_case or v_job.aggregate_id<>c_offer or v_job.job_kind<>'confirmation'
   or lower(btrim(v_job.recipient))<>'tonokun@gmail.com'
   or v_job.reply_binding->>'delivery_mode'<>'standalone_production_e2e'
   or not exists(select 1 from public.pa_contract_offers o join public.pa_contract_tokens t on t.offer_id=o.id
      where o.id=c_offer and o.inquiry_id=c_case and o.version=1 and t.state='active')
 then raise exception 'PA-EST-007R3 guarded TEST outbox identity mismatch'; end if;
 if v_job.state='unknown' then
   if v_job.attempt_count<>1 or v_job.last_error_code<>'mail_outcome_unknown'
     or v_job.provider_message_id is not null or v_job.provider_thread_id is not null
     or exists(select 1 from public.pa_production_e2e_tests t where t.test_case_id=c_case and t.failpoint_fired_at is not null)
   then raise exception 'PA-EST-007R3 guarded TEST outbox state mismatch'; end if;
   select created_by into v_actor from public.pa_production_e2e_tests where test_case_id=c_case and state='active';
   perform set_config('ara_tech.pa_e2e_not_sent_job',c_job::text,true);
   update public.pa_commercial_outbox set
     state='failed',delivery_state='failed_before_provider',last_error_code='invalid_confirmation',
     failure_phase='preview_validation',failure_code='invalid_confirmation',
     safe_error_message='送信内容の確認情報と添付ファイルが一致しません。',
     provider_request_started=false,provider_response_received=false,provider_http_status=null
   where id=c_job;
   insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
   values(c_case,v_actor,'production_e2e_delivery_root_cause_classified',jsonb_build_object(
     'outbox_id',c_job,'failure_phase','preview_validation','failure_code','invalid_confirmation',
     'provider_request_started',false,'owner_mailbox_readback','definitely_not_sent'));
 elsif not (v_job.state='failed' and v_job.delivery_state='failed_before_provider' and v_job.failure_code='invalid_confirmation') then
   raise exception 'PA-EST-007R3 guarded TEST outbox unexpected terminal state';
 end if;
end $$;

revoke all on function public.pa_v5_outbox_finish_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,text,boolean,boolean,integer),
  public.pa_production_e2e_reconcile_delivery(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.pa_v5_outbox_finish_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,text,boolean,boolean,integer),
  public.pa_production_e2e_reconcile_delivery(uuid,uuid,uuid,text,text,timestamptz) to service_role;

commit;

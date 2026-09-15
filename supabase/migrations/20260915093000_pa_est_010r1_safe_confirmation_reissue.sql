-- PA-EST-010R1: allow immutable same-estimate history while preserving one
-- active confirmation per case and requiring a fresh Owner send approval.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare v_index text;
begin
  if to_regclass('public.pa_contract_offers') is null
    or to_regclass('public.pa_contract_tokens') is null
    or to_regclass('public.pa_commercial_outbox') is null
    or to_regprocedure('public.pa_v5_issue_confirmation(uuid,uuid,bigint,uuid,uuid,uuid,text,text,jsonb,text,text,text,jsonb)') is null
  then raise exception 'PA-EST-010R1 prerequisites are missing'; end if;
  select indexdef into v_index from pg_indexes
   where schemaname='public' and indexname='pa_contract_offers_one_active_estimate';
  if v_index is distinct from 'CREATE UNIQUE INDEX pa_contract_offers_one_active_estimate ON public.pa_contract_offers USING btree (inquiry_id, estimate_revision_id) WHERE (estimate_revision_id IS NOT NULL)'
  then raise exception 'unexpected_pa_contract_offers_one_active_estimate'; end if;
  if exists(
    select 1 from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id
     where t.state='active' group by o.inquiry_id having count(*)>1
  ) then raise exception 'existing_multiple_active_confirmations'; end if;
  if exists(
    select 1 from public.pa_contracts c join public.pa_contract_offers o on o.inquiry_id=c.inquiry_id
      join public.pa_contract_tokens t on t.offer_id=o.id and t.state='active'
  ) then raise exception 'existing_contract_active_confirmation_overlap'; end if;
end $$;

create function public.pa_v5_active_confirmation_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_case uuid;
begin
  if new.state<>'active' then return new; end if;
  select inquiry_id into v_case from public.pa_contract_offers where id=new.offer_id;
  if not found then raise exception 'invalid_confirmation'; end if;
  perform 1 from public.pa_inquiries where id=v_case and deleted_at is null for update;
  if not found then raise exception 'case_unavailable'; end if;
  if exists(select 1 from public.pa_contracts where inquiry_id=v_case) then
    raise exception 'contract_already_accepted';
  end if;
  if exists(
    select 1 from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id
     where o.inquiry_id=v_case and t.state='active' and t.offer_id<>new.offer_id
  ) then raise exception 'confirmation_already_active'; end if;
  return new;
end $$;

create trigger pa_contract_tokens_one_active_case
before insert or update of state on public.pa_contract_tokens
for each row execute function public.pa_v5_active_confirmation_guard();

-- The trigger is active before the incorrect all-history uniqueness is removed.
drop index public.pa_contract_offers_one_active_estimate;
create index pa_contract_offers_estimate_history
  on public.pa_contract_offers(inquiry_id,estimate_revision_id,version)
  where estimate_revision_id is not null;

alter table public.pa_commercial_outbox
  add column confirmation_send_authorized_at timestamptz,
  add column confirmation_send_authorized_by uuid references auth.users(id),
  add column confirmation_send_authority_sha256 text;
alter table public.pa_commercial_outbox add constraint pa_commercial_outbox_confirmation_send_authority_check check (
  (confirmation_send_authorized_at is null and confirmation_send_authorized_by is null and confirmation_send_authority_sha256 is null)
  or
  (job_kind='confirmation' and confirmation_send_authorized_at is not null and confirmation_send_authorized_by is not null
    and confirmation_send_authority_sha256~'^[a-f0-9]{64}$')
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
  if old.confirmation_send_authorized_at is distinct from new.confirmation_send_authorized_at
    or old.confirmation_send_authorized_by is distinct from new.confirmation_send_authorized_by
    or old.confirmation_send_authority_sha256 is distinct from new.confirmation_send_authority_sha256
  then
    if not (
      coalesce(current_setting('ara_tech.pa_confirmation_authorize_job',true)=old.id::text,false)
      or coalesce(current_setting('ara_tech.pa_confirmation_claim_job',true)=old.id::text,false)
    ) then raise exception 'confirmation_send_owner_approval_required'; end if;
  end if;
  return new;
end $$;

create function public.pa_v5_replace_confirmation(
 p_actor uuid,p_case uuid,p_expected_revision bigint,p_old_offer uuid,p_expected_old_version integer,
 p_estimate uuid,p_offer uuid,p_operation uuid,p_reason text,p_token_hash text,p_secret_envelope text,
 p_snapshot jsonb,p_recipient text,p_subject text,p_body text,p_reply_binding jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_state public.pa_case_commercial_state%rowtype;
 v_old public.pa_contract_offers%rowtype;
 v_token_state text;
 v_active_count integer;
 v_result jsonb;
 v_existing public.pa_contract_offers%rowtype;
 v_existing_job public.pa_commercial_outbox%rowtype;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_operation is null or p_offer=p_old_offer
   or char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000
   or p_snapshot->'customer_acknowledgement'->>'replaced_offer_id' is distinct from p_old_offer::text
 then raise exception 'invalid_confirmation_replacement'; end if;

 select o.* into v_existing
   from public.pa_contract_offers o join public.pa_commercial_outbox x on x.aggregate_id=o.id
  where x.operation_id=p_operation;
 if found then
   select * into v_existing_job from public.pa_commercial_outbox where operation_id=p_operation;
   if v_existing.inquiry_id<>p_case or v_existing.estimate_revision_id<>p_estimate
     or v_existing.snapshot->'customer_acknowledgement'->>'replaced_offer_id' is distinct from p_old_offer::text
     or v_existing_job.job_kind<>'confirmation' or v_existing_job.recipient<>p_recipient
     or v_existing_job.subject<>p_subject or v_existing_job.body_text<>p_body
     or v_existing_job.reply_binding<>p_reply_binding
   then raise exception 'idempotency_payload_mismatch'; end if;
   return jsonb_build_object('id',v_existing.id,'version',v_existing.version,'outbox_id',v_existing_job.id,
     'replaced_offer_id',p_old_offer,'already_committed',true);
 end if;

 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found then raise exception 'case_unavailable'; end if;
 select o.* into v_existing
   from public.pa_contract_offers o join public.pa_commercial_outbox x on x.aggregate_id=o.id
  where x.operation_id=p_operation;
 if found then
   select * into v_existing_job from public.pa_commercial_outbox where operation_id=p_operation;
   if v_existing.inquiry_id<>p_case or v_existing.estimate_revision_id<>p_estimate
     or v_existing.snapshot->'customer_acknowledgement'->>'replaced_offer_id' is distinct from p_old_offer::text
     or v_existing_job.job_kind<>'confirmation' or v_existing_job.recipient<>p_recipient
     or v_existing_job.subject<>p_subject or v_existing_job.body_text<>p_body
     or v_existing_job.reply_binding<>p_reply_binding
   then raise exception 'idempotency_payload_mismatch'; end if;
   return jsonb_build_object('id',v_existing.id,'version',v_existing.version,'outbox_id',v_existing_job.id,
     'replaced_offer_id',p_old_offer,'already_committed',true);
 end if;
 v_state:=public.pa_v5_state(p_case);
 if v_state.revision<>p_expected_revision or v_state.current_estimate_revision_id<>p_estimate
   or v_state.estimate_change_state<>'ready'
 then raise exception 'commercial_state_changed'; end if;
 if exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'contract_already_accepted'; end if;

 select o.* into v_old from public.pa_contract_offers o
  where o.id=p_old_offer and o.inquiry_id=p_case;
 select state into v_token_state from public.pa_contract_tokens
  where offer_id=p_old_offer for update;
 if not found or v_old.version<>p_expected_old_version or v_old.estimate_revision_id<>p_estimate
 then raise exception 'replacement_target_changed'; end if;
 if v_token_state='accepted' or exists(select 1 from public.pa_contracts where id=p_old_offer)
 then raise exception 'accepted_contract_immutable'; end if;
 if v_token_state<>'active' then raise exception 'replacement_target_changed'; end if;
 select count(*)::integer into v_active_count
   from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id
  where o.inquiry_id=p_case and t.state='active';
 if v_active_count<>1 then raise exception 'confirmation_already_active'; end if;
 if exists(
   select 1 from public.pa_commercial_outbox
    where inquiry_id=p_case and aggregate_id=p_old_offer and job_kind in ('confirmation','confirmation_reminder')
      and state='processing' and lease_expires_at>clock_timestamp()
 ) then raise exception 'confirmation_delivery_in_progress'; end if;

 update public.pa_contract_tokens set state='revoked' where offer_id=p_old_offer;
 update public.pa_commercial_outbox set state='cancelled',delivery_state='cancelled',finished_at=clock_timestamp(),
   last_error_code='confirmation_revoked'
  where aggregate_id=p_old_offer and state in ('queued','failed');
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
 values(p_case,p_actor,'formal_contract_revoked',jsonb_build_object(
   'offer_id',p_old_offer,'reason',btrim(p_reason),'operation_id',p_operation,
   'delivery_evidence_preserved',true,'replacement_offer_id',p_offer));

 v_result:=public.pa_v5_issue_confirmation(
   p_actor,p_case,p_expected_revision,p_estimate,p_offer,p_operation,p_token_hash,p_secret_envelope,
   p_snapshot,p_recipient,p_subject,p_body,p_reply_binding
 );
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
 values(p_case,p_actor,'formal_contract_replaced',jsonb_build_object(
   'old_offer_id',p_old_offer,'new_offer_id',p_offer,'estimate_revision_id',p_estimate,
   'reason',btrim(p_reason),'operation_id',p_operation));
 return v_result||jsonb_build_object('replaced_offer_id',p_old_offer);
end $$;

create function public.pa_v5_authorize_confirmation_send(
 p_actor uuid,p_case uuid,p_offer uuid,p_job uuid,p_authority_sha256 text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_job_case uuid;
 v_job public.pa_commercial_outbox%rowtype;
 v_offer public.pa_contract_offers%rowtype;
 v_token text;
 v_current uuid;
 v_now timestamptz:=clock_timestamp();
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_authority_sha256!~'^[a-f0-9]{64}$' then raise exception 'confirmation_send_authority_changed'; end if;
 select inquiry_id into v_job_case from public.pa_commercial_outbox where id=p_job;
 if not found or v_job_case<>p_case then raise exception 'outbox_not_found'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found then raise exception 'case_unavailable'; end if;
 select * into v_job from public.pa_commercial_outbox where id=p_job and inquiry_id=p_case for update;
 if v_job.state='sent' then return jsonb_build_object('id',p_job,'state','sent','already_committed',true); end if;
 if v_job.job_kind<>'confirmation' or v_job.aggregate_id<>p_offer or v_job.state not in ('queued','failed')
 then raise exception 'confirmation_send_owner_approval_required'; end if;
 select o.* into v_offer from public.pa_contract_offers o
  where o.id=p_offer and o.inquiry_id=p_case;
 select state into v_token from public.pa_contract_tokens
  where offer_id=p_offer for update;
 if not found or v_token<>'active' or v_offer.expires_at<=v_now then raise exception 'invalid_confirmation'; end if;
 if exists(select 1 from public.pa_contracts where inquiry_id=p_case) then raise exception 'contract_already_accepted'; end if;
 select current_estimate_revision_id into v_current from public.pa_case_commercial_state where inquiry_id=p_case for update;
 if v_offer.estimate_revision_id is distinct from v_current then raise exception 'commercial_state_changed'; end if;
 perform set_config('ara_tech.pa_confirmation_authorize_job',p_job::text,true);
 update public.pa_commercial_outbox set confirmation_send_authorized_at=v_now,
   confirmation_send_authorized_by=p_actor,confirmation_send_authority_sha256=p_authority_sha256
  where id=p_job;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
 values(p_case,p_actor,'formal_contract_send_authorized',jsonb_build_object(
   'offer_id',p_offer,'outbox_id',p_job,'authority_sha256',p_authority_sha256,'authorized_at',v_now));
 return jsonb_build_object('id',p_job,'state',v_job.state,'authorized_at',v_now,'already_committed',false);
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

-- All production writes now enter SECURITY DEFINER functions and their guards.
revoke insert,update,delete,truncate,references,trigger on public.pa_contract_offers,public.pa_contract_tokens,public.pa_commercial_outbox from service_role;
grant select on public.pa_contract_offers,public.pa_contract_tokens,public.pa_commercial_outbox to service_role;

revoke all on function public.pa_v5_active_confirmation_guard(),
  public.pa_v5_replace_confirmation(uuid,uuid,bigint,uuid,integer,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,jsonb),
  public.pa_v5_authorize_confirmation_send(uuid,uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function
  public.pa_v5_replace_confirmation(uuid,uuid,bigint,uuid,integer,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,jsonb),
  public.pa_v5_authorize_confirmation_send(uuid,uuid,uuid,uuid,text)
  to service_role;

commit;

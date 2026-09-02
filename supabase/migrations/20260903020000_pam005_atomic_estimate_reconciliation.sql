-- PA Production Release Audit: blockers 2/3/4, local candidate only.
-- Exact order after the deployed PA/PAM-001/PAM-002 baseline:
-- 20260902170000_pam003_estimate_submission_projection.sql
-- -> 20260903010000_pam004_gmail_direct_sent_reconciliation.sql
-- -> 20260903020000_pam005_atomic_estimate_reconciliation.sql (this file).
-- Transactional and idempotent: CREATE OR REPLACE preserves the existing update
-- RPC signature/ACL; the only change to its body is the two-status readiness guard.
-- No existing case, progress, audit, or reconciliation rows are rewritten/deleted.
-- One nullable timestamp records the immutable Gmail send time for new atomic
-- reconciliations. Legacy rows stay NULL and fail closed for explicit review.
-- Reapplying THIS file is safe. PAM-004 remains a once-only prerequisite.
-- The audit exposed the production readiness guard, not its complete DDL.
-- Verify the complete existing function body and execution context below before
-- replacement; any unreviewed source drift aborts the entire migration.
-- Rollback/forward-fix: retain additive schema and all history. Restore the
-- pre-release function definitions/ACL from independently captured DDL using a
-- separately approved forward migration; never DROP records or reverse emails.
begin;

do $$
declare
  v_body_hash text;
  v_security_definer boolean;
  v_config text[];
begin
  if to_regclass('public.pa_estimate_submission_reconciliations') is null
    or to_regprocedure('public.update_pa_case_progress(uuid,jsonb,text)') is null
    or public.derive_pa_workflow_step('rough_estimate', date '2026-01-01', null, false, null, null, null, null, false) <> 7 then
    raise exception 'PAM-005 requires PAM-003, PAM-004 and the canonical progress RPC';
  end if;
  select encode(sha256(convert_to(replace(prosrc, chr(13), ''), 'UTF8')), 'hex'), prosecdef, proconfig
    into v_body_hash, v_security_definer, v_config
    from pg_catalog.pg_proc where oid = 'public.update_pa_case_progress(uuid,jsonb,text)'::regprocedure;
  if v_body_hash not in ('011b1af590c6eaf988982eeb1dd8925c9f323338153e4556d584d1850b2b2156', '23e92eef483def7add855a8b20ff111443376ca6a358b0b506c76ee0a529b300')
    or v_security_definer is distinct from true
    or v_config is distinct from array['search_path=pg_catalog, public']::text[] then
    raise exception 'PAM-005 unexpected update_pa_case_progress DDL; fresh review required';
  end if;
end;
$$;

alter table public.pa_estimate_submission_reconciliations
  add column if not exists submitted_at timestamptz;

comment on column public.pa_estimate_submission_reconciliations.submitted_at is
  'Immutable canonical Gmail sent_at captured with progress and audit in one transaction. NULL legacy rows require review.';

create or replace function public.update_pa_case_progress(
  p_inquiry_id uuid,
  p_progress jsonb,
  p_note text default null
)
returns public.pa_case_progress
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inquiry public.pa_inquiries%rowtype;
  v_before public.pa_case_progress%rowtype;
  v_after public.pa_case_progress%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_actor_label text := coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text);
  v_unknown_key text;
  v_next_step smallint;
begin
  if not public.is_work_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_inquiry_id is null
    or p_progress is null
    or jsonb_typeof(p_progress) <> 'object'
    or octet_length(p_progress::text) > 50000
    or (v_note is not null and char_length(v_note) > 5000)
  then
    raise exception 'invalid progress payload';
  end if;

  select key
  into v_unknown_key
  from jsonb_object_keys(p_progress) as field(key)
  where key not in (
    'estimate_amount',
    'estimate_created_on',
    'estimate_sent_on',
    'estimate_adjusting',
    'estimate_approved_on',
    'estimate_memo',
    'booking_confirmed_on',
    'confirmed_event_date',
    'event_preparing',
    'event_preparation_completed_on',
    'event_completed_on',
    'event_memo',
    'invoice_amount',
    'invoice_issued_on',
    'payment_due_on',
    'invoice_sent',
    'invoice_memo'
  )
  limit 1;

  if v_unknown_key is not null then
    raise exception 'unsupported progress field';
  end if;

  select *
  into v_inquiry
  from public.pa_inquiries
  where id = p_inquiry_id
  for update;

  if not found then
    raise exception 'inquiry not found';
  end if;

  if v_inquiry.status in ('schedule_unavailable', 'declined', 'cancelled', 'closed') then
    raise exception 'closed case cannot be updated';
  end if;
  if v_inquiry.status not in ('rough_estimate', 'schedule_confirmed') then
    raise exception 'case is not ready for estimate and fulfillment progress';
  end if;

  select *
  into v_before
  from public.pa_case_progress
  where inquiry_id = p_inquiry_id
  for update;

  if not found then
    raise exception 'case progress not found';
  end if;

  v_after := v_before;
  v_after.estimate_amount := case when p_progress ? 'estimate_amount'
    then nullif(p_progress ->> 'estimate_amount', '')::numeric else v_before.estimate_amount end;
  v_after.estimate_created_on := case when p_progress ? 'estimate_created_on'
    then nullif(p_progress ->> 'estimate_created_on', '')::date else v_before.estimate_created_on end;
  v_after.estimate_sent_on := case when p_progress ? 'estimate_sent_on'
    then nullif(p_progress ->> 'estimate_sent_on', '')::date else v_before.estimate_sent_on end;
  v_after.estimate_adjusting := case when p_progress ? 'estimate_adjusting'
    then coalesce((p_progress ->> 'estimate_adjusting')::boolean, false) else v_before.estimate_adjusting end;
  v_after.estimate_approved_on := case when p_progress ? 'estimate_approved_on'
    then nullif(p_progress ->> 'estimate_approved_on', '')::date else v_before.estimate_approved_on end;
  v_after.estimate_memo := case when p_progress ? 'estimate_memo'
    then nullif(btrim(coalesce(p_progress ->> 'estimate_memo', '')), '') else v_before.estimate_memo end;
  v_after.booking_confirmed_on := case when p_progress ? 'booking_confirmed_on'
    then nullif(p_progress ->> 'booking_confirmed_on', '')::date else v_before.booking_confirmed_on end;
  v_after.confirmed_event_date := case when p_progress ? 'confirmed_event_date'
    then nullif(p_progress ->> 'confirmed_event_date', '')::date else v_before.confirmed_event_date end;
  v_after.event_preparing := case when p_progress ? 'event_preparing'
    then coalesce((p_progress ->> 'event_preparing')::boolean, false) else v_before.event_preparing end;
  v_after.event_preparation_completed_on := case when p_progress ? 'event_preparation_completed_on'
    then nullif(p_progress ->> 'event_preparation_completed_on', '')::date else v_before.event_preparation_completed_on end;
  v_after.event_completed_on := case when p_progress ? 'event_completed_on'
    then nullif(p_progress ->> 'event_completed_on', '')::date else v_before.event_completed_on end;
  v_after.event_memo := case when p_progress ? 'event_memo'
    then nullif(btrim(coalesce(p_progress ->> 'event_memo', '')), '') else v_before.event_memo end;
  v_after.invoice_amount := case when p_progress ? 'invoice_amount'
    then nullif(p_progress ->> 'invoice_amount', '')::numeric else v_before.invoice_amount end;
  v_after.invoice_issued_on := case when p_progress ? 'invoice_issued_on'
    then nullif(p_progress ->> 'invoice_issued_on', '')::date else v_before.invoice_issued_on end;
  v_after.payment_due_on := case when p_progress ? 'payment_due_on'
    then nullif(p_progress ->> 'payment_due_on', '')::date else v_before.payment_due_on end;
  v_after.invoice_sent := case when p_progress ? 'invoice_sent'
    then coalesce((p_progress ->> 'invoice_sent')::boolean, false) else v_before.invoice_sent end;
  v_after.invoice_memo := case when p_progress ? 'invoice_memo'
    then nullif(btrim(coalesce(p_progress ->> 'invoice_memo', '')), '') else v_before.invoice_memo end;

  if (v_after.estimate_amount is not null and v_after.estimate_amount > 9999999999.99)
    or (v_after.invoice_amount is not null and v_after.invoice_amount > 9999999999.99)
    or char_length(coalesce(v_after.estimate_memo, '')) > 10000
    or char_length(coalesce(v_after.event_memo, '')) > 10000
    or char_length(coalesce(v_after.invoice_memo, '')) > 10000
  then
    raise exception 'progress field is out of range';
  end if;

  if v_after.estimate_sent_on is not null and v_after.estimate_created_on is null then
    raise exception 'estimate creation date is required before sending';
  end if;
  if v_after.estimate_approved_on is not null and v_after.estimate_sent_on is null then
    raise exception 'estimate sent date is required before approval';
  end if;
  if v_after.estimate_approved_on is not null and v_after.estimate_adjusting then
    raise exception 'approved estimate cannot remain adjusting';
  end if;
  if v_after.booking_confirmed_on is not null and v_after.estimate_approved_on is null then
    raise exception 'estimate approval is required before booking';
  end if;
  if v_after.booking_confirmed_on is not null and v_after.confirmed_event_date is null then
    raise exception 'confirmed event date is required before booking';
  end if;
  if v_after.event_preparing and v_after.booking_confirmed_on is null then
    raise exception 'booking is required before event preparation';
  end if;
  if v_after.event_preparation_completed_on is not null and v_after.booking_confirmed_on is null then
    raise exception 'booking is required before event preparation completion';
  end if;
  if v_after.event_completed_on is not null and v_after.event_preparation_completed_on is null then
    raise exception 'event preparation completion is required before event completion';
  end if;
  if v_after.invoice_sent and (
    v_after.event_completed_on is null
    or v_after.invoice_amount is null
    or v_after.invoice_issued_on is null
    or v_after.payment_due_on is null
  ) then
    raise exception 'event completion, invoice amount, invoice date and due date are required before invoicing';
  end if;

  v_next_step := public.derive_pa_workflow_step(
    v_inquiry.status,
    v_after.estimate_created_on,
    v_after.estimate_sent_on,
    v_after.estimate_adjusting,
    v_after.estimate_approved_on,
    v_after.booking_confirmed_on,
    v_after.event_preparation_completed_on,
    v_after.event_completed_on,
    v_after.invoice_sent
  );

  update public.pa_case_progress
  set
    current_step = v_next_step,
    estimate_amount = v_after.estimate_amount,
    estimate_created_on = v_after.estimate_created_on,
    estimate_sent_on = v_after.estimate_sent_on,
    estimate_adjusting = v_after.estimate_adjusting,
    estimate_approved_on = v_after.estimate_approved_on,
    estimate_memo = v_after.estimate_memo,
    booking_confirmed_on = v_after.booking_confirmed_on,
    confirmed_event_date = v_after.confirmed_event_date,
    event_preparing = v_after.event_preparing,
    event_preparation_completed_on = v_after.event_preparation_completed_on,
    event_completed_on = v_after.event_completed_on,
    event_memo = v_after.event_memo,
    invoice_amount = v_after.invoice_amount,
    invoice_issued_on = v_after.invoice_issued_on,
    payment_due_on = v_after.payment_due_on,
    invoice_sent = v_after.invoice_sent,
    invoice_memo = v_after.invoice_memo,
    updated_at = now(),
    updated_by = auth.uid()
  where inquiry_id = p_inquiry_id
  returning * into v_after;

  insert into public.pa_inquiry_audit (
    inquiry_id,
    actor_user_id,
    action,
    details
  )
  values (
    p_inquiry_id,
    auth.uid(),
    'case_progress_updated',
    jsonb_build_object(
      'step_before', v_before.current_step,
      'step_after', v_after.current_step,
      'state_before', to_jsonb(v_before) - array['inquiry_id', 'created_at', 'updated_at', 'updated_by'],
      'state_after', to_jsonb(v_after) - array['inquiry_id', 'created_at', 'updated_at', 'updated_by'],
      'note', v_note,
      'operator_label', v_actor_label
    )
  );

  return v_after;
end;
$$;

create or replace function public.reconcile_pa_estimate_submission(
  p_inquiry_id uuid,
  p_gmail_message_id text,
  p_gmail_thread_id text,
  p_expected jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inquiry public.pa_inquiries%rowtype;
  v_progress public.pa_case_progress%rowtype;
  v_message public.pa_gmail_message_index%rowtype;
  v_record public.pa_estimate_submission_reconciliations%rowtype;
  v_existing boolean;
begin
  if not public.is_work_admin() or auth.uid() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_inquiry_id is null
    or p_gmail_message_id is null or p_gmail_message_id !~ '^[A-Za-z0-9_-]{1,200}$'
    or p_gmail_thread_id is null or p_gmail_thread_id !~ '^[A-Za-z0-9_-]{1,200}$'
    or p_expected is null or jsonb_typeof(p_expected) <> 'object'
    or octet_length(p_expected::text) > 2000
    or not (p_expected ?& array['status', 'case_updated_at', 'progress_updated_at', 'estimate_created_on', 'sent_at']) then
    raise exception 'invalid estimate reconciliation';
  end if;

  -- Same lock order as the canonical progress RPC. Serializes simultaneous
  -- retries for this case and rolls back every write on any later failure.
  select * into v_inquiry from public.pa_inquiries where id = p_inquiry_id for update;
  if not found or v_inquiry.deleted_at is not null then
    raise exception 'inquiry not found';
  end if;
  select * into v_progress from public.pa_case_progress where inquiry_id = p_inquiry_id for update;
  if not found then raise exception 'case progress not found'; end if;
  perform 1 from public.pa_gmail_thread_links
    where inquiry_id = p_inquiry_id and gmail_thread_id = p_gmail_thread_id
      and conversation_role in ('primary_conversation', 'secondary_conversation') for share;
  if not found then raise exception 'gmail thread not linked'; end if;
  select * into v_message from public.pa_gmail_message_index
    where inquiry_id = p_inquiry_id and gmail_message_id = p_gmail_message_id
      and gmail_thread_id = p_gmail_thread_id and direction = 'outbound'
      and message_source = 'gmail_direct' for share;
  if not found then raise exception 'direct gmail message not indexed'; end if;
  if v_message.sent_at is null
    or v_message.sent_at is distinct from (p_expected ->> 'sent_at')::timestamptz then
    raise exception 'reconciliation target changed';
  end if;

  select * into v_record from public.pa_estimate_submission_reconciliations
    where inquiry_id = p_inquiry_id and gmail_message_id = p_gmail_message_id for update;
  v_existing := found;
  if v_existing then
    if v_record.submitted_at is null then
      raise exception 'legacy reconciliation requires review';
    end if;
    if v_record.submitted_at is distinct from v_message.sent_at then
      raise exception 'reconciliation target changed';
    end if;
    -- A committed record proves the progress and both audits committed too.
    -- Replay never reopens a later stage or overwrites the first send date.
  else
    if v_inquiry.status is distinct from (p_expected ->> 'status')
      or v_inquiry.updated_at is distinct from (p_expected ->> 'case_updated_at')::timestamptz
      or v_progress.updated_at is distinct from (p_expected ->> 'progress_updated_at')::timestamptz
      or v_progress.estimate_created_on is null
      or v_progress.estimate_created_on is distinct from (p_expected ->> 'estimate_created_on')::date then
      raise exception 'reconciliation target changed';
    end if;
    insert into public.pa_estimate_submission_reconciliations
      (inquiry_id, gmail_message_id, reconciled_by, submitted_at)
      values (p_inquiry_id, p_gmail_message_id, auth.uid(), v_message.sent_at)
      returning * into v_record;
    select * into v_progress from public.update_pa_case_progress(
      p_inquiry_id,
      jsonb_build_object('estimate_sent_on', (v_record.submitted_at at time zone 'UTC')::date, 'estimate_adjusting', true),
      'Gmail直接送信の見積提出を記録'
    );
    insert into public.pa_inquiry_audit (inquiry_id, actor_user_id, action, details)
      values (p_inquiry_id, auth.uid(), 'gmail_direct_estimate_submission_reconciled',
        jsonb_build_object('gmail_message_id', p_gmail_message_id, 'gmail_thread_id', p_gmail_thread_id,
          'source', 'gmail_direct', 'submitted_at', v_record.submitted_at));
  end if;
  return jsonb_build_object(
    'inquiry_id', p_inquiry_id, 'gmail_message_id', p_gmail_message_id, 'gmail_thread_id', p_gmail_thread_id,
    'already_reconciled', v_existing, 'submitted_at', v_record.submitted_at,
    'reconciled_at', v_record.reconciled_at, 'progress', to_jsonb(v_progress)
  );
end;
$$;

revoke all on function public.reconcile_pa_estimate_submission(uuid, text, text, jsonb) from public, anon;
grant execute on function public.reconcile_pa_estimate_submission(uuid, text, text, jsonb) to authenticated;
comment on function public.reconcile_pa_estimate_submission(uuid, text, text, jsonb) is
  'Admin-only exact case/message/thread reconciliation. Snapshot preconditions, immutable first send time, audit and progress commit atomically; retries are read-only.';

commit;

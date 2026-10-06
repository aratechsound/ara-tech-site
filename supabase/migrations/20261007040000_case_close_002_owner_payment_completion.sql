-- CASE-CLOSE-002: function-only extension of the existing RPC.
-- No table/column/status changes; no existing rows rewritten.
begin;

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

  -- Owner attestation: reuse payment_received without inventing accounting metadata.
  if p_progress ? 'close_reason' then
    if p_progress <> '{"close_reason":"payment_received"}'::jsonb then
      raise exception 'invalid completion attestation';
    end if;
    select * into v_inquiry from public.pa_inquiries where id=p_inquiry_id for update;
    if not found or v_inquiry.deleted_at is not null
      or (to_jsonb(v_inquiry)->>'case_type') is distinct from 'PA_EVENT' then
      raise exception 'PA case unavailable';
    end if;
    select * into v_before from public.pa_case_progress where inquiry_id=p_inquiry_id for update;
    if not found then raise exception 'case progress not found'; end if;
    if v_inquiry.status='closed' and v_before.close_reason='payment_received' then
      return v_before;
    end if;
    if v_inquiry.status in ('schedule_unavailable','declined','cancelled','closed')
      or v_before.closed_at is not null then
      raise exception 'closed case cannot be reclassified';
    end if;
    update public.pa_case_progress set current_step=14,is_on_hold=false,
      close_reason='payment_received',closed_from_step=least(v_before.current_step,13),
      closed_at=now(),updated_at=now(),updated_by=auth.uid()
      where inquiry_id=p_inquiry_id;
    update public.pa_inquiries set status='closed' where id=p_inquiry_id;
    insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
      values(p_inquiry_id,auth.uid(),'owner_payment_completion_confirmed',jsonb_build_object(
        'status_before',v_inquiry.status,'status_after','closed',
        'step_before',v_before.current_step,'step_after',14,
        'close_reason','payment_received','confirmation_source','owner_attestation',
        'payment_metadata_recorded',false,'operator_label',v_actor_label,'note',v_note));
    select * into v_after from public.pa_case_progress where inquiry_id=p_inquiry_id;
    return v_after;
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
  if v_inquiry.status <> 'schedule_confirmed' then
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


commit;

-- PAM-001: retain all case, mail, payment, schedule, and audit facts while
-- replacing only the meaning of the persisted 1..14 workflow projection.
-- No existing case rows are rewritten by this migration.

create or replace function public.initial_pa_workflow_step(p_status text)
returns smallint
language sql
immutable
as $$
  select case p_status
    when 'new' then 1
    when 'new_inquiry' then 1
    when 'follow_up_pending' then 1
    when 'waiting_customer_reply' then 2
    when 'hearing' then 2
    when 'reviewing' then 2
    when 'rough_estimate' then 3
    when 'customer_intent_confirmed' then 4
    when 'schedule_coordination' then 5
    when 'second_form_not_issued' then 5
    when 'second_form_issued' then 5
    when 'customer_responded' then 5
    when 'schedule_unconfirmed' then 5
    when 'schedule_adjusting' then 5
    when 'needs_confirmation' then 5
    when 'schedule_confirmed' then 5
    when 'on_hold' then 2
    when 'schedule_unavailable' then 14
    when 'declined' then 14
    when 'cancelled' then 14
    when 'closed' then 14
    else 1
  end::smallint;
$$;

create or replace function public.derive_pa_workflow_step(
  p_status text,
  p_estimate_created_on date,
  p_estimate_sent_on date,
  p_estimate_adjusting boolean,
  p_estimate_approved_on date,
  p_booking_confirmed_on date,
  p_event_preparation_completed_on date,
  p_event_completed_on date,
  p_invoice_sent boolean
)
returns smallint
language sql
stable
as $$
  select case
    when p_status in ('schedule_unavailable', 'declined', 'cancelled', 'closed') then 14
    -- Schedule tools are supporting facts under stage 5, not workflow stages.
    when p_status <> 'schedule_confirmed' then public.initial_pa_workflow_step(p_status)
    when p_estimate_created_on is null then 6
    when p_estimate_sent_on is null or coalesce(p_estimate_adjusting, false) then 7
    when p_estimate_approved_on is null then 8
    when p_booking_confirmed_on is null then 9
    when p_event_preparation_completed_on is null then 10
    when p_event_completed_on is null then 11
    when coalesce(p_invoice_sent, false) is not true then 12
    else 13
  end::smallint;
$$;

comment on function public.initial_pa_workflow_step(text) is
  'PAM-001 canonical 14-stage projection: 商談 1-4, 受注 5-8, 準備 9-10, 実施 11, 精算 12-14.';

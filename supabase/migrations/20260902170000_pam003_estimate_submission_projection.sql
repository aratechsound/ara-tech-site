-- PAM-003: use the existing estimate facts for the existing rough_estimate
-- status. No case row is changed by this migration.
--
-- A rough estimate remains stage 3 until a saved estimate-creation date exists.
-- Thereafter the established 14-stage projection exposes estimate creation,
-- estimate submission/customer response, and formal acceptance separately.

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
    when p_status not in ('rough_estimate', 'schedule_confirmed') then public.initial_pa_workflow_step(p_status)
    when p_estimate_created_on is null and p_status = 'rough_estimate' then 3
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

comment on function public.derive_pa_workflow_step(text, date, date, boolean, date, date, date, date, boolean) is
  'PAM-003 preserves existing statuses and derives the canonical estimate creation, estimate submission/customer-response, and formal acceptance steps from persisted estimate facts.';

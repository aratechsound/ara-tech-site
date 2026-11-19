-- Remove dispatch guards after rolling back the paired application.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
lock table public.pa_email_deliveries in share row exclusive mode;
do $guard$ begin
  if exists (select from public.pa_email_deliveries where message_type='schedule_request' and status='sending') then
    raise exception 'schedule_delivery_busy';
  end if;
end $guard$;
drop function public.pa_claim_schedule_invitation(jsonb);
drop trigger pa_schedule_invitation_revocation_guard on public.pa_schedule_tokens;
drop trigger pa_schedule_invitation_insert_guard on public.pa_email_deliveries;
drop function public.pa_guard_schedule_revocation_during_delivery();
drop function public.pa_guard_schedule_invitation_insert();
drop function public.pa_schedule_invitation_hash(text);
commit;

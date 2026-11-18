begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

lock table public.pa_commercial_outbox in share row exclusive mode;
do $guard$
begin
  if exists (
    select 1 from public.pa_commercial_outbox
    where state = 'processing'
       or (state = 'failed' and not coalesce(
          (delivery_state = 'failed_before_provider' and provider_request_started is false
            and provider_response_received is false and provider_http_status is null)
          or (delivery_state = 'failed_after_provider_response' and provider_request_started is true
            and provider_response_received is true and provider_http_status in (400, 401, 403, 404, 413, 422, 429)),
          false))
  ) then
    raise exception 'outbox_unknown_requires_reconciliation';
  end if;
end
$guard$;

drop function public.pa_v5_claim_guarded_outbox(uuid, uuid, uuid);
drop function public.pa_v5_assert_outbox_retry_guard();
drop trigger pa_commercial_outbox_retry_guard on public.pa_commercial_outbox;
drop function public.pa_guard_commercial_outbox_retry();

notify pgrst, 'reload schema';

commit;

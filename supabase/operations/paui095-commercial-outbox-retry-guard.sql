begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

create function public.pa_guard_commercial_outbox_retry()
returns trigger
language plpgsql
set search_path = pg_catalog
as $fn$
begin
  -- An expired lease cannot establish whether its worker reached Gmail.
  if old.state = 'processing' then
    raise exception 'outbox_unknown_requires_reconciliation';
  end if;

  if old.state = 'failed' and not coalesce(
    (old.delivery_state = 'failed_before_provider' and old.provider_request_started is false
      and old.provider_response_received is false and old.provider_http_status is null)
    or
    (old.delivery_state = 'failed_after_provider_response' and old.provider_request_started is true
      and old.provider_response_received is true and old.provider_http_status in (400, 401, 403, 404, 413, 422, 429)),
    false
  ) then
    raise exception 'outbox_unknown_requires_reconciliation';
  end if;
  return new;
end
$fn$;

revoke all on function public.pa_guard_commercial_outbox_retry() from public, anon, authenticated;

-- Guard claims and direct-confirmation supersession inside the existing transactions.
create trigger pa_commercial_outbox_retry_guard
before update of state, lease_id, attempt_count on public.pa_commercial_outbox
for each row when ((new.state = 'processing' and
  (new.lease_id is distinct from old.lease_id or new.attempt_count is distinct from old.attempt_count))
  or (new.state = 'cancelled' and old.state = 'failed' and old.job_kind = 'estimate'
    and new.last_error_code in ('estimate_presented_with_confirmation', 'estimate_available_in_confirmation')))
execute function public.pa_guard_commercial_outbox_retry();

commit;

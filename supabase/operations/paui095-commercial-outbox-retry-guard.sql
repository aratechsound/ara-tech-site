begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

create function public.pa_commercial_outbox_failure_retryable(p_job public.pa_commercial_outbox)
returns boolean
language sql immutable
set search_path = pg_catalog
as $fn$
  select coalesce(p_job.provider_message_id is null and p_job.provider_thread_id is null and (
    (p_job.delivery_state = 'failed_before_provider' and p_job.provider_request_started is false
      and p_job.provider_response_received is false and p_job.provider_http_status is null)
    or
    (p_job.delivery_state = 'failed_after_provider_response' and p_job.provider_request_started is true
      and p_job.provider_response_received is true and p_job.provider_http_status in (400, 401, 403, 404, 413, 422, 429))
  ), false)
$fn$;

revoke all on function public.pa_commercial_outbox_failure_retryable(public.pa_commercial_outbox)
  from public, anon, authenticated;

create function public.pa_guard_commercial_outbox_retry()
returns trigger
language plpgsql
set search_path = pg_catalog
as $fn$
declare
  prior public.pa_commercial_outbox%rowtype;
begin
  if tg_op = 'INSERT' then
    -- A new operation ID must not bypass an unresolved delivery for the same
    -- business record. Lock matching rows in ID order and inspect their latest state.
    for prior in
      select * from public.pa_commercial_outbox
      where inquiry_id = new.inquiry_id and job_kind = new.job_kind and aggregate_id = new.aggregate_id
      order by id for no key update
    loop
      if prior.state in ('processing', 'unknown') or prior.delivery_state = 'unknown_after_provider_start'
        or (prior.state = 'failed' and not public.pa_commercial_outbox_failure_retryable(prior)) then
        raise exception 'outbox_unknown_requires_reconciliation';
      end if;
      if prior.state = 'queued' then
        raise exception 'outbox_busy';
      end if;
    end loop;
    return new;
  end if;

  -- An expired lease cannot establish whether its worker reached Gmail.
  if old.state in ('processing', 'unknown') or old.delivery_state = 'unknown_after_provider_start' then
    raise exception 'outbox_unknown_requires_reconciliation';
  end if;

  if old.state = 'failed' and not public.pa_commercial_outbox_failure_retryable(old) then
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

create trigger pa_commercial_outbox_retry_insert_guard
before insert on public.pa_commercial_outbox
for each row when (new.state = 'queued')
execute function public.pa_guard_commercial_outbox_retry();

-- The new application can reserve a delivery only through the guarded SQL.
-- Validate the trigger before issuing a new direct confirmation as well.
create function public.pa_v5_assert_outbox_retry_guard()
returns boolean
language plpgsql stable
set search_path = pg_catalog
as $fn$
begin
  if 2 <> (
    select count(*) from pg_trigger
    where tgrelid = 'public.pa_commercial_outbox'::regclass
      and tgname in ('pa_commercial_outbox_retry_guard', 'pa_commercial_outbox_retry_insert_guard')
      and tgfoid = to_regprocedure('public.pa_guard_commercial_outbox_retry()')
      and tgenabled in ('O', 'A') and not tgisinternal
  ) then
    raise exception 'outbox_retry_guard_unavailable';
  end if;
  return true;
end
$fn$;

-- Keep the guard in place throughout the existing claim transaction. The service
-- role retains RPC-only writes and the original claim still verifies the actor.
create function public.pa_v5_claim_guarded_outbox(p_actor uuid, p_job uuid, p_lease uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog
as $fn$
begin
  lock table public.pa_commercial_outbox in row exclusive mode;
  perform public.pa_v5_assert_outbox_retry_guard();
  return public.pa_v5_outbox_claim(p_actor, p_job, p_lease);
end
$fn$;

revoke all on function public.pa_v5_assert_outbox_retry_guard(),
  public.pa_v5_claim_guarded_outbox(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.pa_v5_assert_outbox_retry_guard(),
  public.pa_v5_claim_guarded_outbox(uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';

commit;

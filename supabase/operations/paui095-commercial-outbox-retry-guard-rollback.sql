begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

lock table public.pa_commercial_outbox in share row exclusive mode;
do $guard$
begin
  if exists (
    select 1 from public.pa_commercial_outbox as job
    where job.state = 'processing'
       or (job.state = 'failed' and not public.pa_commercial_outbox_failure_retryable(job))
  ) then
    raise exception 'outbox_unknown_requires_reconciliation';
  end if;
end
$guard$;

drop function public.pa_v5_claim_guarded_outbox(uuid, uuid, uuid);
drop function public.pa_v5_assert_outbox_retry_guard();
drop trigger pa_commercial_outbox_retry_insert_guard on public.pa_commercial_outbox;
drop trigger pa_commercial_outbox_retry_guard on public.pa_commercial_outbox;
drop function public.pa_guard_commercial_outbox_retry();
drop function public.pa_commercial_outbox_failure_retryable(public.pa_commercial_outbox);

notify pgrst, 'reload schema';

commit;

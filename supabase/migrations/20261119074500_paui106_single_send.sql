begin;

-- Old application instances use the same claim RPC. Block reclaims at the row
-- transition so an expired lease or an ambiguous finish cannot reopen delivery.
create function public.pa106_outbox_one_claim()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if (new.attempt_count is distinct from old.attempt_count
      or (new.state = 'processing' and old.state <> 'processing'))
     and not (old.attempt_count = 0 and old.state = 'queued'
              and new.attempt_count = 1 and new.state = 'processing') then
    raise exception 'outbox_unknown_requires_reconciliation';
  end if;
  return new;
end;
$$;
create trigger pa106_outbox_one_claim
before update of attempt_count, state on public.pa_commercial_outbox
for each row execute function public.pa106_outbox_one_claim();

revoke all on function public.pa106_outbox_one_claim() from public, anon, authenticated;

commit;

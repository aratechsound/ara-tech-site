begin;

create function public.pa106_require_receipt_resend_ack()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
    perform 1 from public.pa_contracts where id = new.contract_id for update;
    if new.acknowledged_duplicate_risk is not true and exists (
        select 1 from public.pa_contract_deliveries where contract_id = new.contract_id
    ) then
        raise exception 'resend_ack_required';
    end if;
    return new;
end;
$$;

revoke execute on function public.pa106_require_receipt_resend_ack() from public, anon, authenticated;

create trigger pa106_receipt_resend_ack
before insert on public.pa_contract_deliveries
for each row execute function public.pa106_require_receipt_resend_ack();

commit;

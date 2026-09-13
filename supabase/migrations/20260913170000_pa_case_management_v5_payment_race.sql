-- PA-EST-004R6: serialize a same-case payment operation before idempotency readback.
-- Forward-only local candidate. Production application requires a separate release gate.
begin;

create or replace function public.pa_v5_record_payment(
  p_actor uuid,p_case uuid,p_billing uuid,p_operation uuid,p_payment_date date,
  p_amount_minor bigint,p_method text,p_memo text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid; v_existing public.pa_payment_records%rowtype;
begin
  perform public.pa_v5_assert_admin(p_actor);
  if p_operation is null or p_amount_minor<=0 or p_method not in ('bank_transfer','cash','other') or p_payment_date is null then
    raise exception 'invalid_payment';
  end if;

  -- All case mutations use this row as their first durable lock. Waiting here
  -- before the idempotency lookup gives the retry a fresh SPI statement after
  -- the winning transaction commits, instead of falling through to a unique
  -- violation with a pre-wait snapshot.
  perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update;
  if not found then raise exception 'case_unavailable'; end if;

  select * into v_existing from public.pa_payment_records where operation_id=p_operation;
  if found then
    if v_existing.inquiry_id<>p_case or v_existing.billing_id is distinct from p_billing
      or v_existing.payment_date<>p_payment_date or round(v_existing.amount)::bigint<>p_amount_minor
      or v_existing.payment_method<>p_method
      or coalesce(v_existing.confirmation_memo,'')<>btrim(coalesce(p_memo,'')) then
      raise exception 'idempotency_payload_mismatch';
    end if;
    return jsonb_build_object('id',v_existing.id,'already_committed',true);
  end if;

  perform public.pa_v5_state(p_case);
  perform 1 from public.pa_billings where id=p_billing and inquiry_id=p_case and state='open' for update;
  if not found then raise exception 'billing_not_open'; end if;
  v_id:=gen_random_uuid();
  insert into public.pa_payment_records(
    id,inquiry_id,confirmation_source,payment_date,amount,payment_method,confirmation_memo,
    confirmed_by,confirmed_by_label,confirmed_at,external_transaction_id,billing_id,operation_id,recorded_only
  ) values(
    v_id,p_case,'manual',p_payment_date,p_amount_minor::numeric,p_method,
    nullif(btrim(coalesce(p_memo,'')),''),p_actor,p_actor::text,now(),null,p_billing,p_operation,true
  );
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
    values(p_case,p_actor,'payment_recorded',jsonb_build_object(
      'payment_id',v_id,'billing_id',p_billing,'amount_minor',p_amount_minor,
      'payment_date',p_payment_date,'operation_id',p_operation
    ));
  return jsonb_build_object('id',v_id,'already_committed',false);
end $$;

revoke all on function public.pa_v5_record_payment(uuid,uuid,uuid,uuid,date,bigint,text,text)
  from public,anon,authenticated;
grant execute on function public.pa_v5_record_payment(uuid,uuid,uuid,uuid,date,bigint,text,text)
  to service_role;

commit;

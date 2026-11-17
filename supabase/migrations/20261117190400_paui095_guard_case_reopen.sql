begin;

create function public.pa_v5_reopen_case(
  p_actor uuid, p_case uuid, p_operation uuid, p_reason text, p_expected_revision bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_case public.pa_inquiries%rowtype;
  v_state public.pa_case_commercial_state%rowtype;
  v_on_hold boolean;
begin
  perform public.pa_v5_assert_admin(p_actor);
  if p_operation is null or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 2000 then
    raise exception 'reopen_reason_required';
  end if;

  select * into v_case from public.pa_inquiries where id=p_case and deleted_at is null for update;
  if not found then raise exception 'case_unavailable'; end if;
  select * into v_state from public.pa_case_commercial_state where inquiry_id=p_case for update;
  if not found then raise exception 'case_unavailable'; end if;
  if v_state.reopen_operation_id=p_operation then
    return to_jsonb(v_state)||jsonb_build_object('already_committed',true);
  end if;
  if p_expected_revision is not null and v_state.revision<>p_expected_revision then
    raise exception 'commercial_state_changed';
  end if;

  select is_on_hold into v_on_hold from public.pa_case_progress where inquiry_id=p_case for update;
  if v_case.status<>'closed' or v_on_hold is distinct from false or v_state.closed_operation_id is null then
    raise exception 'case_unavailable';
  end if;

  update public.pa_case_progress
    set current_step=13,close_reason=null,closed_from_step=null,closed_at=null,updated_at=now(),updated_by=p_actor
    where inquiry_id=p_case;
  update public.pa_inquiries set status='schedule_confirmed' where id=p_case;
  update public.pa_billings set state='open',updated_at=now() where inquiry_id=p_case and state='paid';
  update public.pa_case_commercial_state
    set closed_operation_id=null,reopen_operation_id=p_operation,reopened_at=now(),revision=revision+1,
        updated_at=now(),updated_by=p_actor
    where inquiry_id=p_case returning * into v_state;
  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
    values(p_case,p_actor,'case_reopened_v5',jsonb_build_object('reason',btrim(p_reason),
      'operation_id',p_operation,'payments_preserved',true,'contract_preserved',true));
  return to_jsonb(v_state);
end $$;

-- Preserve the existing authorized callers and subject them to the same eligibility check.
create or replace function public.pa_v5_reopen_case(p_actor uuid,p_case uuid,p_operation uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.pa_v5_reopen_case(p_actor,p_case,p_operation,p_reason,null::bigint);
$$;

revoke all on function public.pa_v5_reopen_case(uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.pa_v5_reopen_case(uuid,uuid,uuid,text,bigint) to service_role;

commit;

begin;

create or replace function public.enforce_pa_schedule_result_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_expected_type text;
begin
  if new.status in ('schedule_confirmed', 'schedule_unavailable')
    and new.status is distinct from old.status
  then
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'result state requires a sent Gmail delivery';
    end if;

    -- An audited V5 paid-case reopen restores its working status without a new result email.
    if old.status='closed' and new.status='schedule_confirmed'
      and exists(
        select 1 from public.pa_inquiry_audit a
          join public.pa_case_commercial_state c on c.inquiry_id=a.inquiry_id
        where a.inquiry_id=old.id and a.action='case_reopened_v5'
          and a.details->>'operation_id'=current_setting('ara_tech.pa_v5_reopen_operation',true)
          and a.details->>'closed_operation_id'=c.closed_operation_id::text
      ) then return new; end if;

    v_expected_type := case new.status
      when 'schedule_confirmed' then 'schedule_result_confirmed'
      else 'schedule_result_unavailable'
    end;

    perform 1
    from public.pa_email_deliveries
    where id = new.schedule_result_delivery_id
      and inquiry_id = new.id
      and message_type = v_expected_type
      and status = 'sent'
      and sent_at is not null
      and gmail_message_id is not null;

    if not found then
      raise exception 'result state requires a sent Gmail delivery';
    end if;
  end if;

  return new;
end;
$$;

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
  v_progress public.pa_case_progress%rowtype;
  v_billing uuid;
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
  if v_state.revision is distinct from p_expected_revision then
    raise exception 'commercial_state_changed';
  end if;

  select * into v_progress from public.pa_case_progress where inquiry_id=p_case for update;
  if v_case.status<>'closed' or v_progress.is_on_hold is distinct from false or v_state.closed_operation_id is null
    or v_progress.close_reason is distinct from 'payment_received' or v_progress.closed_at is null then
    raise exception 'case_unavailable';
  end if;
  select b.id into v_billing
    from public.pa_inquiry_audit a
    join public.pa_billings b on b.id::text=a.details->>'billing_id'
    where a.inquiry_id=p_case and a.action='payment_confirmed_and_closed_v5'
      and a.details->>'operation_id'=v_state.closed_operation_id::text
      and a.occurred_at=v_progress.closed_at and b.inquiry_id=p_case and b.state='paid'
    for update of b;
  if not found then raise exception 'case_unavailable'; end if;

  insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
    values(p_case,p_actor,'case_reopened_v5',jsonb_build_object('reason',btrim(p_reason),
      'operation_id',p_operation,'closed_operation_id',v_state.closed_operation_id,'billing_id',v_billing,'payments_preserved',true,'contract_preserved',true));
  perform set_config('ara_tech.pa_v5_reopen_operation',p_operation::text,true);

  -- Clear the paid-close marker before the generic status guard runs.
  update public.pa_case_progress set close_reason=null where inquiry_id=p_case;
  update public.pa_inquiries set status='schedule_confirmed' where id=p_case;
  perform set_config('ara_tech.pa_v5_reopen_operation','',true);
  -- The status trigger recalculates from legacy milestones. A commercial reopen
  -- resumes at payment review even when those milestones were skipped.
  update public.pa_case_progress
    set current_step=13,closed_from_step=null,closed_at=null,updated_at=now(),updated_by=p_actor
    where inquiry_id=p_case;
  update public.pa_billings set state='open',updated_at=now() where id=v_billing;
  update public.pa_case_commercial_state
    set closed_operation_id=null,reopen_operation_id=p_operation,reopened_at=now(),revision=revision+1,
        updated_at=now(),updated_by=p_actor
    where inquiry_id=p_case returning * into v_state;
  return to_jsonb(v_state);
end $$;

-- An old client has neither the Owner gate nor the expected revision.
create or replace function public.pa_v5_reopen_case(p_actor uuid,p_case uuid,p_operation uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.pa_v5_reopen_case(p_actor,p_case,p_operation,p_reason,null::bigint);
$$;

revoke all on function public.pa_v5_reopen_case(uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.pa_v5_reopen_case(uuid,uuid,uuid,text,bigint) to service_role;

commit;

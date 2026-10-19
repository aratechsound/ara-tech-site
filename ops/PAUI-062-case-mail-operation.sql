-- PAUI-062: one additive service-only RPC over the existing PAUI-046 ledger.
-- No existing function replacement, schema/table/grant changes, UPDATE or DELETE.
begin;
create function public.pa_case_mail_operation_v1(p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.pa_reply_operations_v1; e public.pa_reply_operation_events_v1;
 c uuid; k uuid; b jsonb; h text; claimed boolean:=false; s text;
begin
 if p_actor is null or not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized';end if;
 if p_action not in ('prepare','get','claim','failed','unknown','sent','history') or jsonb_typeof(p_payload)<>'object' then raise exception 'invalid_reply_operation';end if;
 c:=(p_payload->>'inquiry_id')::uuid;k:=(p_payload->>'operation_id')::uuid;
 if c is null or not exists(select 1 from public.pa_inquiries where id=c and deleted_at is null) then raise exception 'inquiry_not_found';end if;
 if p_action='prepare' then
  b:=p_payload->'binding';h:=p_payload->>'binding_hash';
  if k is null or jsonb_typeof(b)<>'object' or h is null or h !~ '^[a-f0-9]{64}$'
   or b->>'contract' is distinct from 'PAUI-062' or b->>'inquiry_id' is distinct from c::text
   or b->>'account' is distinct from 'aratechsound@gmail.com'
   or b->>'case_email' is null or not exists(select 1 from public.pa_inquiries where id=c and pg_catalog.lower(email)=b->>'case_email')
   or b->>'kind' is null or b->>'kind' not in ('reply','contact','new','invoice')
   or b->>'to' is null or b->>'to'='aratechsound@gmail.com' or coalesce(b->>'authority_hash','') !~ '^[a-f0-9]{64}$'
   or (b->>'kind'<>'new' and (coalesce(b->>'thread_id','') !~ '^[A-Za-z0-9_-]{1,200}$' or coalesce(b->>'source_id','') !~ '^[A-Za-z0-9_-]{1,200}$')) then raise exception 'reply_operation_mismatch';end if;
  if b->>'source_id' is not null and (not exists(select 1 from public.pa_gmail_thread_links where inquiry_id=c and gmail_thread_id=b->>'thread_id')
   or not exists(select 1 from public.pa_gmail_message_index where inquiry_id=c and gmail_thread_id=b->>'thread_id' and gmail_message_id=b->>'source_id')
   or exists(select 1 from public.pa_gmail_message_index where gmail_message_id=b->>'source_id' and inquiry_id<>c)
   or exists(select 1 from public.pa_gmail_thread_links where gmail_thread_id=b->>'thread_id' and inquiry_id<>c)) then raise exception 'reply_operation_mismatch';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor::text||c::text||h,46));
  select * into o from public.pa_reply_operations_v1 where actor_id=p_actor and inquiry_id=c and binding_hash=h order by created_at desc,operation_id desc limit 1 for update;
  if found then
   select * into e from public.pa_reply_operation_events_v1 where operation_id=o.operation_id order by seq desc limit 1;
   if o.binding<>b then raise exception 'reply_operation_mismatch';end if;
   if e.state in ('SENDING','UNKNOWN') or (e.state='PREPARED' and o.expires_at>now())
    or (e.state='SENT' and not coalesce(p_payload->>'new_operation'='true' and p_payload->>'previous_operation_id'=o.operation_id::text,false)) then null;
   else o.operation_id:=null;end if;
  end if;
  if o.operation_id is null then
   insert into public.pa_reply_operations_v1(operation_id,inquiry_id,actor_id,account,binding,binding_hash,rfc_message_id)
    values(k,c,p_actor,'aratechsound@gmail.com',b,h,'<pa-reply-'||k||'@ara-tech.cc>') returning * into o;
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'PREPARED') returning * into e;
  end if;
 else
  if k is null and p_action='get' then
   select ro.* into o from public.pa_reply_operations_v1 ro
    left join lateral(select ev.state from public.pa_reply_operation_events_v1 ev where ev.operation_id=ro.operation_id order by ev.seq desc limit 1) last_event on true
    where ro.actor_id=p_actor and ro.inquiry_id=c and ro.binding->>'contract'='PAUI-062'
    order by (last_event.state in ('SENDING','UNKNOWN')) desc,ro.created_at desc,ro.operation_id desc limit 1;
   if not found then return jsonb_build_object('ok',true,'operation',null);end if;
  else
   select * into o from public.pa_reply_operations_v1 where operation_id=k and actor_id=p_actor and inquiry_id=c and binding->>'contract'='PAUI-062' for update;
   if not found then raise exception 'reply_operation_mismatch';end if;
  end if;
  select * into e from public.pa_reply_operation_events_v1 where operation_id=o.operation_id order by seq desc limit 1;
  if p_action='claim' and not exists(select 1 from public.pa_inquiries where id=c and pg_catalog.lower(email)=o.binding->>'case_email') then raise exception 'reply_operation_mismatch';end if;
  if p_action in ('claim','sent') and o.binding->>'source_id' is not null
   and (not exists(select 1 from public.pa_gmail_thread_links where inquiry_id=c and gmail_thread_id=o.binding->>'thread_id')
    or not exists(select 1 from public.pa_gmail_message_index where inquiry_id=c and gmail_thread_id=o.binding->>'thread_id' and gmail_message_id=o.binding->>'source_id')
    or exists(select 1 from public.pa_gmail_message_index where gmail_message_id=o.binding->>'source_id' and inquiry_id<>c)
    or exists(select 1 from public.pa_gmail_thread_links where gmail_thread_id=o.binding->>'thread_id' and inquiry_id<>c)) then raise exception 'reply_operation_mismatch';end if;
  if p_action='claim' and e.state='PREPARED' and o.expires_at>now() then
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'SENDING') returning * into e;claimed:=true;
  elsif p_action='failed' and e.state='PREPARED' then
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'FAILED_BEFORE_SEND') returning * into e;
  elsif p_action='unknown' and e.state in ('SENDING','UNKNOWN') then
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'UNKNOWN') returning * into e;
  elsif p_action='sent' and e.state in ('SENDING','UNKNOWN') then
   if coalesce(p_payload->>'gmail_message_id','') !~ '^[A-Za-z0-9_-]{1,200}$' or coalesce(p_payload->>'gmail_thread_id','') !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception 'reply_operation_mismatch';end if;
   insert into public.pa_reply_operation_events_v1(operation_id,state,evidence) values(o.operation_id,'SENT',jsonb_build_object('gmail_message_id',p_payload->>'gmail_message_id','gmail_thread_id',p_payload->>'gmail_thread_id','history_sync','INCOMPLETE')) returning * into e;
  elsif p_action='history' and e.state='SENT' then
   insert into public.pa_reply_operation_events_v1(operation_id,state,evidence) values(o.operation_id,'SENT',e.evidence||jsonb_build_object('history_sync',case when p_payload->>'complete'='true' then 'COMPLETE' else 'INCOMPLETE' end)) returning * into e;
  elsif p_action<>'get' and p_action not in ('claim','failed','unknown') then raise exception 'reply_operation_conflict';end if;
 end if;
 s:=e.state;if s='SENDING' and e.created_at<now()-interval '5 minutes' then s:='UNKNOWN';end if;
 return jsonb_build_object('ok',true,'claimed',claimed,'operation',jsonb_build_object('operation_id',o.operation_id,'inquiry_id',o.inquiry_id,'binding',o.binding,'binding_hash',o.binding_hash,'state',s,'gmail_message_id',e.evidence->>'gmail_message_id','gmail_thread_id',e.evidence->>'gmail_thread_id','history_sync',e.evidence->>'history_sync','created_at',o.created_at,'expires_at',o.expires_at));
end;
$$;
revoke all on function public.pa_case_mail_operation_v1(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.pa_case_mail_operation_v1(uuid,text,jsonb) to service_role;
commit;

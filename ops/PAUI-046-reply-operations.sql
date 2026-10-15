-- PAUI-046: additive, service-only, append-only send-operation ledger.
-- No ALTER of existing tables/functions, no UPDATE/DELETE of customer rows.
begin;
create table public.pa_reply_operations_v1 (
 operation_id uuid primary key,
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 actor_id uuid not null,
 account text not null check(account='aratechsound@gmail.com'),
 binding jsonb not null check(jsonb_typeof(binding)='object'),
 binding_hash text not null check(binding_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '10 minutes',
 rfc_message_id text not null unique,
 unique(operation_id,inquiry_id)
);
create index pa_reply_operations_v1_lookup on public.pa_reply_operations_v1(actor_id,inquiry_id,binding_hash,created_at desc);
create table public.pa_reply_operation_events_v1 (
 seq bigint generated always as identity primary key,
 operation_id uuid not null references public.pa_reply_operations_v1(operation_id) on delete restrict,
 state text not null check(state in ('PREPARED','SENDING','SENT','UNKNOWN','FAILED_BEFORE_SEND')),
 evidence jsonb not null default '{}',
 created_at timestamptz not null default now()
);
create unique index pa_reply_operation_once_v1 on public.pa_reply_operation_events_v1(operation_id) where state='SENDING';
create index pa_reply_operation_event_lookup_v1 on public.pa_reply_operation_events_v1(operation_id,seq desc);
alter table public.pa_reply_operations_v1 enable row level security;
alter table public.pa_reply_operation_events_v1 enable row level security;
revoke all on public.pa_reply_operations_v1,public.pa_reply_operation_events_v1 from public,anon,authenticated,service_role;
revoke all on sequence public.pa_reply_operation_events_v1_seq_seq from public,anon,authenticated,service_role;

create function public.pa_reply_operation_v1(p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.pa_reply_operations_v1; e public.pa_reply_operation_events_v1;
 v_case uuid; v_id uuid; v_binding jsonb; v_hash text; v_state text; v_claimed boolean:=false;
begin
 if p_actor is null or not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or p_action not in ('prepare','get','claim','failed','unknown','sent','history') then raise exception 'invalid_reply_operation'; end if;
 v_case:=(p_payload->>'inquiry_id')::uuid;
 if v_case is null or not exists(select 1 from public.pa_inquiries where id=v_case and deleted_at is null) then raise exception 'inquiry_not_found'; end if;
 v_id:=(p_payload->>'operation_id')::uuid;
 if p_action='prepare' then
  v_binding:=p_payload->'binding';v_hash:=p_payload->>'binding_hash';
  if v_id is null or jsonb_typeof(v_binding)<>'object' or v_hash !~ '^[a-f0-9]{64}$'
   or v_binding->>'inquiry_id'<>v_case::text or v_binding->>'account'<>'aratechsound@gmail.com'
   or coalesce(v_binding->>'thread_id','') !~ '^[A-Za-z0-9_-]{1,200}$'
   or coalesce(v_binding->>'source_id','') !~ '^[A-Za-z0-9_-]{1,200}$'
   or not exists(select 1 from public.pa_gmail_thread_links where inquiry_id=v_case and gmail_thread_id=v_binding->>'thread_id')
   or not exists(select 1 from public.pa_gmail_message_index where inquiry_id=v_case and gmail_thread_id=v_binding->>'thread_id' and gmail_message_id=v_binding->>'source_id') then raise exception 'reply_operation_mismatch'; end if;
  -- serialize preparing identical content in separate HTTP requests/sessions.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor::text||v_case::text||v_hash,46));
  select * into o from public.pa_reply_operations_v1 where actor_id=p_actor and inquiry_id=v_case and binding_hash=v_hash order by created_at desc,operation_id desc limit 1 for update;
  if found then
   select * into e from public.pa_reply_operation_events_v1 where operation_id=o.operation_id order by seq desc limit 1;
   if o.binding<>v_binding then raise exception 'reply_operation_mismatch'; end if;
   -- UNKNOWN/SENDING never become retryable, including across days and restarts.
   if e.state in ('SENDING','UNKNOWN') or (e.state='PREPARED' and o.expires_at>now())
    or (e.state='SENT' and not ((p_payload->>'new_operation')::boolean is true and p_payload->>'previous_operation_id'=o.operation_id::text)
       and (o.created_at at time zone 'Asia/Tokyo')::date=(now() at time zone 'Asia/Tokyo')::date) then
    null;
   else o.operation_id:=null;end if;
  end if;
  if o.operation_id is null then
   insert into public.pa_reply_operations_v1(operation_id,inquiry_id,actor_id,account,binding,binding_hash,rfc_message_id)
    values(v_id,v_case,p_actor,'aratechsound@gmail.com',v_binding,v_hash,'<pa-reply-'||v_id||'@ara-tech.cc>') returning * into o;
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'PREPARED') returning * into e;
  end if;
 else
  if v_id is null and p_action='get' then
   -- An unresolved older operation must not disappear behind a later reply.
   select ro.* into o from public.pa_reply_operations_v1 ro
    left join lateral (select ev.state from public.pa_reply_operation_events_v1 ev where ev.operation_id=ro.operation_id order by ev.seq desc limit 1) last_event on true
    where ro.actor_id=p_actor and ro.inquiry_id=v_case
    and ro.binding->>'source_id'=p_payload->>'source_id' and ro.binding->>'thread_id'=p_payload->>'thread_id'
    order by (last_event.state in ('UNKNOWN','SENDING')) desc,ro.created_at desc,ro.operation_id desc limit 1;
   if not found then return jsonb_build_object('ok',true,'operation',null);end if;
  else
   select * into o from public.pa_reply_operations_v1 where operation_id=v_id and actor_id=p_actor and inquiry_id=v_case and account='aratechsound@gmail.com' for update;
   if not found then raise exception 'reply_operation_mismatch';end if;
  end if;
  select * into e from public.pa_reply_operation_events_v1 where operation_id=o.operation_id order by seq desc limit 1;
  -- Revalidate attribution in the same transaction as claim/evidence commit;
  -- a prepared token cannot authorize a source that was subsequently moved.
  if ((p_action='claim' and e.state='PREPARED') or (p_action='sent' and e.state in ('SENDING','UNKNOWN')))
   and (not exists(select 1 from public.pa_gmail_thread_links where inquiry_id=v_case and gmail_thread_id=o.binding->>'thread_id')
     or not exists(select 1 from public.pa_gmail_message_index where inquiry_id=v_case and gmail_thread_id=o.binding->>'thread_id' and gmail_message_id=o.binding->>'source_id')) then raise exception 'reply_operation_mismatch';end if;
  if p_action='claim' and e.state='PREPARED' and o.expires_at>now() then
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'SENDING') returning * into e;v_claimed:=true;
  elsif p_action='failed' and e.state='PREPARED' then
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'FAILED_BEFORE_SEND') returning * into e;
  elsif p_action='unknown' and e.state in ('SENDING','UNKNOWN') then
   insert into public.pa_reply_operation_events_v1(operation_id,state) values(o.operation_id,'UNKNOWN') returning * into e;
  elsif p_action='sent' and e.state in ('SENDING','UNKNOWN') then
   if coalesce(p_payload->>'gmail_message_id','') !~ '^[A-Za-z0-9_-]{1,200}$' or p_payload->>'gmail_thread_id'<>o.binding->>'thread_id' then raise exception 'reply_operation_mismatch';end if;
   insert into public.pa_reply_operation_events_v1(operation_id,state,evidence) values(o.operation_id,'SENT',jsonb_build_object('gmail_message_id',p_payload->>'gmail_message_id','history_sync','INCOMPLETE')) returning * into e;
  elsif p_action='history' and e.state='SENT' then
   insert into public.pa_reply_operation_events_v1(operation_id,state,evidence) values(o.operation_id,'SENT',e.evidence||jsonb_build_object('history_sync',case when p_payload->>'complete'='true' then 'COMPLETE' else 'INCOMPLETE' end)) returning * into e;
  elsif p_action<>'get' and p_action not in ('claim','failed','unknown') then raise exception 'reply_operation_conflict';end if;
 end if;
 v_state:=e.state;
 if v_state='SENDING' and e.created_at<now()-interval '5 minutes' then v_state:='UNKNOWN';end if;
 return jsonb_build_object('ok',true,'claimed',v_claimed,'operation',jsonb_build_object('operation_id',o.operation_id,'inquiry_id',o.inquiry_id,'binding',o.binding,'binding_hash',o.binding_hash,'state',v_state,'gmail_message_id',e.evidence->>'gmail_message_id','history_sync',e.evidence->>'history_sync','created_at',o.created_at,'expires_at',o.expires_at));
end;
$$;
revoke all on function public.pa_reply_operation_v1(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.pa_reply_operation_v1(uuid,text,jsonb) to service_role;
commit;

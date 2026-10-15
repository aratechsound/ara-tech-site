-- Additive PAUI-041 storage. Existing links/index rows are never updated.
begin;
create table public.paui041_mail_sync_state (
 mailbox text not null default 'aratechsound@gmail.com' check(mailbox='aratechsound@gmail.com'),
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 version bigint not null default 0, state jsonb not null default '{}'::jsonb,
 primary key(mailbox,inquiry_id), check(jsonb_typeof(state)='object')
);
create table public.paui041_mail_outcomes (
 mailbox text not null default 'aratechsound@gmail.com' check(mailbox='aratechsound@gmail.com'),
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 gmail_message_id text not null check(gmail_message_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 gmail_thread_id text not null check(gmail_thread_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 status text not null check(status in ('INDEXED','RELATED_CANDIDATE','EXCLUDED_WITH_REASON','RETRIEVAL_ERROR')),
 reason text not null check(length(reason)<=120), subject text not null default '' check(length(subject)<=500),
 direction text check(direction in ('inbound','outbound')), occurred_at timestamptz,
 candidate_case_ids jsonb not null default '[]'::jsonb, fingerprint text,
 observed_at timestamptz not null default now(), actor_id uuid references auth.users(id),
 primary key(mailbox,inquiry_id,gmail_message_id)
);
alter table public.paui041_mail_sync_state enable row level security;
alter table public.paui041_mail_outcomes enable row level security;
create policy "PAUI041 admin read sync" on public.paui041_mail_sync_state for select to authenticated using(public.is_work_admin());
create policy "PAUI041 admin read outcomes" on public.paui041_mail_outcomes for select to authenticated using(public.is_work_admin());
revoke all on public.paui041_mail_sync_state,public.paui041_mail_outcomes from public,anon,authenticated;
grant select on public.paui041_mail_sync_state,public.paui041_mail_outcomes to authenticated;
grant all on public.paui041_mail_sync_state,public.paui041_mail_outcomes to service_role;

-- Both observations and commit use this exact complete authority snapshot.
create function public.paui041_authority() returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object(
 'cases',coalesce((select jsonb_agg(jsonb_build_object('id',id,'email',email,'event_name',event_name,'case_subject',case_subject,'public_event_name',public_event_name,'inquiry_number',inquiry_number,'event_date',event_date,'received_at',received_at,'deleted_at',deleted_at) order by id) from pa_inquiries),'[]'::jsonb),
 'messages',coalesce((select jsonb_agg(jsonb_build_object('gmail_message_id',gmail_message_id,'gmail_thread_id',gmail_thread_id,'inquiry_id',inquiry_id,'from_address',from_address,'to_addresses',to_addresses,'cc_addresses',cc_addresses) order by gmail_message_id) from pa_gmail_message_index),'[]'::jsonb),
 'links',coalesce((select jsonb_agg(jsonb_build_object('gmail_thread_id',gmail_thread_id,'inquiry_id',inquiry_id,'conversation_role',conversation_role) order by gmail_thread_id) from pa_gmail_thread_links),'[]'::jsonb));
$$;
create function public.paui041_context(p_case uuid,p_actor uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if not exists(select 1 from pa_inquiries where id=p_case and deleted_at is null) then raise exception 'inquiry_not_found'; end if;
 return jsonb_build_object('authority',paui041_authority(),'state',coalesce((select state||jsonb_build_object('version',version) from paui041_mail_sync_state where inquiry_id=p_case),'{}'::jsonb));
end; $$;

create function public.paui041_commit(p_case uuid,p_actor uuid,p_version bigint,p_authority jsonb,p_state jsonb,p_rows jsonb,p_owner boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.paui041_mail_sync_state%rowtype; r jsonb; m jsonb; linked uuid; existing public.pa_gmail_message_index%rowtype; next_state jsonb; pending bigint; fetched bigint;
begin
 if not exists(select 1 from work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if not exists(select 1 from pa_inquiries where id=p_case and deleted_at is null) then raise exception 'inquiry_not_found'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000 then raise exception 'mail_page_conflict'; end if;
 -- Serializes this path and prevents an existing writer changing attribution
 -- between fresh observation and commit. Existing global unique constraints stay.
 perform pg_advisory_xact_lock(hashtextextended('paui041:aratechsound@gmail.com',0));
 lock table pa_inquiries,pa_gmail_message_index,pa_gmail_thread_links in share row exclusive mode;
 select * into s from paui041_mail_sync_state where inquiry_id=p_case for update;
 if coalesce(s.version,0)<>p_version or paui041_authority()<>p_authority then raise exception 'mail_page_conflict'; end if;
 if p_owner and exists(select 1 from jsonb_array_elements(p_rows) x where not exists(select 1 from paui041_mail_outcomes o where o.inquiry_id=p_case and o.gmail_thread_id=x->>'gmail_thread_id' and o.status='RELATED_CANDIDATE' and o.fingerprint=x->>'fingerprint')) then raise exception 'mail_link_conflict'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if r->>'status' not in ('INDEXED','RELATED_CANDIDATE','EXCLUDED_WITH_REASON','RETRIEVAL_ERROR') then raise exception 'mail_page_conflict'; end if;
  if not p_owner and exists(select 1 from paui041_mail_outcomes where inquiry_id=p_case and gmail_thread_id=r->>'gmail_thread_id' and reason='owner_excluded') then r=(r-'index')||jsonb_build_object('status','EXCLUDED_WITH_REASON','reason','owner_excluded'); end if;
  if r->>'status'='INDEXED' then
   m=r->'index';
   if m->>'inquiry_id'<>p_case::text or m->>'gmail_message_id'<>r->>'gmail_message_id' or m->>'gmail_thread_id'<>r->>'gmail_thread_id' then raise exception 'mail_link_conflict'; end if;
   select inquiry_id into linked from pa_gmail_thread_links where gmail_thread_id=r->>'gmail_thread_id';
   if linked is not null and linked<>p_case then raise exception 'mail_link_conflict'; end if;
   insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role,linked_by)
    values(p_case,r->>'gmail_thread_id',case when p_owner then 'manual' else 'case_reference' end,'secondary_conversation',p_actor) on conflict(gmail_thread_id) do nothing;
   select * into existing from pa_gmail_message_index where gmail_message_id=r->>'gmail_message_id';
   if found and (existing.inquiry_id<>p_case or existing.gmail_thread_id<>r->>'gmail_thread_id') then raise exception 'mail_link_conflict'; end if;
   insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,message_source,from_address,to_addresses,cc_addresses,subject,sent_at,received_at,attachment_metadata)
    values(m->>'gmail_message_id',m->>'gmail_thread_id',p_case,m->>'direction',m->>'message_source',m->>'from_address',m->'to_addresses',m->'cc_addresses',m->>'subject',(m->>'sent_at')::timestamptz,(m->>'received_at')::timestamptz,m->'attachment_metadata') on conflict(gmail_message_id) do nothing;
  end if;
  insert into paui041_mail_outcomes(inquiry_id,gmail_message_id,gmail_thread_id,status,reason,subject,direction,occurred_at,candidate_case_ids,fingerprint,actor_id)
   values(p_case,r->>'gmail_message_id',r->>'gmail_thread_id',r->>'status',r->>'reason',coalesce(r->>'subject',''),r->>'direction',(r->>'occurred_at')::timestamptz,coalesce(r->'candidate_case_ids','[]'::jsonb),r->>'fingerprint',p_actor)
   on conflict(mailbox,inquiry_id,gmail_message_id) do update set status=excluded.status,reason=excluded.reason,subject=excluded.subject,direction=excluded.direction,occurred_at=excluded.occurred_at,candidate_case_ids=excluded.candidate_case_ids,fingerprint=excluded.fingerprint,observed_at=now(),actor_id=p_actor;
 end loop;
 next_state=coalesce(p_state,s.state,'{}'::jsonb);
 if p_state is not null then
  next_state=next_state||jsonb_build_object('last_completed_at',case when (p_state->>'complete')::boolean then p_state->>'window_end' else s.state->>'last_completed_at' end,'last_full_at',case when (p_state->>'complete')::boolean and (p_state->>'full')::boolean then p_state->>'window_end' else s.state->>'last_full_at' end,'retrieved_this_page',jsonb_array_length(p_rows),'unretrieved',case when (p_state->>'complete')::boolean then '0' else 'UNKNOWN' end);
 end if;
 insert into paui041_mail_sync_state(inquiry_id,version,state) values(p_case,p_version+1,next_state) on conflict(mailbox,inquiry_id) do update set version=p_version+1,state=next_state;
 select count(*) into pending from paui041_mail_outcomes where inquiry_id=p_case and status='RELATED_CANDIDATE';
 select count(*) into fetched from paui041_mail_outcomes where inquiry_id=p_case;
 return next_state||jsonb_build_object('version',p_version+1,'pending_messages',pending,'classified_messages',fetched,'has_more',not coalesce((next_state->>'complete')::boolean,false));
end; $$;
revoke all on function public.paui041_authority(),public.paui041_context(uuid,uuid),public.paui041_commit(uuid,uuid,bigint,jsonb,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.paui041_authority(),public.paui041_context(uuid,uuid),public.paui041_commit(uuid,uuid,bigint,jsonb,jsonb,jsonb,boolean) to service_role;
commit;

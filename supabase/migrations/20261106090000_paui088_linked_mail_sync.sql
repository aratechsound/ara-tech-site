-- Existing linked-thread sync telemetry is distinct from PAUI-041 discovery coverage.
-- The production table predates main's legacy sync path; support clean replay too.
create table if not exists public.paui041_mail_sync_state (
 mailbox text not null default 'aratechsound@gmail.com' check(mailbox='aratechsound@gmail.com'),
 inquiry_id uuid not null references public.pa_inquiries(id),
 version bigint not null default 0,
 state jsonb not null default '{}'::jsonb,
 primary key(mailbox,inquiry_id)
);
alter table public.paui041_mail_sync_state enable row level security;
revoke all on public.paui041_mail_sync_state from public,anon;
grant all on public.paui041_mail_sync_state to service_role;

-- Called only by the existing authenticated admin backend. No caller-supplied
-- timestamp, discovery completion claim, attention override or business state.
create or replace function public.paui041_record_linked_sync(p_case uuid,p_actor uuid,p_threads jsonb,p_messages jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare observed jsonb;
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if not exists(select 1 from public.pa_inquiries where id=p_case and deleted_at is null) then raise exception 'inquiry_not_found'; end if;
 if jsonb_typeof(p_threads) is distinct from 'array' or jsonb_array_length(p_threads)>100
 or jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages)>5000 then raise exception 'mail_page_conflict'; end if;
 perform pg_advisory_xact_lock(hashtextextended('paui041:aratechsound@gmail.com',0));
 if exists(select 1 from jsonb_array_elements_text(p_threads) t where not exists(
  select 1 from public.pa_gmail_thread_links l where l.inquiry_id=p_case and l.gmail_thread_id=t))
 or exists(select 1 from public.pa_gmail_thread_links l where l.inquiry_id=p_case and not p_threads ? l.gmail_thread_id)
 or exists(select 1 from jsonb_array_elements_text(p_messages) m where not exists(
  select 1 from public.pa_gmail_message_index i where i.inquiry_id=p_case and i.gmail_message_id=m and p_threads ? i.gmail_thread_id)) then raise exception 'mail_link_conflict'; end if;
 observed=jsonb_build_object('checked_at',clock_timestamp(),'thread_ids',p_threads,'message_count',jsonb_array_length(p_messages),'scope','existing_linked_threads','complete',true);
 insert into public.paui041_mail_sync_state(inquiry_id,version,state) values(p_case,1,jsonb_build_object('linked_sync',observed))
 on conflict(mailbox,inquiry_id) do update set version=paui041_mail_sync_state.version+1,state=paui041_mail_sync_state.state||jsonb_build_object('linked_sync',observed);
end $$;
revoke all on function public.paui041_record_linked_sync(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.paui041_record_linked_sync(uuid,uuid,jsonb,jsonb) to service_role;

-- A link appearing between provider lookup and commit must fail the page rather
-- than silently discard a newly linked message while advancing the cursor.
do $$
declare definition text;
begin
 select pg_get_functiondef('public.ara_commit_mail_page_v2(uuid,timestamptz,timestamptz,bigint,text,jsonb)'::regprocedure) into definition;
 if position('then continue; end if;' in definition)=0 and position('then raise exception ''mail_link_conflict''; end if;' in definition)=0 then raise exception 'unexpected_mail_page_definition'; end if;
 definition=replace(definition,'then continue; end if;','then raise exception ''mail_link_conflict''; end if;');
 execute definition;
end $$;

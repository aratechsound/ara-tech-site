-- ARA-CASE-001R1: single existing root; metadata and bounded, mailbox-fixed inbox.
begin;
alter table public.pa_inquiries add column case_type text
 check (case_type in ('PA_EVENT','AUDIO_INSTALL','AV_INSTALL','LIGHTING_INSTALL','VIDEO_INSTALL','EQUIPMENT_RENTAL','OTHER')),
 add column case_subject text check (char_length(case_subject)<=500),
 add column desired_period text check (char_length(desired_period)<=500),
 add column next_action text check (char_length(next_action)<=5000);
-- Only the exact captured PA public-form provenance is backfilled. Unknown stays NULL.
set local app.pa_case_delete_mode='case_type_backfill';
update public.pa_inquiries set case_type='PA_EVENT'
 where submission_source='public_form' and submission_key is not null
 and first_form_data->>'form_source' in ('direct','contact','pa-rental','stage-production')
 and first_form_data->>'confirmation_consent'='true'
 and first_form_data ? 'requested_services' and first_form_data ? 'event_overview';
set local app.pa_case_delete_mode='';
create function public.ara_mark_pa_form() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.case_type is null and new.submission_source='public_form' and new.submission_key is not null
 and new.first_form_data->>'form_source' in ('direct','contact','pa-rental','stage-production')
 and new.first_form_data->>'confirmation_consent'='true'
 and new.first_form_data ? 'requested_services' and new.first_form_data ? 'event_overview' then new.case_type:='PA_EVENT'; end if;
 return new;
end $$;
create trigger ara_case_pa_provenance before insert on public.pa_inquiries for each row execute function public.ara_mark_pa_form();
-- Keep the original PA trigger implementation intact, with a non-PA condition.
drop trigger pa_inquiries_sync_case_progress on public.pa_inquiries;
create trigger pa_inquiries_sync_case_progress after insert or update of status,schedule_state on public.pa_inquiries
 for each row when (new.case_type is null or new.case_type='PA_EVENT') execute function public.sync_pa_case_progress_from_inquiry();
create table public.ara_unlinked_mail (
 mailbox text not null default 'aratechsound@gmail.com' check (mailbox='aratechsound@gmail.com'),
 gmail_message_id text primary key check (gmail_message_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 gmail_thread_id text not null check (gmail_thread_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 from_address text not null check(char_length(from_address) between 1 and 320),
 subject text not null check(char_length(subject)<=500), snippet text not null check(char_length(snippet)<=500),
 received_at timestamptz not null, has_attachments boolean not null default false,
 decision text not null default 'pending' check(decision in ('pending','linked','excluded')),
 inquiry_id uuid references public.pa_inquiries(id), decided_by uuid references auth.users(id),
 decided_at timestamptz, indexed_at timestamptz not null default now(),
 check((decision='linked')=(inquiry_id is not null))
);
create table public.ara_mail_sync_state (
 mailbox text primary key default 'aratechsound@gmail.com' check(mailbox='aratechsound@gmail.com'),
 window_start timestamptz not null, window_end timestamptz not null,
 page_token text not null default '' check(char_length(page_token)<=2000),
 last_success_at timestamptz not null default now()
);
alter table public.ara_unlinked_mail enable row level security;
alter table public.ara_mail_sync_state enable row level security;
create policy "ARA admins read unlinked mail" on public.ara_unlinked_mail for select to authenticated using(public.is_work_admin());
create policy "ARA admins read sync state" on public.ara_mail_sync_state for select to authenticated using(public.is_work_admin());
revoke all on public.ara_unlinked_mail,public.ara_mail_sync_state from public,anon,authenticated;
grant select on public.ara_unlinked_mail,public.ara_mail_sync_state to authenticated;
grant all on public.ara_unlinked_mail,public.ara_mail_sync_state to service_role;
create function public.ara_commit_mail_page(p_actor uuid,p_start timestamptz,p_end timestamptz,p_expected_page text,p_next_page text,p_rows jsonb)
 returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.ara_mail_sync_state%rowtype; r jsonb;
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>50 or p_end<=p_start or p_end-p_start>interval '31 days'
 or char_length(p_expected_page)>2000 or char_length(p_next_page)>2000 then raise exception 'invalid_mail_page'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ara-mailbox:aratechsound@gmail.com',0));
 select * into s from public.ara_mail_sync_state;
 if found and (s.page_token<>p_expected_page or s.window_start<>p_start or s.window_end<>p_end) then raise exception 'mail_page_conflict'; end if;
 if not found and p_expected_page<>'' then raise exception 'mail_page_conflict'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if exists(select 1 from public.pa_gmail_thread_links where gmail_thread_id=r->>'gmail_thread_id') then continue; end if;
  insert into public.ara_unlinked_mail(gmail_message_id,gmail_thread_id,from_address,subject,snippet,received_at,has_attachments)
  values(r->>'gmail_message_id',r->>'gmail_thread_id',r->>'from_address',r->>'subject',r->>'snippet',(r->>'received_at')::timestamptz,(r->>'has_attachments')::boolean)
  on conflict(gmail_message_id) do update set indexed_at=now();
 end loop;
 insert into public.ara_mail_sync_state(window_start,window_end,page_token) values(
 case when p_next_page='' then p_end-interval '1 minute' else p_start end,
 case when p_next_page='' then greatest(clock_timestamp(),p_end+interval '1 second') else p_end end,p_next_page)
 on conflict(mailbox) do update set window_start=excluded.window_start,window_end=excluded.window_end,page_token=excluded.page_token,last_success_at=now();
end $$;
create function public.ara_decide_mail(p_actor uuid,p_message text,p_action text,p_case uuid,p_customer text,p_email text,p_type text,p_content text)
 returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare m public.ara_unlinked_mail%rowtype; c uuid; linked uuid; role text;
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if p_action not in ('create','link','exclude') or p_action is null then raise exception 'invalid_mail_decision'; end if;
 select * into m from public.ara_unlinked_mail where gmail_message_id=p_message;
 if not found then raise exception 'mail_candidate_not_found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ara-thread:'||m.gmail_thread_id,0));
 select * into m from public.ara_unlinked_mail where gmail_message_id=p_message for update;
 select inquiry_id into linked from public.pa_gmail_thread_links where gmail_thread_id=m.gmail_thread_id;
 if linked is not null then
  if p_action='link' and p_case<>linked then raise exception 'mail_link_conflict'; end if;
  if p_action='exclude' then raise exception 'mail_link_conflict'; end if;
  update public.ara_unlinked_mail set decision='linked',inquiry_id=linked,decided_by=p_actor,decided_at=now() where gmail_message_id=p_message;
  return jsonb_build_object('inquiry_id',linked,'duplicate',true);
 end if;
 if m.decision='excluded' then
  if p_action<>'exclude' then raise exception 'mail_decision_conflict'; end if;
  return jsonb_build_object('excluded',true,'duplicate',true);
 end if;
 if p_action='exclude' then
  update public.ara_unlinked_mail set decision='excluded',decided_by=p_actor,decided_at=now() where gmail_message_id=p_message;
  return jsonb_build_object('excluded',true);
 end if;
 if p_action='create' then
  if p_type is null or p_type not in ('PA_EVENT','AUDIO_INSTALL','AV_INSTALL','LIGHTING_INSTALL','VIDEO_INSTALL','EQUIPMENT_RENTAL','OTHER')
   or p_customer is null or char_length(p_customer) not between 1 and 160 or p_email is null
   or p_content is null or char_length(p_content)>20000 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid_mail_decision'; end if;
  insert into public.pa_inquiries(created_by,submission_source,status,customer_name,contact_name,email,case_type,case_subject,request_summary,first_form_data)
  values(p_actor,'manual','new_inquiry',p_customer,p_customer,p_email,p_type,m.subject,p_content,
   jsonb_build_object('import_source','gmail_owner_confirmed','gmail_message_id',m.gmail_message_id,'gmail_thread_id',m.gmail_thread_id,'original_snippet',m.snippet,'original_body',p_content)) returning id into c;
 else
  select id into c from public.pa_inquiries where id=p_case and deleted_at is null for update;
  if c is null then raise exception 'inquiry_not_found'; end if;
 end if;
 role:=case when exists(select 1 from public.pa_gmail_thread_links where inquiry_id=c and conversation_role='primary_conversation') then 'secondary_conversation' else 'primary_conversation' end;
 insert into public.pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role,linked_by) values(c,m.gmail_thread_id,'manual',role,p_actor);
 update public.ara_unlinked_mail set decision='linked',inquiry_id=c,decided_by=p_actor,decided_at=now() where gmail_thread_id=m.gmail_thread_id and decision='pending';
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(c,p_actor,'gmail_owner_linked',jsonb_build_object('gmail_thread_id',m.gmail_thread_id,'gmail_message_id',m.gmail_message_id));
 return jsonb_build_object('inquiry_id',c,'duplicate',false);
end $$;
revoke all on function public.ara_commit_mail_page(uuid,timestamptz,timestamptz,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.ara_decide_mail(uuid,text,text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ara_commit_mail_page(uuid,timestamptz,timestamptz,text,text,jsonb) to service_role;
grant execute on function public.ara_decide_mail(uuid,text,text,uuid,text,text,text,text) to service_role;
-- Reject PA progress/commercial writes for explicit non-PA roots, including direct RPCs.
create function public.ara_require_pa_child() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare c uuid; t text;
begin
 c:=coalesce((to_jsonb(new)->>'inquiry_id')::uuid,(to_jsonb(new)->>'case_id')::uuid);
 select case_type into t from public.pa_inquiries where id=c;
 if t is not null and t<>'PA_EVENT' then raise exception 'pa_only_operation'; end if;
 return new;
end $$;
do $$ declare tab text; begin
 foreach tab in array array['pa_case_progress','pa_payment_records','pa_contract_offers','pa_case_commercial_state','pa_estimate_revisions','pa_commercial_outbox','pa_commercial_documents','pa_portals','pa_stage_plots','pa_stage_plot_revisions'] loop
  if to_regclass('public.'||tab) is not null then
   execute format('create trigger ara_pa_child_guard before insert or update on public.%I for each row execute function public.ara_require_pa_child()',tab);
  end if;
 end loop;
end $$;
commit;

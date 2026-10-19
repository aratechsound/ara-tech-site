-- PAUI-066 proposed release SQL. DO NOT APPLY TO PRODUCTION before Owner approval.
-- Source baseline: ca98c415de508cc0914e0e2fcb2000cbda30f970
-- Existing function signatures/security definer and grants preserved.
-- Prerequisite: compare live pg_get_functiondef in Production; abort if drift.
-- This is a FAIL-CLOSED BRIDGE. It does NOT implement per-message adoption;
-- that requires separate read-model/routing migration and Owner acceptance.
-- No retrospective corrections, historic message reassignments or backfills.
-- Functions are redefined within a transaction: an independent DB migration
-- gate must be run in disposable PostgreSQL before this can be considered.
begin;
create or replace function public.ara_commit_mail_page_v2(p_actor uuid,p_start timestamptz,p_end timestamptz,p_version bigint,p_next_page text,p_rows jsonb) returns void
 language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.ara_mail_sync_state%rowtype; r jsonb;
begin
 if not exists(select 1 from work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>50 or p_start is null or p_end is null or p_end<=p_start or p_end-p_start>interval '30 days' or p_next_page is null or length(p_next_page)>2000 then raise exception 'invalid_mail_page'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ara-mailbox:aratechsound@gmail.com',0));
 select * into s from ara_mail_sync_state;
 if (found and s.cursor_version<>p_version) or (not found and p_version<>0) then raise exception 'mail_page_conflict'; end if;
 if s.page_token<>'' and (s.window_start<>p_start or s.window_end<>p_end) then raise exception 'mail_page_conflict'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if exists(select 1 from pa_gmail_thread_links where gmail_thread_id=r->>'gmail_thread_id')
    and coalesce(r->>'subject','') !~* 'new[[:space:]]+submission[[:space:]]+from[[:space:]]+ara[-[:space:]]*tech' then continue; end if;
  insert into ara_unlinked_mail(gmail_message_id,gmail_thread_id,from_address,subject,snippet,received_at,has_attachments)
  values(r->>'gmail_message_id',r->>'gmail_thread_id',r->>'from_address',r->>'subject',r->>'snippet',(r->>'received_at')::timestamptz,(r->>'has_attachments')::boolean) on conflict(gmail_message_id) do nothing;
 end loop;
 insert into ara_mail_sync_state(window_start,window_end,page_token,covered_until,cursor_version) values(p_start,p_end,p_next_page,case when p_next_page='' then p_end else coalesce(s.covered_until,p_start) end,p_version+1)
 on conflict(mailbox) do update set window_start=excluded.window_start,window_end=excluded.window_end,page_token=excluded.page_token,covered_until=excluded.covered_until,cursor_version=excluded.cursor_version,last_success_at=now();
end $$;

create or replace function public.ara_list_mail(p_actor uuid,p_limit integer default 100,p_snapshot timestamptz default now(),p_before_time timestamptz default null,p_before_id text default null) returns jsonb
 language plpgsql security definer set search_path=pg_catalog,public as $$
declare a jsonb; total bigint;
begin
 if not exists(select 1 from work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if p_limit is null or p_limit not between 1 and 100 or p_snapshot is null then raise exception 'invalid_mail_cursor'; end if;
 select count(*) into total from ara_unlinked_mail m where decision='pending' and indexed_at<=p_snapshot and (not exists(select 1 from pa_gmail_thread_links l where l.gmail_thread_id=m.gmail_thread_id)
 or m.subject ~* 'new[[:space:]]+submission[[:space:]]+from[[:space:]]+ara[-[:space:]]*tech');
 select coalesce(jsonb_agg(to_jsonb(q) order by received_at desc,gmail_message_id desc),'[]') into a from (
 select m.* from ara_unlinked_mail m where decision='pending' and indexed_at<=p_snapshot and (not exists(select 1 from pa_gmail_thread_links l where l.gmail_thread_id=m.gmail_thread_id)
 or m.subject ~* 'new[[:space:]]+submission[[:space:]]+from[[:space:]]+ara[-[:space:]]*tech')
 and (p_before_time is null or (received_at,gmail_message_id)<(p_before_time,p_before_id)) order by received_at desc,gmail_message_id desc limit p_limit+1) q;
 return jsonb_build_object('candidates',a,'total',total,'snapshot',p_snapshot);
end $$;

create or replace function public.ara_decide_mail(p_actor uuid,p_message text,p_action text,p_case uuid,p_customer text,p_email text,p_type text,p_content text)
 returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare m public.ara_unlinked_mail%rowtype; c uuid; linked uuid; role text;
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if p_action not in ('create','link','exclude') or p_action is null then raise exception 'invalid_mail_decision'; end if;
 select * into m from public.ara_unlinked_mail where gmail_message_id=p_message;
 if not found then raise exception 'mail_candidate_not_found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ara-thread:'||m.gmail_thread_id,0));
 select * into m from public.ara_unlinked_mail where gmail_message_id=p_message for update;
 -- Legacy owner decisions bind a whole Gmail thread and cannot adopt
 -- independent, generic Formspree submissions safely. Deny create/link until
 -- an audited per-message identity/read model has been separately approved.
 if m.subject ~* 'new[[:space:]]+submission[[:space:]]+from[[:space:]]+ara[-[:space:]]*tech' and p_action in ('create','link') then
  raise exception 'mail_identity_review_required';
 end if;
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
 update public.ara_unlinked_mail set decision='linked',inquiry_id=c,decided_by=p_actor,decided_at=now() where gmail_message_id=m.gmail_message_id and decision='pending';
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(c,p_actor,'gmail_owner_linked',jsonb_build_object('gmail_thread_id',m.gmail_thread_id,'gmail_message_id',m.gmail_message_id));
 return jsonb_build_object('inquiry_id',c,'duplicate',false);
end $$;

create or replace function public.paui041_commit(p_case uuid,p_actor uuid,p_version bigint,p_authority jsonb,p_state jsonb,p_rows jsonb,p_owner boolean) returns jsonb
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
   -- A stale client must not auto-index generic third-party notifications
   -- solely because another message in this Gmail thread was approved.
   if coalesce(r->>'subject','') ~* 'new[[:space:]]+submission[[:space:]]+from[[:space:]]+ara[-[:space:]]*tech' then raise exception 'mail_identity_review_required'; end if;
   m=r->'index';
   -- Legacy clients can supply different outer and persisted inner subjects.
   -- Reject a notification even if the outer subject was falsified or absent.
   if coalesce(m->>'subject','') ~* 'new[[:space:]]+submission[[:space:]]+from[[:space:]]+ara[-[:space:]]*tech' then raise exception 'mail_identity_review_required'; end if;
   if coalesce(r->>'subject','') is distinct from coalesce(m->>'subject','') then raise exception 'mail_link_conflict'; end if;
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

-- Only service_role may execute. No global ACL widening.
revoke all on function public.ara_commit_mail_page_v2(uuid,timestamptz,timestamptz,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.ara_commit_mail_page_v2(uuid,timestamptz,timestamptz,bigint,text,jsonb) to service_role;
revoke all on function public.ara_list_mail(uuid,integer,timestamptz,timestamptz,text) from public,anon,authenticated;
grant execute on function public.ara_list_mail(uuid,integer,timestamptz,timestamptz,text) to service_role;
revoke all on function public.ara_decide_mail(uuid,text,text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ara_decide_mail(uuid,text,text,uuid,text,text,text,text) to service_role;
revoke all on function public.paui041_commit(uuid,uuid,bigint,jsonb,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.paui041_commit(uuid,uuid,bigint,jsonb,jsonb,jsonb,boolean) to service_role;
commit;

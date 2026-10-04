begin;
alter table public.pa_inquiries add column intake_fingerprint text check(intake_fingerprint ~ '^[a-f0-9]{64}$');
-- Existing PA evidence: provenance, actual non-empty workflow, or commercial records.
create function public.ara_has_pa_evidence(p_id uuid) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from pa_inquiries i where i.id=p_id and (
 (i.submission_source='public_form' and i.first_form_data ? 'requested_services' and i.first_form_data ? 'event_overview')
 or exists(select 1 from pa_contract_offers o where o.inquiry_id=i.id)
 or exists(select 1 from pa_estimate_revisions e where e.inquiry_id=i.id)
 or exists(select 1 from pa_payment_records p where p.inquiry_id=i.id)
 or exists(select 1 from pa_stage_plots s where s.case_id=i.id)
 or exists(select 1 from pa_portal_document_cards d join pa_portals p on p.id=d.portal_id where p.case_id=i.id)
 or exists(select 1 from pa_case_progress p where p.inquiry_id=i.id and (p.estimate_created_on is not null or p.estimate_sent_on is not null or p.booking_confirmed_on is not null or p.confirmed_event_date is not null or p.event_completed_on is not null))
 or (i.submission_source='manual' and nullif(btrim(i.event_name),'') is not null and i.event_date is not null)
 ));
$$;
set local app.pa_case_delete_mode='case_type_backfill';
update public.pa_inquiries set case_type='PA_EVENT' where case_type is null and public.ara_has_pa_evidence(id);
set local app.pa_case_delete_mode='';
create function public.ara_guard_case_type() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if old.case_type='PA_EVENT' and new.case_type is distinct from old.case_type and public.ara_has_pa_evidence(old.id) then raise exception 'pa_history_preserved'; end if;
 return new;
end $$;
create trigger ara_guard_case_type before update of case_type on public.pa_inquiries for each row execute function public.ara_guard_case_type();
-- Parent resolution follows actual indirect FKs, not guessed child columns.
create or replace function public.ara_require_pa_child() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare c uuid; t text; r jsonb:=to_jsonb(new);
begin
 c:=coalesce((r->>'inquiry_id')::uuid,(r->>'case_id')::uuid);
 if c is null and tg_table_name='pa_stage_plot_revisions' then select case_id into c from public.pa_stage_plots where id=(r->>'stage_plot_id')::uuid; end if;
 if c is null and tg_table_name='pa_contract_tokens' then select inquiry_id into c from public.pa_contract_offers where id=(r->>'offer_id')::uuid; end if;
 if c is null and tg_table_name in ('pa_contract_receipts','pa_contract_deliveries') then select inquiry_id into c from public.pa_contracts where id=(r->>'contract_id')::uuid; end if;
 if c is null and r ? 'portal_id' then select case_id into c from public.pa_portals where id=(r->>'portal_id')::uuid; end if;
 if c is null and tg_table_name='pa_portal_document_versions' then select p.case_id into c from public.pa_portal_document_cards d join public.pa_portals p on p.id=d.portal_id where d.id=(r->>'card_id')::uuid; end if;
 select case_type into t from public.pa_inquiries where id=c;
 if c is not null and t is distinct from 'PA_EVENT' then raise exception 'pa_only_operation'; end if;
 return new;
end $$;
do $$ declare tab text; begin
 foreach tab in array array['pa_contract_tokens','pa_contracts','pa_contract_receipts','pa_contract_deliveries','pa_billings','pa_payment_adjustments','pa_change_orders','pa_schedule_tokens','pa_schedule_responses','pa_portal_document_cards','pa_portal_document_versions','pa_portal_photo_items','pa_portal_document_candidates'] loop
 execute format('create trigger ara_pa_child_guard before insert or update on public.%I for each row execute function public.ara_require_pa_child()',tab);
 end loop;
end $$;
-- Only automatic root progress is permitted for truly unclassified legacy rows.
drop trigger pa_inquiries_sync_case_progress on public.pa_inquiries;
create trigger pa_inquiries_sync_case_progress after insert or update of status,schedule_state on public.pa_inquiries
 for each row when(new.case_type='PA_EVENT') execute function public.sync_pa_case_progress_from_inquiry();
-- Reuse the existing acceptance notification ledger, not the PA commercial outbox.
alter table public.pa_email_deliveries drop constraint pa_email_deliveries_status_check;
alter table public.pa_email_deliveries add constraint pa_email_deliveries_status_check check(status in ('queued','sending','sent','failed','unknown'));
create function public.ara_register_general(p_key uuid,p_hash text,p_input jsonb,p_notifications jsonb) returns jsonb
 language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.pa_inquiries%rowtype; n jsonb; typ text:=p_input->>'case_type';
begin
 if p_key is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or typ is null or typ not in ('PA_EVENT','AUDIO_INSTALL','AV_INSTALL','LIGHTING_INSTALL','VIDEO_INSTALL','EQUIPMENT_RENTAL','OTHER')
 or coalesce(length(p_input->>'customer_name'),0) not between 1 and 160 or coalesce(length(p_input->>'body'),0) not between 1 and 20000
 or coalesce(p_input->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 or p_notifications is null or jsonb_typeof(p_notifications)<>'array' or jsonb_array_length(p_notifications)>2 then raise exception 'invalid_intake'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ara-intake:'||p_key::text,0));
 select * into c from pa_inquiries where submission_key=p_key;
 if found then
  if c.intake_fingerprint is distinct from p_hash then raise exception 'submission_content_conflict'; end if;
  return jsonb_build_object('id',c.id,'inquiry_number',c.inquiry_number,'received_at',c.received_at,'duplicate',true);
 end if;
 insert into pa_inquiries(submission_source,submission_key,status,case_type,customer_name,email,organization_name,phone,venue,desired_period,case_subject,request_summary,first_form_data,intake_fingerprint)
 values('public_form',p_key,'new_inquiry',typ,p_input->>'customer_name',p_input->>'email',nullif(p_input->>'organization_name',''),nullif(p_input->>'phone',''),nullif(p_input->>'venue',''),nullif(p_input->>'desired_period',''),p_input->>'subject',p_input->>'body',p_input||jsonb_build_object('import_source','general_public_form'),p_hash) returning * into c;
 for n in select value from jsonb_array_elements(p_notifications) loop
  if n->>'message_type' not in ('internal_new_inquiry','customer_receipt') then raise exception 'invalid_notification'; end if;
  insert into pa_email_deliveries(inquiry_id,message_type,dedupe_key,recipient,subject,body,status)
  values(c.id,n->>'message_type','ara-intake:'||p_key::text||':'||(n->>'message_type'),n->>'recipient',replace(n->>'subject','{number}',c.inquiry_number),replace(n->>'body','{number}',c.inquiry_number),'queued');
 end loop;
 return jsonb_build_object('id',c.id,'inquiry_number',c.inquiry_number,'received_at',c.received_at,'duplicate',false);
end $$;
create function public.ara_claim_intake_delivery(p_id uuid) returns setof public.pa_email_deliveries language sql security definer set search_path=pg_catalog,public as $$
 update pa_email_deliveries set status='sending' where id=p_id and status='queued' returning *;
$$;
alter table public.ara_mail_sync_state add column covered_until timestamptz, add column cursor_version bigint not null default 0;
update public.ara_mail_sync_state set covered_until=case when page_token='' then window_start+interval '1 minute' else window_start end;
create function public.ara_commit_mail_page_v2(p_actor uuid,p_start timestamptz,p_end timestamptz,p_version bigint,p_next_page text,p_rows jsonb) returns void
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
  if exists(select 1 from pa_gmail_thread_links where gmail_thread_id=r->>'gmail_thread_id') then continue; end if;
  insert into ara_unlinked_mail(gmail_message_id,gmail_thread_id,from_address,subject,snippet,received_at,has_attachments)
  values(r->>'gmail_message_id',r->>'gmail_thread_id',r->>'from_address',r->>'subject',r->>'snippet',(r->>'received_at')::timestamptz,(r->>'has_attachments')::boolean) on conflict(gmail_message_id) do nothing;
 end loop;
 insert into ara_mail_sync_state(window_start,window_end,page_token,covered_until,cursor_version) values(p_start,p_end,p_next_page,case when p_next_page='' then p_end else coalesce(s.covered_until,p_start) end,p_version+1)
 on conflict(mailbox) do update set window_start=excluded.window_start,window_end=excluded.window_end,page_token=excluded.page_token,covered_until=excluded.covered_until,cursor_version=excluded.cursor_version,last_success_at=now();
end $$;
create function public.ara_list_mail(p_actor uuid,p_limit integer default 100,p_snapshot timestamptz default now(),p_before_time timestamptz default null,p_before_id text default null) returns jsonb
 language plpgsql security definer set search_path=pg_catalog,public as $$
declare a jsonb; total bigint;
begin
 if not exists(select 1 from work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 if p_limit is null or p_limit not between 1 and 100 or p_snapshot is null then raise exception 'invalid_mail_cursor'; end if;
 select count(*) into total from ara_unlinked_mail m where decision='pending' and indexed_at<=p_snapshot and not exists(select 1 from pa_gmail_thread_links l where l.gmail_thread_id=m.gmail_thread_id);
 select coalesce(jsonb_agg(to_jsonb(q) order by received_at desc,gmail_message_id desc),'[]') into a from (
 select m.* from ara_unlinked_mail m where decision='pending' and indexed_at<=p_snapshot and not exists(select 1 from pa_gmail_thread_links l where l.gmail_thread_id=m.gmail_thread_id)
 and (p_before_time is null or (received_at,gmail_message_id)<(p_before_time,p_before_id)) order by received_at desc,gmail_message_id desc limit p_limit+1) q;
 return jsonb_build_object('candidates',a,'total',total,'snapshot',p_snapshot);
end $$;
-- Serialize legacy manualLink with decisions and archive using the root row lock.
create function public.ara_guard_thread_link() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('ara-thread:'||new.gmail_thread_id,0));
 perform 1 from pa_inquiries where id=new.inquiry_id and deleted_at is null for update;
 if not found then raise exception 'inquiry_archived'; end if;
 return new;
end $$;
create trigger ara_guard_thread_link before insert or update on pa_gmail_thread_links for each row execute function public.ara_guard_thread_link();
do $$ declare f regprocedure; begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('ara_register_general','ara_claim_intake_delivery','ara_commit_mail_page_v2','ara_list_mail','ara_has_pa_evidence') loop
 execute format('revoke all on function %s from public,anon,authenticated',f); execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
commit;

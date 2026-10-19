-- ISOLATED CANDIDATE ONLY. No Production application authorized.
begin;
create function public.ara_decide_mail(p_actor uuid,p_message text,p_action text,p_case uuid,p_customer text,p_email text,p_type text,p_content text,p_review jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare m public.ara_unlinked_mail%rowtype;c uuid;linked uuid;customer text;relay boolean;
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor)then raise exception 'not_authorized';end if;
 if p_action<>'create' or p_case is not null or p_type<>'OTHER' or p_customer is null or char_length(btrim(p_customer)) not between 1 and 160 or p_content is null or char_length(p_content)>20000 then raise exception 'invalid_mail_decision';end if;
 if p_review->>'server_verified' is distinct from 'true' or p_review->>'owner_confirmed' is distinct from 'true' or p_review->>'gmail_message_id' is distinct from p_message then raise exception 'mail_identity_review_required';end if;
 perform pg_advisory_xact_lock(hashtextextended('ara-mailbox:aratechsound@gmail.com',0));
 select * into m from public.ara_unlinked_mail where gmail_message_id=p_message for update;
 if not found or m.gmail_thread_id is distinct from p_review->>'gmail_thread_id' then raise exception 'mail_link_conflict';end if;
 customer:=lower(p_email);relay:=lower(m.from_address)~'@([^@.]+\.)?formspree\.io$';
 if customer is null or customer!~'^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+\.[^[:space:]<>@,;]+$' or customer='aratechsound@gmail.com' or customer~*'(no-?reply|notification|@([^@.]+\.)?formspree\.)'
  or customer is distinct from p_review->>'customer_email' or lower(m.from_address) is distinct from lower(p_review->>'from_address') or m.subject is distinct from p_review->>'subject'
  or coalesce(p_review->'to_addresses','[]'::jsonb)@>'["aratechsound@gmail.com"]'::jsonb is not true
  or p_review->>'body_sha256' is distinct from encode(sha256(convert_to(p_content,'UTF8')),'hex') or coalesce(p_review->>'fingerprint','')!~'^[a-f0-9]{64}$'
  or (relay and customer is distinct from lower(p_review->>'reply_to')) or (not relay and customer is distinct from lower(m.from_address)) then raise exception 'mail_identity_review_required';end if;
 if m.decision='linked' then
  if exists(select 1 from public.pa_gmail_message_index i join public.pa_inquiries q on q.id=i.inquiry_id where i.gmail_message_id=p_message and q.id=m.inquiry_id and lower(q.email)=customer and q.first_form_data->>'gmail_message_id'=p_message)then return jsonb_build_object('inquiry_id',m.inquiry_id,'duplicate',true,'message_only',true);end if;
  raise exception 'mail_link_conflict';
 end if;
 if m.decision<>'pending' or exists(select 1 from public.pa_gmail_message_index where gmail_message_id=p_message)then raise exception 'mail_link_conflict';end if;
 select inquiry_id into linked from public.pa_gmail_thread_links where gmail_thread_id=m.gmail_thread_id;
 -- Existing shared-thread ownership cannot be reassigned or bulk adopted.
 if linked is not null then raise exception 'mail_link_conflict';end if;
 insert into public.pa_inquiries(created_by,submission_source,status,customer_name,contact_name,email,case_type,case_subject,request_summary,received_at,first_form_data)
 values(p_actor,'manual','new_inquiry',btrim(p_customer),btrim(p_customer),customer,'OTHER',m.subject,p_content,m.received_at,
 jsonb_build_object('import_source','gmail_owner_confirmed','gmail_message_id',m.gmail_message_id,'gmail_thread_id',m.gmail_thread_id,'original_body',p_content,'identity_source',p_review->>'identity_source','identity_fingerprint',p_review->>'fingerprint','identity_confirmed_by',p_actor))returning id into c;
 insert into public.pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role,linked_by)values(c,m.gmail_thread_id,'manual','primary_conversation',p_actor);
 insert into public.pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,message_source,from_address,to_addresses,cc_addresses,subject,received_at,attachment_metadata)
 values(m.gmail_message_id,m.gmail_thread_id,c,'inbound','gmail_received',m.from_address,p_review->'to_addresses',coalesce(p_review->'cc_addresses','[]'::jsonb),m.subject,m.received_at,coalesce(p_review->'attachment_metadata','[]'::jsonb));
 update public.ara_unlinked_mail set decision='linked',inquiry_id=c,decided_by=p_actor,decided_at=now()where gmail_message_id=p_message and decision='pending';
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)values(c,p_actor,'gmail_owner_linked',jsonb_build_object('gmail_message_id',m.gmail_message_id,'gmail_thread_id',m.gmail_thread_id,'message_only',true,'identity_fingerprint',p_review->>'fingerprint'));
 return jsonb_build_object('inquiry_id',c,'duplicate',false,'message_only',true);
end $$;
revoke all on function public.ara_decide_mail(uuid,text,text,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ara_decide_mail(uuid,text,text,uuid,text,text,text,text,jsonb) to service_role;
commit;

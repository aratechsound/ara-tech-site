\set ON_ERROR_STOP on
set request.jwt.claim.sub='123e4567-e89b-42d3-a456-426614174001';

insert into public.pa_inquiries(id,created_by,submission_source,status,schedule_state,customer_name,email,event_name,event_date,event_time,venue,request_summary,internal_memo)
values
('cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3','123e4567-e89b-42d3-a456-426614174001','manual','reviewing','unconfirmed','竹林 智也','t.takebayashi515@akiota.jp','2026龍姫湖まつり','2026-10-18','10:00〜15:00','温井ダム堤体横駐車場','PA・音響・電源対応','source'),
('11111111-1111-4111-8111-111111111111','123e4567-e89b-42d3-a456-426614174001','manual','reviewing','unconfirmed','竹林 智也','tonokun@gmail.com','2026龍姫湖まつり','2026-10-18','10:00〜15:00','温井ダム堤体横駐車場','PA・音響・電源対応','[TEST] 2026龍姫湖まつり 正式受注E2E');

insert into public.pa_commercial_documents(id,inquiry_id,document_kind,source_kind,original_filename,mime_type,content,sha256,created_by)
values
('21111111-1111-4111-8111-111111111111','cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3','estimate','sent_recovery','見積書 2026.09.11 龍姫湖まつり（改訂）.pdf','application/pdf',convert_to(repeat('A',30),'UTF8'),encode(sha256(convert_to(repeat('A',30),'UTF8')),'hex'),'123e4567-e89b-42d3-a456-426614174001'),
('21111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111111','estimate','sent_recovery','見積書 2026.09.11 龍姫湖まつり（改訂）.pdf','application/pdf',convert_to(repeat('A',30),'UTF8'),encode(sha256(convert_to(repeat('A',30),'UTF8')),'hex'),'123e4567-e89b-42d3-a456-426614174001');

insert into public.pa_estimate_revisions(id,inquiry_id,revision_number,document_id,amount_minor,currency,tax_basis,conditions_snapshot,source_kind,issued_by,operation_id)
values
('31111111-1111-4111-8111-111111111111','cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3',2,'21111111-1111-4111-8111-111111111111',198550,'JPY','tax_included','{}','sent_recovery','123e4567-e89b-42d3-a456-426614174001','41111111-1111-4111-8111-111111111111'),
('31111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111111',2,'21111111-1111-4111-8111-111111111112',198550,'JPY','tax_included','{}','sent_recovery','123e4567-e89b-42d3-a456-426614174001','41111111-1111-4111-8111-111111111112');

insert into public.pa_case_commercial_state(inquiry_id,revision,current_estimate_revision_id,updated_by)
values
('cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3',1,'31111111-1111-4111-8111-111111111111','123e4567-e89b-42d3-a456-426614174001'),
('11111111-1111-4111-8111-111111111111',1,'31111111-1111-4111-8111-111111111112','123e4567-e89b-42d3-a456-426614174001');

insert into public.pa_production_e2e_tests(operation_id,source_case_id,test_case_id,source_estimate_id,test_estimate_id,source_document_id,test_document_id,allowed_recipient,source_estimate_sha,source_confirmation_subject,created_by)
values('51111111-1111-4111-8111-111111111111','cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111112','21111111-1111-4111-8111-111111111111','21111111-1111-4111-8111-111111111112','tonokun@gmail.com','79d0357eb94d7c9aeb81e0d1621aa9119242c76cd0f3ed3f0d7456d879972f6a','Re: 正式受注確認','123e4567-e89b-42d3-a456-426614174001');

select public.pa_production_e2e_arm_failpoint('123e4567-e89b-42d3-a456-426614174001','11111111-1111-4111-8111-111111111111','61111111-1111-4111-8111-111111111111');

insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,state,recipient,subject,body_text,reply_binding,attachment_ids,attempt_count,lease_id,lease_expires_at)
values('71111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','81111111-1111-4111-8111-111111111111','confirmation','91111111-1111-4111-8111-111111111111','processing','tonokun@gmail.com','Re: 正式受注確認','body','{"delivery_mode":"standalone_production_e2e"}',array['21111111-1111-4111-8111-111111111112'::uuid],1,'a1111111-1111-4111-8111-111111111111',now()+interval '10 minutes');

select public.pa_production_e2e_consume_failpoint('123e4567-e89b-42d3-a456-426614174001','11111111-1111-4111-8111-111111111111','71111111-1111-4111-8111-111111111111');
update public.pa_commercial_outbox set state='unknown',last_error_code='mail_outcome_unknown' where id='71111111-1111-4111-8111-111111111111';

do $$
begin
  begin
    update public.pa_commercial_outbox set state='sent',provider_message_id='must_not_commit' where id='71111111-1111-4111-8111-111111111111';
    raise exception 'guard did not reject direct unknown to sent update';
  exception when others then
    if sqlerrm='guard did not reject direct unknown to sent update' then raise; end if;
  end;
end $$;

select public.pa_production_e2e_reconcile_unknown('123e4567-e89b-42d3-a456-426614174001','11111111-1111-4111-8111-111111111111','71111111-1111-4111-8111-111111111111','gmail_message_1','gmail_thread_1',now());
select public.pa_production_e2e_reconcile_unknown('123e4567-e89b-42d3-a456-426614174001','11111111-1111-4111-8111-111111111111','71111111-1111-4111-8111-111111111111','gmail_message_1','gmail_thread_1',now());
select public.pa_production_e2e_archive_case('123e4567-e89b-42d3-a456-426614174001','11111111-1111-4111-8111-111111111111','Local E2E behavior complete');

select jsonb_build_object(
  'failpoint_fired',(select failpoint_fired_at is not null from public.pa_production_e2e_tests where test_case_id='11111111-1111-4111-8111-111111111111'),
  'outbox',(select jsonb_build_object('state',state,'message',provider_message_id,'thread',provider_thread_id,'attempts',attempt_count) from public.pa_commercial_outbox where id='71111111-1111-4111-8111-111111111111'),
  'archived',(select deleted_at is not null and delete_reason='test_case' from public.pa_inquiries where id='11111111-1111-4111-8111-111111111111'),
  'real_case_deleted',(select deleted_at is not null from public.pa_inquiries where id='cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3'),
  'reconcile_audit',(select count(*) from public.pa_inquiry_audit where inquiry_id='11111111-1111-4111-8111-111111111111' and action='production_e2e_unknown_reconciled')
) result;

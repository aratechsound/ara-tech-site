-- PAUI-058 candidate read-only classifier. Included in the alternative SQL.
-- This does not reconcile, cancel, resend or change any delivery state.
begin;
create function public.pa_sent_quote_delivery_gate_v1(p_actor uuid,p_case uuid,p_contract uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 j public.pa_commercial_outbox%rowtype; c public.pa_contracts%rowtype;
 old_offer public.pa_contract_offers%rowtype; replacement public.pa_contract_offers%rowtype;
 ack public.pa_commercial_outbox%rowtype; e public.pa_estimate_revisions%rowtype;
 d public.pa_commercial_documents%rowtype; receipt public.pa_contract_receipts%rowtype;
 blocked jsonb:='[]'::jsonb; historical jsonb:='[]'::jsonb; ok boolean;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if not exists(select 1 from public.pa_inquiries where id=p_case and deleted_at is null) then raise exception 'case_unavailable';end if;
 if (select count(*) from public.pa_commercial_outbox where inquiry_id=p_case)>200 then
  return jsonb_build_object('case_id',p_case,'contract_id',p_contract,'blocked',true,'reason','OUTBOX_SCOPE_INCOMPLETE','read_only',true);end if;
 select * into c from public.pa_contracts where id=p_contract and inquiry_id=p_case;
 for j in select * from public.pa_commercial_outbox where inquiry_id=p_case
   and (state in ('unknown','processing') or delivery_state='unknown_after_provider_start') order by id loop
  ok:=false;
  -- Only an UNKNOWN confirmation explicitly replaced by this accepted contract
  -- is eligible. Processing, current-contract and other jobs always block.
  if j.state='unknown' and (j.delivery_state is null or j.delivery_state='unknown_after_provider_start')
   and j.job_kind='confirmation' and c.id is not null and j.aggregate_id<>c.id
   and (select count(*) from public.pa_contracts where inquiry_id=p_case)=1 then
   select * into old_offer from public.pa_contract_offers where id=j.aggregate_id and inquiry_id=p_case;
   select * into replacement from public.pa_contract_offers where id=c.id and inquiry_id=p_case;
   select * into ack from public.pa_commercial_outbox where inquiry_id=p_case and aggregate_id=c.id and job_kind='confirmation';
   select * into e from public.pa_estimate_revisions where id=replacement.estimate_revision_id and inquiry_id=p_case;
   select * into d from public.pa_commercial_documents where id=e.document_id and inquiry_id=p_case;
   select * into receipt from public.pa_contract_receipts where contract_id=c.id;
   ok:=(old_offer.id is not null and replacement.id is not null and ack.id is not null
    and e.id is not null and d.id is not null and receipt.contract_id=c.id
    and (select count(*) from public.pa_commercial_outbox where inquiry_id=p_case and aggregate_id=c.id and job_kind='confirmation')=1
    and not exists(select 1 from public.pa_contracts where id=old_offer.id)
    and (select state from public.pa_contract_tokens where offer_id=old_offer.id)='revoked'
    and (select state from public.pa_contract_tokens where offer_id=c.id)='accepted'
    and not exists(select 1 from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=p_case and t.state='active')
    and replacement.snapshot->'customer_acknowledgement'->>'source'='owner_confirmation_replacement_preview'
    and replacement.snapshot->'customer_acknowledgement'->>'replaced_offer_id'=old_offer.id::text
    and exists(select 1 from public.pa_inquiry_audit audit where audit.inquiry_id=p_case and audit.action='formal_contract_replaced'
      and audit.actor_user_id is not null and audit.details->>'old_offer_id'=old_offer.id::text
      and audit.details->>'new_offer_id'=c.id::text and audit.details->>'estimate_revision_id'=e.id::text)
    and replacement.snapshot->'customer_acknowledgement'->>'preview_fingerprint' ~ '^[a-f0-9]{64}$'
    and ((old_offer.snapshot->'customer_acknowledgement')-array['source','preview_fingerprint'])
      =((replacement.snapshot->'customer_acknowledgement')-array['source','preview_fingerprint','replaced_offer_id'])
    and old_offer.version<replacement.version and replacement.version=c.version
    and old_offer.estimate_revision_id=replacement.estimate_revision_id
    and old_offer.quote_sha256=replacement.quote_sha256 and replacement.quote_sha256=d.sha256
    and old_offer.quote_sha256=encode(sha256(old_offer.quote_pdf),'hex')
    and replacement.quote_sha256=encode(sha256(replacement.quote_pdf),'hex')
    and d.sha256=encode(sha256(d.content),'hex')
    and old_offer.snapshot_sha256=encode(sha256(convert_to(old_offer.snapshot::text,'UTF8')),'hex')
    and replacement.snapshot_sha256=encode(sha256(convert_to(replacement.snapshot::text,'UTF8')),'hex')
    and c.snapshot_sha256=encode(sha256(convert_to(c.snapshot::text,'UTF8')),'hex')
    and receipt.sha256=encode(sha256(receipt.pdf),'hex')
    and old_offer.snapshot-array['contract_id','contract_version','issued_at','expires_at','issuance','customer_acknowledgement']
      =replacement.snapshot-array['contract_id','contract_version','issued_at','expires_at','issuance','customer_acknowledgement']
    and c.snapshot-array['agreed','acceptance','confirmed_at','confirmed_at_jst','confirmer_name']
      =replacement.snapshot-array['confirmer_name']
    and c.snapshot->>'agreed'='true' and jsonb_typeof(c.snapshot->'acceptance')='object'
    and (c.snapshot->>'confirmed_at')::timestamptz=c.confirmed_at
    and replacement.snapshot->>'contract_id'=c.id::text and replacement.snapshot->>'case_id'=p_case::text
    and old_offer.snapshot->>'contract_id'=old_offer.id::text and old_offer.snapshot->>'case_id'=p_case::text
    and ack.state='sent' and ack.delivery_state='sent' and ack.provider_request_started is true and ack.provider_response_received is true
    and nullif(ack.provider_message_id,'') is not null and nullif(ack.provider_thread_id,'') is not null
    and nullif(j.recipient,'') is not null and j.recipient=ack.recipient and ack.recipient=replacement.snapshot->>'recipient'
    and j.attachment_ids=ack.attachment_ids and ack.attachment_ids=array[d.id]
    and j.reply_binding->>'thread_id'=ack.reply_binding->>'thread_id' and ack.provider_thread_id=ack.reply_binding->>'thread_id'
    and nullif(j.reply_binding->>'thread_id','') is not null
    and j.reply_binding->>'reply_source_message_id'=ack.reply_binding->>'reply_source_message_id'
    and nullif(ack.reply_binding->>'reply_source_message_id','') is not null
    and j.created_at<=old_offer.issued_at and j.finished_at>=j.created_at and j.finished_at<replacement.issued_at
    and old_offer.issued_at<replacement.issued_at and ack.created_at<=replacement.issued_at
    and ack.finished_at>=replacement.issued_at and ack.finished_at<=c.confirmed_at);
  end if;
  if ok is true then
   historical:=historical||jsonb_build_array(jsonb_build_object('outbox_id',j.id,'offer_id',j.aggregate_id,'state','unknown','classification','REVOKED_EXPLICIT_REPLACEMENT_ACCEPTED','replacement_contract_id',c.id));
  else blocked:=blocked||jsonb_build_array(jsonb_build_object('outbox_id',j.id,'state',j.state,'classification','UNRESOLVED_OR_UNPROVEN'));end if;
 end loop;
 return jsonb_build_object('case_id',p_case,'contract_id',p_contract,'blocked',jsonb_array_length(blocked)>0,'blocking',blocked,'historical_unknown',historical,'read_only',true);
end $$;
revoke all on function public.pa_sent_quote_delivery_gate_v1(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.pa_sent_quote_delivery_gate_v1(uuid,uuid,uuid) to service_role;
commit;

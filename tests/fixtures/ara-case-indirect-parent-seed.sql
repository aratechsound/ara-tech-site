-- Adverse inherited R1 classification fixture, created under real pre-R1 schema.
-- No triggers, constraints, roles, or RLS are disabled.
insert into pa_contract_offers(id,inquiry_id,version,expires_at,issued_by,snapshot,snapshot_sha256,quote_pdf,quote_sha256)
 select gen_random_uuid(),id,1,now()+interval '7 days',created_by,'{}',repeat('a',64),convert_to(repeat('x',20),'UTF8'),encode(sha256(convert_to(repeat('x',20),'UTF8')),'hex') from pa_inquiries where customer_name in ('CLASS_STAGE_PA','CLASS_INDIRECT_NON_PA');
insert into pa_contracts(id,inquiry_id,version,confirmed_at,snapshot,snapshot_sha256)
 select id,inquiry_id,version,now(),'{}',encode(sha256(convert_to('{}','UTF8')),'hex') from pa_contract_offers where inquiry_id in(select id from pa_inquiries where customer_name in('CLASS_STAGE_PA','CLASS_INDIRECT_NON_PA'));
insert into pa_portals(case_id) select id from pa_inquiries where customer_name in ('CLASS_STAGE_PA','CLASS_INDIRECT_NON_PA','CLASS_UNKNOWN');
insert into pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind)
 select p.id,'other','fixture','collection','ara_tech' from pa_portals p join pa_inquiries i on i.id=p.case_id where i.customer_name in ('CLASS_STAGE_PA','CLASS_INDIRECT_NON_PA');

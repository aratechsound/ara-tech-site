-- Only after verifying exact PAUI-016 ACL is applied, and separate Owner GO.
begin;
drop policy paui016_work_admin_read on public.pa_estimate_revisions;
drop policy paui016_work_admin_read on public.pa_commercial_documents;
drop policy paui016_work_admin_read on public.pa_contract_offers;
drop policy paui016_work_admin_read on public.pa_billings;
revoke select(id,inquiry_id,revision_number,issued_at,amount_minor,currency,document_id) on public.pa_estimate_revisions from authenticated;
revoke select(id,inquiry_id,original_filename,mime_type,sha256,created_at,content) on public.pa_commercial_documents from authenticated;
revoke select(id,inquiry_id,version,issued_at,expires_at) on public.pa_contract_offers from authenticated;
revoke select(id,inquiry_id,invoice_policy,invoice_delivery_state,due_date,customer_planned_payment_on,created_at) on public.pa_billings from authenticated;
commit;

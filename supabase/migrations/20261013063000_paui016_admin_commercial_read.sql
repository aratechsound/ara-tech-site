-- PAUI-016 candidate only. Apply only after separate Owner GO and fresh ACL identity.
-- Column SELECT, four tables, existing is_work_admin; no DML, anon, RPC, or service-role fallback.
begin;
do $$
declare t text;
begin
  foreach t in array array['pa_estimate_revisions','pa_commercial_documents','pa_contract_offers','pa_billings'] loop
    if not (select relrowsecurity from pg_class where oid=('public.'||t)::regclass)
      or has_table_privilege('authenticated',('public.'||t)::regclass,'SELECT')
      or has_table_privilege('anon',('public.'||t)::regclass,'SELECT')
      or exists(select 1 from pg_attribute a where a.attrelid=('public.'||t)::regclass and a.attnum>0 and not a.attisdropped
        and (has_column_privilege('authenticated',a.attrelid,a.attnum,'SELECT') or has_column_privilege('anon',a.attrelid,a.attnum,'SELECT')))
      or exists(select 1 from pg_policy where polrelid=('public.'||t)::regclass) then
      raise exception 'paui016_acl_baseline_changed';
    end if;
  end loop;
end $$;
grant select(id,inquiry_id,revision_number,issued_at,amount_minor,currency,document_id) on public.pa_estimate_revisions to authenticated;
grant select(id,inquiry_id,original_filename,mime_type,sha256,created_at,content) on public.pa_commercial_documents to authenticated;
grant select(id,inquiry_id,version,issued_at,expires_at) on public.pa_contract_offers to authenticated;
grant select(id,inquiry_id,invoice_policy,invoice_delivery_state,due_date,customer_planned_payment_on,created_at) on public.pa_billings to authenticated;
create policy paui016_work_admin_read on public.pa_estimate_revisions for select to authenticated using ((select public.is_work_admin()));
create policy paui016_work_admin_read on public.pa_commercial_documents for select to authenticated using ((select public.is_work_admin()));
create policy paui016_work_admin_read on public.pa_contract_offers for select to authenticated using ((select public.is_work_admin()));
create policy paui016_work_admin_read on public.pa_billings for select to authenticated using ((select public.is_work_admin()));
commit;

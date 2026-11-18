-- Remove only the PAUI-095 portal upload read policy.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
drop policy "PAUI-095 read saved portal uploads" on storage.objects;
commit;

-- Restore the two hosted legacy browser grants after rolling back the app.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
drop function public.pa_manage_schedule_token_v2(uuid,timestamptz,uuid,text,text,timestamptz);
grant execute on function public.issue_pa_schedule_token(uuid,text,timestamptz),public.revoke_pa_schedule_token(uuid)
  to anon,authenticated;
commit;

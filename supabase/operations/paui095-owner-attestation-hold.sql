-- Owner-approved hosted repair. The hosted PAUI-086 function is the required preimage.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
set local search_path = pg_catalog, public;

do $paui095$
declare
  target constant regprocedure := 'public.update_pa_case_progress(uuid,jsonb,text)'::regprocedure;
  definition text := pg_get_functiondef(target);
  anchor constant text := '    -- V5 billing/payment facts must use its existing balance-checked close RPC.';
  hold_guard constant text := concat_ws(chr(10),
    '    if v_inquiry.status = ''on_hold'' or v_before.is_on_hold then',
    '      raise exception ''held case cannot be completed'';',
    '    end if;',
    '');
  old_hash constant text := '0fe6fc8aef99710def93077b6ad7352084a06268aed24887b9e41fe762a71d7b';
  new_hash constant text := '8a25b60665b92b03fe7b1c5e530cc44c4ef942760e850a40eeb77d71d299bfcb';
  expected_acl constant text := '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
begin
  if encode(sha256(convert_to(definition, 'UTF8')), 'hex') <> old_hash
    or not exists (select 1 from pg_proc
      where oid = target and pg_get_userbyid(proowner) = 'postgres' and proacl::text = expected_acl)
    or array_length(string_to_array(definition, anchor), 1) is distinct from 2
  then
    raise exception 'PAUI-095 owner attestation baseline mismatch';
  end if;
  execute replace(definition, anchor, hold_guard || anchor);
  if encode(sha256(convert_to(pg_get_functiondef(target), 'UTF8')), 'hex') <> new_hash then
    raise exception 'PAUI-095 owner attestation postimage mismatch';
  end if;
end
$paui095$;

commit;

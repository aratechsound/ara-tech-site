-- Restore the exact hosted PAUI-086 definition only from the PAUI-095 postimage.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
set local search_path = pg_catalog, public;

do $paui095$
declare
  target constant regprocedure := 'public.update_pa_case_progress(uuid,jsonb,text)'::regprocedure;
  definition text := pg_get_functiondef(target);
  hold_guard constant text := concat_ws(chr(10),
    '    if v_inquiry.status = ''on_hold'' or v_before.is_on_hold then',
    '      raise exception ''held case cannot be completed'';',
    '    end if;',
    '');
  restored text := replace(definition, hold_guard, '');
  old_hash constant text := '0fe6fc8aef99710def93077b6ad7352084a06268aed24887b9e41fe762a71d7b';
  new_hash constant text := '8a25b60665b92b03fe7b1c5e530cc44c4ef942760e850a40eeb77d71d299bfcb';
  expected_acl constant text := '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
begin
  if encode(sha256(convert_to(definition, 'UTF8')), 'hex') <> new_hash
    or not exists (select 1 from pg_proc
      where oid = target and pg_get_userbyid(proowner) = 'postgres' and proacl::text = expected_acl)
    or encode(sha256(convert_to(restored, 'UTF8')), 'hex') <> old_hash
  then
    raise exception 'PAUI-095 owner attestation rollback baseline mismatch';
  end if;
  execute restored;
  if encode(sha256(convert_to(pg_get_functiondef(target), 'UTF8')), 'hex') <> old_hash then
    raise exception 'PAUI-095 owner attestation rollback postimage mismatch';
  end if;
end
$paui095$;

commit;

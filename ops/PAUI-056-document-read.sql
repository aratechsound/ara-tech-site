-- PAUI-056 proposal only. Owner approval is required before Production apply.
-- Existing send-operation bindings hold classification; no table/row is changed.
begin;
create function public.pa_reply_document_list_v1(p_actor uuid,p_case uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if p_actor is null or not exists(select 1 from public.work_admins where user_id=p_actor)
  then raise exception 'not_authorized';end if;
 if p_case is null or not exists(select 1 from public.pa_inquiries where id=p_case and deleted_at is null)
  then raise exception 'inquiry_not_found';end if;
 select coalesce(jsonb_agg(x.operation order by x.created_at desc,x.operation_id),'[]'::jsonb) into result
 from (select o.operation_id,o.created_at,jsonb_build_object(
  'operation_id',o.operation_id,'inquiry_id',o.inquiry_id,'binding',o.binding,
  'state',e.state,'gmail_message_id',e.evidence->>'gmail_message_id',
  'history_sync',e.evidence->>'history_sync','created_at',o.created_at,'expires_at',o.expires_at) as operation
  from public.pa_reply_operations_v1 o
  join lateral(select ev.state,ev.evidence from public.pa_reply_operation_events_v1 ev
   where ev.operation_id=o.operation_id order by ev.seq desc limit 1) e on true
  where o.actor_id=p_actor and o.inquiry_id=p_case and o.account='aratechsound@gmail.com'
   and exists(select 1 from pg_catalog.jsonb_array_elements(o.binding->'attachments') a
    where a->>'document_kind' in ('estimate','invoice'))
  order by o.created_at desc,o.operation_id limit 21) x;
 return jsonb_build_object('ok',true,'operations',result);
end;
$$;
revoke all on function public.pa_reply_document_list_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pa_reply_document_list_v1(uuid,uuid) to service_role;
commit;

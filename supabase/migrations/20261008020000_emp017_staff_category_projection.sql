-- Independent candidate from fresh Production function, 2026-10-06 22:02:22 UTC.
-- JSON category only; no schema, grants, ordering or authorization changes.
begin;
CREATE OR REPLACE FUNCTION public.pa_portal_staff_read(p_session_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ctx record;i public.pa_inquiries%rowtype;docs jsonb;
begin
 select * into ctx from public.pa_portal_staff_context(p_session_hash);
 if not found then return jsonb_build_object('ok',false);end if;
 select * into i from public.pa_inquiries where id=ctx.case_id;
 select coalesce(jsonb_agg(d.payload order by d.sort_order,d.created_at),'[]'::jsonb) into docs from (
  select c.sort_order,c.created_at,jsonb_build_object('section',public.pa_portal_staff_section(ctx.grade,c.category),'ref',v.public_ref,'kind','version','category',c.category,'title',c.title,'filename',v.display_filename,'mime_type',v.mime_type,'version_label',v.version_label,'updated_at',v.created_at) payload
  from public.pa_portal_document_cards c join public.pa_portal_document_versions v on v.id=c.current_version_id and v.card_id=c.id
  where c.portal_id=ctx.portal_id and c.archived_at is null and v.archived_at is null and public.pa_portal_staff_section(ctx.grade,c.category) is not null
  union all
  select f.sort_order,f.created_at,jsonb_build_object('section',public.pa_portal_staff_section(ctx.grade,'photos'),'ref',f.public_ref,'kind','photo','category','photo','title',f.display_filename,'filename',f.display_filename,'mime_type',f.mime_type,'version_label',null,'updated_at',f.created_at)
  from public.pa_portal_photo_items f where f.portal_id=ctx.portal_id and f.archived_at is null and public.pa_portal_staff_section(ctx.grade,'photos') is not null
 ) d;
 return jsonb_build_object('ok',true,'portal',jsonb_build_object('grade',ctx.grade,'event',jsonb_build_object('name',i.event_name,'date',i.event_date,'time',i.event_time,'venue',i.venue,'timezone',ctx.timezone),'documents',docs));
end $function$
;
commit;

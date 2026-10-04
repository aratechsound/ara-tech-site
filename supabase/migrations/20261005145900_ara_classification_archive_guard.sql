-- Forward-only prerequisite for R1/R2 classification of archived PA roots.
-- Preserve the existing trash guard; narrowly permit classification metadata only.
begin;
create or replace function public.guard_pa_inquiry_soft_delete() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_mode text:=coalesce(current_setting('app.pa_case_delete_mode',true),'');
begin
 if (old.deleted_at is distinct from new.deleted_at or old.delete_reason is distinct from new.delete_reason or old.deleted_by is distinct from new.deleted_by)
 and v_mode not in ('trash','restore') then raise exception 'soft delete fields may only be changed by the PA trash RPC' using errcode='42501'; end if;
 if v_mode='case_type_backfill' and (to_jsonb(old)-'case_type'-'updated_at')=(to_jsonb(new)-'case_type'-'updated_at') then return new; end if;
 if old.deleted_at is not null and new.deleted_at is not null and v_mode not in ('trash','restore','purge') then raise exception 'case is in trash' using errcode='55000'; end if;
 return new;
end $$;
commit;

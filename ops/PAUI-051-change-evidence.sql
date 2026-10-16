-- PAUI-051: separate append-only post-contract evidence authority.
-- Candidate only: Production installation requires approval of this exact SQL.
begin;
create table public.pa_change_evidence_blobs (
 id uuid primary key default gen_random_uuid(),
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$' and sha256=encode(sha256(content),'hex')),
 content bytea not null check (octet_length(content) between 20 and 1500000),
 filename text not null check (char_length(filename) between 1 and 500),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(inquiry_id,sha256)
);
create table public.pa_change_evidence_events (
 id uuid primary key default gen_random_uuid(),
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 contract_id uuid not null references public.pa_contracts(id) on delete restrict,
 operation_id uuid not null unique,
 previous_event_id uuid references public.pa_change_evidence_events(id) on delete restrict,
 event_kind text not null check(event_kind in ('saved','adopted','revoked')),
 evidence jsonb not null check(jsonb_typeof(evidence)='object'),
 reason text not null check(char_length(btrim(reason)) between 1 and 2000),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 event_number bigint generated always as identity unique
);
create index pa_change_evidence_case_history on public.pa_change_evidence_events(inquiry_id,event_number desc);
alter table public.pa_change_evidence_blobs enable row level security;
alter table public.pa_change_evidence_events enable row level security;
revoke all on public.pa_change_evidence_blobs,public.pa_change_evidence_events from public,anon,authenticated,service_role;
revoke all on sequence public.pa_change_evidence_events_event_number_seq from public,anon,authenticated,service_role;
grant select on public.pa_change_evidence_blobs,public.pa_change_evidence_events to service_role;
create function public.pa_change_evidence_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin raise exception 'change_evidence_immutable'; end $$;
create trigger pa_change_evidence_blobs_immutable before update or delete on public.pa_change_evidence_blobs for each row execute function public.pa_change_evidence_immutable();
create trigger pa_change_evidence_events_immutable before update or delete on public.pa_change_evidence_events for each row execute function public.pa_change_evidence_immutable();
create function public.pa_change_evidence_append(
 p_actor uuid,p_case uuid,p_contract uuid,p_operation uuid,p_previous uuid,p_kind text,p_evidence jsonb,p_reason text,p_blobs jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_old public.pa_change_evidence_events%rowtype; v_last public.pa_change_evidence_events%rowtype; v_adopted public.pa_change_evidence_events%rowtype;
 v_contract public.pa_contracts%rowtype; v_id uuid; b jsonb; v_bytes bytea; v_sha text; v_ref jsonb;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_operation is null or p_kind not in ('saved','adopted','revoked') or jsonb_typeof(p_evidence) is distinct from 'object'
  or octet_length(p_evidence::text)>250000 or jsonb_typeof(p_blobs) is distinct from 'array' or jsonb_array_length(p_blobs)>2
  or char_length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_change_evidence'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found then raise exception 'case_unavailable'; end if;
 select * into v_old from public.pa_change_evidence_events where operation_id=p_operation;
 if found then
  if v_old.inquiry_id<>p_case or v_old.contract_id<>p_contract or v_old.created_by<>p_actor or v_old.event_kind<>p_kind
   or v_old.previous_event_id is distinct from p_previous or v_old.evidence<>p_evidence or v_old.reason<>p_reason then raise exception 'idempotency_payload_mismatch'; end if;
  return jsonb_build_object('id',v_old.id,'already_committed',true,'event_kind',v_old.event_kind);
 end if;
 select * into v_contract from public.pa_contracts where id=p_contract and inquiry_id=p_case;
 if not found then raise exception 'contract_not_found'; end if;
 if p_evidence->>'case_id' is distinct from p_case::text or p_evidence->>'contract_id' is distinct from p_contract::text
  or p_evidence->>'contract_sha256' is distinct from encode(sha256(convert_to(v_contract.snapshot::text,'UTF8')),'hex') then raise exception 'change_evidence_mismatch'; end if;
 select * into v_last from public.pa_change_evidence_events where inquiry_id=p_case order by event_number desc limit 1;
 if v_last.id is distinct from p_previous then raise exception 'change_evidence_changed'; end if;
 if p_kind='revoked' then
  select * into v_adopted from public.pa_change_evidence_events where inquiry_id=p_case and event_kind in ('adopted','revoked') order by event_number desc limit 1;
  if v_adopted.id is null or v_adopted.event_kind<>'adopted' or v_adopted.contract_id<>p_contract or v_adopted.evidence<>p_evidence or jsonb_array_length(p_blobs)<>0 then raise exception 'invalid_change_evidence'; end if;
 else
  if coalesce(p_evidence->'quote'->>'sha256','') !~ '^[a-f0-9]{64}$' or coalesce(p_evidence->'quote'->>'source','') not in ('registered','gmail','local')
   or jsonb_typeof(p_evidence->'warnings') is distinct from 'array' then raise exception 'invalid_change_evidence'; end if;
  for b in select value from jsonb_array_elements(p_blobs) loop
   v_bytes:=decode(b->>'content_base64','base64'); v_sha:=encode(sha256(v_bytes),'hex');
   if v_sha is distinct from b->>'sha256' or v_sha not in (p_evidence->'quote'->>'sha256',coalesce(p_evidence->'approval'->>'manual_pdf_sha256','')) then raise exception 'change_evidence_mismatch'; end if;
   if not exists(select 1 from public.pa_commercial_documents where inquiry_id=p_case and sha256=v_sha) then
    insert into public.pa_change_evidence_blobs(inquiry_id,sha256,content,filename,created_by)
     values(p_case,v_sha,v_bytes,b->>'filename',p_actor) on conflict(inquiry_id,sha256) do nothing;
   end if;
  end loop;
  if not exists(select 1 from public.pa_commercial_documents where inquiry_id=p_case and sha256=p_evidence->'quote'->>'sha256')
   and not exists(select 1 from public.pa_change_evidence_blobs where inquiry_id=p_case and sha256=p_evidence->'quote'->>'sha256') then raise exception 'change_evidence_mismatch'; end if;
  if nullif(p_evidence->'quote'->>'estimate_id','') is not null and not exists(
   select 1 from public.pa_estimate_revisions e join public.pa_commercial_documents d on d.id=e.document_id and d.inquiry_id=e.inquiry_id
   where e.id::text=p_evidence->'quote'->>'estimate_id' and e.inquiry_id=p_case and d.sha256=p_evidence->'quote'->>'sha256'
  ) then raise exception 'change_evidence_mismatch'; end if;
  if p_kind='adopted' and (
   coalesce((p_evidence->>'owner_confirmed')::boolean,false) is not true
   or char_length(btrim(coalesce(p_evidence->>'change_description','')))=0
   or char_length(btrim(coalesce(p_evidence->>'owner_reason','')))=0
   or jsonb_array_length(p_evidence->'warnings')>0 and coalesce((p_evidence->>'owner_case_relation_confirmed')::boolean,false) is not true
   or coalesce((p_evidence->'quote'->>'amount_minor')::bigint,0) not between 1 and 9999999999
   or coalesce(p_evidence->'quote'->>'tax_basis','') not in ('tax_included','tax_excluded','tax_exempt')
   or coalesce(p_evidence->'approval'->>'source','') not in ('gmail','manual_pdf')
   or coalesce(p_evidence->'approval'->>'status','') not in ('verified','owner_reviewed')
   or coalesce(p_evidence->'approval'->>'body','')='' and coalesce(p_evidence->'approval'->>'manual_pdf_sha256','')=''
  ) then raise exception 'change_evidence_incomplete'; end if;
  if p_evidence->'approval'->>'source'='manual_pdf' and not exists(select 1 from public.pa_change_evidence_blobs where inquiry_id=p_case and sha256=p_evidence->'approval'->>'manual_pdf_sha256')
   and not exists(select 1 from public.pa_commercial_documents where inquiry_id=p_case and sha256=p_evidence->'approval'->>'manual_pdf_sha256') then raise exception 'change_evidence_mismatch'; end if;
 end if;
 insert into public.pa_change_evidence_events(inquiry_id,contract_id,operation_id,previous_event_id,event_kind,evidence,reason,created_by)
  values(p_case,p_contract,p_operation,p_previous,p_kind,p_evidence,p_reason,p_actor) returning id into v_id;
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details)
  values(p_case,p_actor,'change_evidence_'||p_kind,jsonb_build_object('event_id',v_id,'operation_id',p_operation,'previous_event_id',p_previous,'contract_id',p_contract,'quote_sha256',p_evidence->'quote'->>'sha256'));
 return jsonb_build_object('id',v_id,'already_committed',false,'event_kind',p_kind);
end $$;
revoke all on function public.pa_change_evidence_immutable(),public.pa_change_evidence_append(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.pa_change_evidence_immutable() from service_role;
grant execute on function public.pa_change_evidence_append(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,jsonb) to service_role;
commit;

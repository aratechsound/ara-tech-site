-- PAUI-053: proposal. Production application requires the separately approved exact SHA256.
begin;
create table public.pa_quote_monitor_scans (
 inquiry_id uuid primary key references public.pa_inquiries(id),
 cursor_sha256 text not null check(cursor_sha256 ~ '^[a-f0-9]{64}$'),
 lease_id uuid not null, lease_until timestamptz not null,
 generation bigint not null default 1, attempts integer not null default 1 check(attempts between 1 and 2),
 state text not null check(state in ('checking','ready','partial','incomplete','failed')),
 checked_at timestamptz, started_at timestamptz not null default now(), retry_after timestamptz,
 candidates jsonb not null default '[]' check(jsonb_typeof(candidates)='array' and jsonb_array_length(candidates)<=30),
 messages jsonb not null default '[]' check(jsonb_typeof(messages)='array' and jsonb_array_length(messages)<=20),
 errors jsonb not null default '[]' check(jsonb_typeof(errors)='array' and jsonb_array_length(errors)<=30)
);
create table public.pa_quote_monitor_blobs (
 inquiry_id uuid not null references public.pa_inquiries(id), sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 content bytea not null check(octet_length(content) between 5 and 1500000), filename text not null check(char_length(filename) between 1 and 500),
 created_by uuid not null, created_at timestamptz not null default now(),
 primary key(inquiry_id,sha256), check(encode(sha256(content),'hex')=sha256)
);
create table public.pa_quote_monitor_decisions (
 id uuid primary key default gen_random_uuid(), event_number bigint generated always as identity unique,
 inquiry_id uuid not null references public.pa_inquiries(id), operation_id uuid not null unique,
 candidate_key text not null check(candidate_key ~ '^[a-f0-9]{64}$'), quote_sha256 text not null check(quote_sha256 ~ '^[a-f0-9]{64}$'),
 previous_event_id uuid references public.pa_quote_monitor_decisions(id),
 event_kind text not null check(event_kind in ('excluded','deferred','restored')),
 candidate jsonb not null check(jsonb_typeof(candidate)='object'), reason text not null check(char_length(btrim(reason)) between 1 and 2000),
 created_by uuid not null, created_at timestamptz not null default now()
);
create index pa_quote_monitor_decisions_case_key on public.pa_quote_monitor_decisions(inquiry_id,candidate_key,event_number desc);
alter table public.pa_quote_monitor_scans enable row level security;
alter table public.pa_quote_monitor_blobs enable row level security;
alter table public.pa_quote_monitor_decisions enable row level security;
revoke all on public.pa_quote_monitor_scans,public.pa_quote_monitor_blobs,public.pa_quote_monitor_decisions from public,anon,authenticated,service_role;
grant select on public.pa_quote_monitor_scans,public.pa_quote_monitor_blobs,public.pa_quote_monitor_decisions to service_role;
revoke all on sequence public.pa_quote_monitor_decisions_event_number_seq from public,anon,authenticated,service_role;

create function public.pa_quote_monitor_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'quote_monitor_immutable'; end $$;
create trigger pa_quote_monitor_blobs_immutable before update or delete on public.pa_quote_monitor_blobs for each row execute function public.pa_quote_monitor_immutable();
create trigger pa_quote_monitor_decisions_immutable before update or delete on public.pa_quote_monitor_decisions for each row execute function public.pa_quote_monitor_immutable();
revoke all on function public.pa_quote_monitor_immutable() from public,anon,authenticated,service_role;

-- Stable MIME part metadata is authoritative here; transient attachment resource IDs
-- and indexed_at alone are deliberately excluded. The original reader still admits
-- the persisted resource/part pair and verifies the current MIME part before use.
create function public.pa_quote_monitor_cursor(p_case uuid) returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_object(
  'case',p_case,
  'messages',coalesce((select jsonb_agg(jsonb_build_array(m.gmail_message_id,m.gmail_thread_id,m.direction,m.subject,m.from_address,m.to_addresses,m.sent_at,m.received_at,
   coalesce((select jsonb_agg(jsonb_build_array(coalesce(nullif(a->>'part_id',''),a->>'id'),a->>'filename',a->>'original_filename',a->>'mime_type',a->>'size',a->>'sha256') order by a->>'part_id',a->>'filename') from jsonb_array_elements(coalesce(m.attachment_metadata,'[]'::jsonb)) a),'[]'::jsonb)) order by m.gmail_message_id)
   from public.pa_gmail_message_index m where m.inquiry_id=p_case),'[]'::jsonb),
  'contracts',coalesce((select jsonb_agg(jsonb_build_array(c.id,c.confirmed_at,encode(sha256(convert_to(c.snapshot::text,'UTF8')),'hex')) order by c.id) from public.pa_contracts c where c.inquiry_id=p_case),'[]'::jsonb),
  'evidence',(select e.id from public.pa_change_evidence_events e where e.inquiry_id=p_case order by e.event_number desc limit 1)
 )::text,'UTF8')),'hex')
$$;
revoke all on function public.pa_quote_monitor_cursor(uuid) from public,anon,authenticated,service_role;

create function public.pa_quote_monitor_list(p_actor uuid,p_cases uuid[],p_detail boolean default false) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_cases is null or cardinality(p_cases) not between 1 and 20 or array_position(p_cases,null) is not null then raise exception 'invalid_quote_monitor'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('case_id',i.id,'eligible',exists(select 1 from public.pa_contracts c where c.inquiry_id=i.id and c.confirmed_at is not null),
  'cursor',public.pa_quote_monitor_cursor(i.id),'index_count',(select count(*) from public.pa_gmail_message_index m where m.inquiry_id=i.id),
  'scan',case when p_detail then to_jsonb(s) when s.inquiry_id is null then null else jsonb_build_object('cursor_sha256',s.cursor_sha256,'generation',s.generation,'attempts',s.attempts,'state',s.state,'checked_at',s.checked_at,'lease_until',s.lease_until,'retry_after',s.retry_after,'candidates',(select coalesce(jsonb_agg(jsonb_build_object('key',c->'key','already_adopted',c->'already_adopted','not_change',c->'not_change','verified_at',c->'verified_at','source_event_id',c->'source_event_id','evidence',jsonb_build_object('approval',jsonb_build_object('status',c->'evidence'->'approval'->'status')))),'[]'::jsonb) from jsonb_array_elements(s.candidates) c)) end,'mail_sync',(select jsonb_build_object('complete',m.state->'complete','last_completed_at',m.state->'last_completed_at','last_error',m.state->'last_error','version',m.version) from public.paui041_mail_sync_state m where m.inquiry_id=i.id),
  'decisions',coalesce((select jsonb_agg(case when p_detail then to_jsonb(d) else to_jsonb(d)-'candidate'-'reason' end) from (select distinct on(candidate_key) * from public.pa_quote_monitor_decisions where inquiry_id=i.id and candidate_key in (select value->>'key' from jsonb_array_elements(coalesce(s.candidates,'[]'::jsonb))) order by candidate_key,event_number desc) d),'[]'::jsonb))), '[]'::jsonb)
 into result from public.pa_inquiries i left join public.pa_quote_monitor_scans s on s.inquiry_id=i.id where i.id=any(p_cases) and i.deleted_at is null;
 return result;
end $$;
revoke all on function public.pa_quote_monitor_list(uuid,uuid[],boolean) from public,anon,authenticated,service_role;
grant execute on function public.pa_quote_monitor_list(uuid,uuid[],boolean) to service_role;

create function public.pa_quote_monitor_apply(p_actor uuid,p_case uuid,p_operation uuid,p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.pa_quote_monitor_scans; old public.pa_quote_monitor_decisions; last_event public.pa_quote_monitor_decisions;
 cursor_value text; candidate_value jsonb; b jsonb; bytes_value bytea; sha_value text; new_id uuid; force_value boolean;
begin
 perform public.pa_v5_assert_admin(p_actor);
 if p_operation is null or p_action not in ('claim','finish','excluded','deferred','restored') or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>8000000 then raise exception 'invalid_quote_monitor'; end if;
 perform 1 from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found then raise exception 'case_unavailable'; end if;
 select * into s from public.pa_quote_monitor_scans where inquiry_id=p_case for update;
 cursor_value:=public.pa_quote_monitor_cursor(p_case);
 if p_action='claim' then
  if p_data->>'cursor' is distinct from cursor_value then raise exception 'quote_monitor_changed'; end if;
  force_value:=coalesce((p_data->>'force')::boolean,false);
  if s.lease_id=p_operation or s.state='checking' and s.lease_until>now() then return jsonb_build_object('claimed',false,'scan',to_jsonb(s)); end if;
  if s.cursor_sha256=cursor_value and ((s.state='ready' and s.checked_at>now()-interval '6 hours' and not force_value and not exists(select 1 from jsonb_array_elements(s.candidates) c where c->>'source_event_id' is null and (c->>'verified_at')::timestamptz<now()-interval '6 hours')) or (s.retry_after>now()) or (s.attempts>=2 and s.state<>'ready' and not force_value)) then return jsonb_build_object('claimed',false,'scan',to_jsonb(s)); end if;
  if force_value and s.started_at>now()-interval '1 minute' then raise exception 'quote_monitor_cooldown'; end if;
  insert into public.pa_quote_monitor_scans(inquiry_id,cursor_sha256,lease_id,lease_until,generation,attempts,state,started_at)
   values(p_case,cursor_value,p_operation,now()+interval '2 minutes',1,1,'checking',now())
   on conflict(inquiry_id) do update set cursor_sha256=excluded.cursor_sha256,lease_id=p_operation,lease_until=excluded.lease_until,
    generation=pa_quote_monitor_scans.generation+1,attempts=case when pa_quote_monitor_scans.cursor_sha256=cursor_value and not force_value then least(2,pa_quote_monitor_scans.attempts+1) else 1 end,state='checking',started_at=now(),retry_after=null
   returning * into s;
  return jsonb_build_object('claimed',true,'scan',to_jsonb(s));
 elsif p_action='finish' then
  if s.lease_id is distinct from p_operation or s.cursor_sha256 is distinct from cursor_value or p_data->>'cursor' is distinct from cursor_value or s.state<>'checking' or s.lease_until<now() then raise exception 'quote_monitor_changed'; end if;
  if jsonb_typeof(p_data->'messages') is distinct from 'array' or jsonb_array_length(p_data->'messages')>20 then raise exception 'invalid_quote_monitor'; end if;
  if p_data->>'state' not in ('ready','partial','incomplete','failed') or jsonb_typeof(p_data->'candidates') is distinct from 'array' or jsonb_array_length(p_data->'candidates')>30 or jsonb_typeof(p_data->'errors') is distinct from 'array' or jsonb_array_length(p_data->'errors')>30 or jsonb_typeof(p_data->'blobs') is distinct from 'array' or jsonb_array_length(p_data->'blobs')>3 then raise exception 'invalid_quote_monitor'; end if;
  for candidate_value in select value from jsonb_array_elements(p_data->'candidates') loop
   if candidate_value->>'case_id' is distinct from p_case::text or coalesce(candidate_value->>'key','') !~ '^[a-f0-9]{64}$' or coalesce(candidate_value->'evidence'->'quote'->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_quote_monitor'; end if;
  end loop;
  for b in select value from jsonb_array_elements(p_data->'blobs') loop
   bytes_value:=decode(b->>'content_base64','base64');sha_value:=encode(sha256(bytes_value),'hex');
   if sha_value is distinct from b->>'sha256' or not exists(select 1 from jsonb_array_elements(p_data->'candidates') c where c->'evidence'->'quote'->>'sha256'=sha_value) then raise exception 'quote_monitor_mismatch'; end if;
   insert into public.pa_quote_monitor_blobs(inquiry_id,sha256,content,filename,created_by) values(p_case,sha_value,bytes_value,b->>'filename',p_actor) on conflict(inquiry_id,sha256) do nothing;
  end loop;
  update public.pa_quote_monitor_scans set state=p_data->>'state',candidates=p_data->'candidates',messages=p_data->'messages',errors=p_data->'errors',checked_at=now(),lease_until=now(),retry_after=case when p_data->>'state' in ('ready','partial') then null else now()+interval '1 minute' end where inquiry_id=p_case returning * into s;
  return jsonb_build_object('scan',to_jsonb(s));
 else
  if coalesce(p_data->>'reason','')='' or char_length(p_data->>'reason')>2000 then raise exception 'invalid_quote_monitor'; end if;
  select * into old from public.pa_quote_monitor_decisions where operation_id=p_operation;
  if found then
   if old.inquiry_id<>p_case or old.created_by<>p_actor or old.candidate_key is distinct from p_data->>'candidate_key' or old.quote_sha256 is distinct from p_data->>'quote_sha256' or old.event_kind<>p_action or old.reason is distinct from p_data->>'reason' or old.previous_event_id::text is distinct from p_data->>'previous_event_id' then raise exception 'idempotency_payload_mismatch'; end if;
   return jsonb_build_object('id',old.id,'already_committed',true);
  end if;
  select * into last_event from public.pa_quote_monitor_decisions where inquiry_id=p_case and candidate_key=p_data->>'candidate_key' order by event_number desc limit 1;
  if last_event.id::text is distinct from p_data->>'previous_event_id' then raise exception 'quote_monitor_changed'; end if;
  if p_action='restored' then
   if last_event.event_kind<>'excluded' then raise exception 'invalid_quote_monitor'; end if;candidate_value:=last_event.candidate;
  else
   if s.cursor_sha256 is distinct from cursor_value or s.state not in ('ready','partial','incomplete') then raise exception 'quote_monitor_changed'; end if;
   select value into candidate_value from jsonb_array_elements(s.candidates) where value->>'key'=p_data->>'candidate_key';
   if candidate_value is null or coalesce((candidate_value->>'already_adopted')::boolean,false) or coalesce((candidate_value->>'not_change')::boolean,false) then raise exception 'quote_monitor_mismatch'; end if;
  end if;
  if candidate_value->'evidence'->'quote'->>'sha256' is distinct from p_data->>'quote_sha256' then raise exception 'quote_monitor_mismatch'; end if;
  insert into public.pa_quote_monitor_decisions(inquiry_id,operation_id,candidate_key,quote_sha256,previous_event_id,event_kind,candidate,reason,created_by)
   values(p_case,p_operation,p_data->>'candidate_key',p_data->>'quote_sha256',last_event.id,p_action,candidate_value,p_data->>'reason',p_actor) returning id into new_id;
  return jsonb_build_object('id',new_id,'already_committed',false);
 end if;
end $$;
revoke all on function public.pa_quote_monitor_apply(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.pa_quote_monitor_apply(uuid,uuid,uuid,text,jsonb) to service_role;
commit;

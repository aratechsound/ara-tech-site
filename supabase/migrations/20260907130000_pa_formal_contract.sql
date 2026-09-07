-- PA formal contracts. Forward-only candidate; do not apply without release approval.
begin;
create table public.pa_contract_offers (
 id uuid primary key,
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 version integer not null check(version>0),
 issued_at timestamptz not null default now(),
 expires_at timestamptz not null,
 issued_by uuid not null references auth.users(id),
 snapshot jsonb not null,
 snapshot_sha256 text not null check(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 quote_pdf bytea not null check(octet_length(quote_pdf) between 20 and 1500000),
 quote_sha256 text not null check(quote_sha256=encode(sha256(quote_pdf),'hex')),
 unique(inquiry_id,version), unique(id,inquiry_id)
);
create table public.pa_contract_tokens (
 offer_id uuid primary key references public.pa_contract_offers(id) on delete restrict,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'active' check(state in ('active','revoked','accepted'))
);
create table public.pa_contracts (
 id uuid primary key references public.pa_contract_offers(id) on delete restrict,
 inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
 version integer not null,
 confirmed_at timestamptz not null,
 snapshot jsonb not null,
 snapshot_sha256 text not null check(snapshot_sha256=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')),
 unique(inquiry_id,version), unique(id,inquiry_id)
);
create table public.pa_contract_receipts (
 contract_id uuid primary key references public.pa_contracts(id) on delete restrict,
 pdf bytea not null check(octet_length(pdf) between 20 and 3145728),
 sha256 text not null check(sha256=encode(sha256(pdf),'hex')),
 cover_pages integer not null check(cover_pages>0),
 quote_pages integer not null check(quote_pages>0),
 created_at timestamptz not null default now()
);
create table public.pa_contract_deliveries (
 id uuid primary key,
 contract_id uuid not null references public.pa_contracts(id) on delete restrict,
 actor_id uuid not null references auth.users(id),
 status text not null check(status in ('sending','sent','failed','uncertain')),
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 gmail_message_id text,
 error_code text,
 acknowledged_duplicate_risk boolean not null default false
);
alter table public.pa_case_progress add column formal_contract_id uuid references public.pa_contracts(id) on delete restrict;

create function public.pa_contract_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'contract_history_immutable' using errcode='42501'; end $$;
create trigger pa_contract_offers_immutable before update or delete on public.pa_contract_offers for each row execute function public.pa_contract_immutable();
create trigger pa_contracts_immutable before update or delete on public.pa_contracts for each row execute function public.pa_contract_immutable();
create trigger pa_contract_receipts_immutable before update or delete on public.pa_contract_receipts for each row execute function public.pa_contract_immutable();
create function public.pa_contract_token_terminal() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'token_history_immutable'; end if;
 if old.state<>'active' or new.state not in ('revoked','accepted') or new.token_hash<>old.token_hash or new.offer_id<>old.offer_id then raise exception 'token_terminal'; end if;
 return new;
end $$;
create trigger pa_contract_tokens_terminal before update or delete on public.pa_contract_tokens for each row execute function public.pa_contract_token_terminal();

alter table public.pa_contract_offers enable row level security;
alter table public.pa_contract_tokens enable row level security;
alter table public.pa_contracts enable row level security;
alter table public.pa_contract_receipts enable row level security;
alter table public.pa_contract_deliveries enable row level security;
revoke all on public.pa_contract_offers,public.pa_contract_tokens,public.pa_contracts,public.pa_contract_receipts,public.pa_contract_deliveries from public,anon,authenticated;
-- API-only access; no browser role can read tokens, documents or mutate contracts.
grant select,insert on public.pa_contract_offers,public.pa_contracts,public.pa_contract_receipts to service_role;
grant select,insert,update on public.pa_contract_tokens,public.pa_contract_deliveries to service_role;

create function public.pa_contract_issue(p_actor uuid,p_id uuid,p_case uuid,p_token_hash text,p_snapshot jsonb,p_quote text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_i public.pa_inquiries%rowtype; v_version integer; v_snapshot jsonb; v_quote bytea; v_expires timestamptz; v_message public.pa_gmail_message_index%rowtype;
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 select * into v_i from public.pa_inquiries where id=p_case and deleted_at is null for update;
 if not found or v_i.status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
 if p_snapshot->>'event_date' is distinct from v_i.event_date::text or p_snapshot->>'event_name' is distinct from v_i.event_name or p_snapshot->>'recipient' is distinct from v_i.email then raise exception 'case_changed'; end if;
 select * into v_message from public.pa_gmail_message_index where inquiry_id=p_case and gmail_message_id=p_snapshot->'quote'->>'gmail_message_id';
 if not found or v_message.direction<>'outbound' or not exists(select 1 from jsonb_array_elements(v_message.attachment_metadata) a where a->>'id'=p_snapshot->'quote'->>'gmail_attachment_id') then raise exception 'quote_case_mismatch'; end if;
 if not exists(select 1 from public.pa_gmail_thread_links where inquiry_id=p_case and gmail_thread_id=v_message.gmail_thread_id and conversation_role='primary_conversation') then raise exception 'quote_case_mismatch'; end if;
 v_quote:=decode(p_quote,'base64');
 if encode(sha256(v_quote),'hex')<>p_snapshot->'quote'->>'sha256' then raise exception 'quote_identity_mismatch'; end if;
 if (p_snapshot->>'amount')::numeric<=0 or length(p_snapshot->>'request_summary') not between 1 and 10000 or length(p_snapshot->>'terms_text') not between 1 and 20000 then raise exception 'invalid_contract'; end if;
 select coalesce(max(version),0)+1 into v_version from public.pa_contract_offers where inquiry_id=p_case;
 v_expires:=(((now() at time zone 'Asia/Tokyo')::date+7)::timestamp at time zone 'Asia/Tokyo');
 v_snapshot:=p_snapshot || jsonb_build_object('case_id',p_case,'contract_id',p_id,'contract_version',v_version,'recipient',v_i.email,'issued_by',p_actor,'issued_at',now(),'expires_at',v_expires);
 update public.pa_contract_tokens t set state='revoked' from public.pa_contract_offers o where t.offer_id=o.id and o.inquiry_id=p_case and t.state='active';
 insert into public.pa_contract_offers values(p_id,p_case,v_version,now(),v_expires,p_actor,v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),v_quote,encode(sha256(v_quote),'hex'));
 insert into public.pa_contract_tokens(offer_id,token_hash) values(p_id,p_token_hash);
 insert into public.pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values(p_case,p_actor,'formal_contract_issued',jsonb_build_object('contract_id',p_id,'version',v_version,'quote_sha256',encode(sha256(v_quote),'hex')));
 return jsonb_build_object('id',p_id,'version',v_version,'expires_at',v_expires);
end $$;

create function public.pa_contract_accept(p_token_hash text,p_offer_id uuid,p_snapshot_sha256 text,p_name text,p_agree boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_o public.pa_contract_offers%rowtype; v_state text; v_snapshot jsonb; v_now timestamptz:=clock_timestamp(); v_status text;
begin
 select o.* into v_o from public.pa_contract_offers o join public.pa_contract_tokens t on t.offer_id=o.id where t.token_hash=p_token_hash;
 if not found or v_o.id<>p_offer_id then raise exception 'invalid_link'; end if;
 -- Issue/reissue and acceptance serialize on the same case lock.
 select status into v_status from public.pa_inquiries where id=v_o.inquiry_id and deleted_at is null for update;
 if not found or v_status in ('closed','cancelled','declined','schedule_unavailable') then raise exception 'case_unavailable'; end if;
 select state into v_state from public.pa_contract_tokens where offer_id=v_o.id for update;
 if v_state='accepted' then return jsonb_build_object('state','accepted','id',v_o.id); end if;
 if v_state<>'active' then raise exception 'invalid_link'; end if;
 -- Check clock after acquiring locks, not transaction-start time.
 v_now:=clock_timestamp();
 if v_now>=v_o.expires_at then raise exception 'expired_link'; end if;
 if p_snapshot_sha256 is distinct from v_o.snapshot_sha256 then raise exception 'contract_changed'; end if;
 if p_agree is distinct from true or p_name is null or length(trim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' then raise exception 'consent_required'; end if;
 if v_o.quote_sha256<>encode(sha256(v_o.quote_pdf),'hex') then raise exception 'quote_identity_mismatch'; end if;
 v_snapshot:=v_o.snapshot || jsonb_build_object('confirmer_name',trim(p_name),'confirmed_at',v_now,'confirmed_at_jst',to_char(v_now at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:MI:SS')||' JST','agreed',true);
 insert into public.pa_contracts values(v_o.id,v_o.inquiry_id,v_o.version,v_now,v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'));
 update public.pa_contract_tokens set state='accepted' where offer_id=v_o.id;
 update public.pa_case_progress set formal_contract_id=v_o.id,booking_confirmed_on=(v_now at time zone 'Asia/Tokyo')::date,estimate_approved_on=(v_now at time zone 'Asia/Tokyo')::date,confirmed_event_date=(v_snapshot->>'event_date')::date,estimate_amount=(v_snapshot->>'amount')::numeric,current_step=greatest(current_step,9),updated_at=v_now where inquiry_id=v_o.inquiry_id;
 insert into public.pa_inquiry_audit(inquiry_id,action,details) values(v_o.inquiry_id,'formal_contract_accepted',jsonb_build_object('contract_id',v_o.id,'version',v_o.version,'confirmed_at',v_now));
 return jsonb_build_object('state','accepted','id',v_o.id);
end $$;

create function public.pa_contract_delivery_claim(p_actor uuid,p_case uuid,p_contract uuid,p_attempt uuid,p_ack boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_previous public.pa_contract_deliveries%rowtype;
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 perform 1 from public.pa_contracts where id=p_contract and inquiry_id=p_case for update;
 if not found or not exists(select 1 from public.pa_contract_receipts where contract_id=p_contract) then raise exception 'receipt_unavailable'; end if;
 if exists(select 1 from public.pa_contract_deliveries where id=p_attempt) then raise exception 'delivery_replay'; end if;
 select * into v_previous from public.pa_contract_deliveries where contract_id=p_contract order by created_at desc,id desc limit 1;
 if v_previous.status='sending' then raise exception 'delivery_in_progress'; end if;
 if v_previous.status in ('sent','uncertain') and p_ack is distinct from true then raise exception 'resend_ack_required'; end if;
 insert into public.pa_contract_deliveries(id,contract_id,actor_id,status,acknowledged_duplicate_risk) values(p_attempt,p_contract,p_actor,'sending',coalesce(p_ack,false));
 return jsonb_build_object('id',p_attempt,'status','sending');
end $$;

-- A worker may crash after Gmail acceptance. Do not automatically resend.
create function public.pa_contract_delivery_uncertain(p_actor uuid,p_case uuid,p_contract uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.work_admins where user_id=p_actor) then raise exception 'not_authorized'; end if;
 perform 1 from public.pa_contracts where id=p_contract and inquiry_id=p_case for update;
 if not found then raise exception 'invalid_contract'; end if;
 update public.pa_contract_deliveries set status='uncertain',finished_at=now(),error_code='worker_outcome_unknown' where contract_id=p_contract and status='sending' and created_at<now()-interval '10 minutes';
end $$;

-- Preserve a formal-order fact when legacy workflow editors update progress.
create function public.pa_contract_progress_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
 select id into v_id from public.pa_contracts where inquiry_id=new.inquiry_id order by version desc limit 1;
 if v_id is not null then
  new.formal_contract_id:=v_id;
  new.current_step:=greatest(new.current_step,9);
 elsif new.formal_contract_id is not null then raise exception 'formal_contract_missing'; end if;
 return new;
end $$;
create trigger pa_contract_progress_guard before insert or update on public.pa_case_progress for each row execute function public.pa_contract_progress_guard();

revoke all on function public.pa_contract_issue(uuid,uuid,uuid,text,jsonb,text),public.pa_contract_accept(text,uuid,text,text,boolean),public.pa_contract_delivery_claim(uuid,uuid,uuid,uuid,boolean),public.pa_contract_delivery_uncertain(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.pa_contract_issue(uuid,uuid,uuid,text,jsonb,text),public.pa_contract_accept(text,uuid,text,text,boolean),public.pa_contract_delivery_claim(uuid,uuid,uuid,uuid,boolean),public.pa_contract_delivery_uncertain(uuid,uuid,uuid) to service_role;
revoke all on function public.pa_contract_immutable(),public.pa_contract_token_terminal(),public.pa_contract_progress_guard() from public,anon,authenticated;
commit;

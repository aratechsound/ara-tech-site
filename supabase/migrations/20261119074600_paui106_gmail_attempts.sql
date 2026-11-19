begin;

-- Store the smallest evidence needed to prove a Gmail SENT message on readback.
-- No message content, recipient address, attachment bytes, or credentials.
create table public.pa_mail_send_attempts (
  operation_key text primary key check (operation_key ~ '^[a-f0-9]{64}$'),
  inquiry_id uuid not null,
  actor_id uuid not null,
  outbox_id uuid unique,
  lookup_key text check (lookup_key ~ '^[a-f0-9]{64}$'),
  rfc_message_id text not null unique,
  envelope_hash text not null check (envelope_hash ~ '^[a-f0-9]{64}$'),
  thread_id text,
  started_at timestamptz not null default now(),
  unique (inquiry_id, actor_id, lookup_key),
  check ((outbox_id is null) or (lookup_key is null))
);

alter table public.pa_mail_send_attempts enable row level security;
revoke all on public.pa_mail_send_attempts from public, anon, authenticated;
grant select, insert on public.pa_mail_send_attempts to service_role;
commit;

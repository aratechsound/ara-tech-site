begin;

alter table public.pa_mail_send_attempts
  add column snapshot_ciphertext text,
  add column resend_of text unique references public.pa_mail_send_attempts(operation_key),
  add column resend_root text references public.pa_mail_send_attempts(operation_key),
  add column resend_number integer not null default 0,
  add constraint pa_mail_resend_binding check (
    (resend_of is null and resend_root is null and resend_number = 0)
    or
    (resend_of is not null and resend_root is not null and resend_number > 0
     and outbox_id is null and lookup_key is null and snapshot_ciphertext is not null)
  ),
  add constraint pa_mail_resend_sequence unique (resend_root, resend_number);

revoke all on public.pa_mail_send_attempts from public, anon, authenticated, service_role;
grant select, insert on public.pa_mail_send_attempts to service_role;

create table public.pa_mail_send_results (
  operation_key text primary key references public.pa_mail_send_attempts(operation_key),
  state text not null check (state in ('sent','unknown')),
  gmail_message_id text,
  gmail_thread_id text,
  recorded_at timestamptz not null default now(),
  check ((state = 'sent') = (gmail_message_id is not null and gmail_thread_id is not null))
);
alter table public.pa_mail_send_results enable row level security;
revoke all on public.pa_mail_send_results from public, anon, authenticated, service_role;
grant select, insert on public.pa_mail_send_results to service_role;

commit;

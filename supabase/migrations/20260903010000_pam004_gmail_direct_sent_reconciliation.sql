-- PAM-004: exact Gmail Sent identity is indexed without changing PA workflow.
begin;

do $$
begin
  if to_regclass('public.pa_gmail_message_index') is null
    or to_regclass('public.pa_inquiries') is null
    or to_regprocedure('public.is_work_admin()') is null then
    raise exception 'PAM-004 requires PAM-002 Gmail message index and PA admin schema';
  end if;
end;
$$;

alter table public.pa_gmail_message_index
  add column if not exists message_source text not null default 'gmail_received'
    check (message_source in ('gmail_received', 'gmail_direct', 'pa_case_manager'));

create table public.pa_estimate_submission_reconciliations (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  gmail_message_id text not null references public.pa_gmail_message_index(gmail_message_id) on delete restrict,
  reconciled_by uuid references auth.users(id) on delete set null,
  reconciled_at timestamptz not null default now(),
  unique (inquiry_id, gmail_message_id)
);

alter table public.pa_estimate_submission_reconciliations enable row level security;
create policy "PA admins read estimate submission reconciliations"
  on public.pa_estimate_submission_reconciliations for select to authenticated
  using (public.is_work_admin());
revoke all on public.pa_estimate_submission_reconciliations from anon, authenticated;
grant select on public.pa_estimate_submission_reconciliations to authenticated;

comment on column public.pa_gmail_message_index.message_source is
  'Source is classified only from Gmail message identity and PA-managed-send audit identity.';
comment on table public.pa_estimate_submission_reconciliations is
  'Explicit idempotent reconciliation of an exact Gmail-direct Sent message; it does not change workflow stage itself.';

commit;

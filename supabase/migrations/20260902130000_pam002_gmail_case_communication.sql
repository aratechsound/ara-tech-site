-- PAM-002
-- Gmail is the mail-system authority. These tables are an admin-only case index,
-- link audit and attention cache; they do not store OAuth credentials or advance workflow.

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regclass('public.pa_email_deliveries') is null
    or to_regclass('public.pa_inquiry_audit') is null
    or to_regprocedure('public.is_work_admin()') is null then
    raise exception 'PAM-002 requires PA inquiry, Gmail delivery, audit and admin schema';
  end if;
end;
$$;

create table public.pa_gmail_thread_links (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  gmail_thread_id text not null check (gmail_thread_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  link_source text not null check (link_source in ('delivery_history', 'gmail_message_id', 'case_reference', 'manual')),
  linked_at timestamptz not null default now(),
  linked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (inquiry_id, gmail_thread_id),
  unique (gmail_thread_id)
);

create index pa_gmail_thread_links_case_idx
  on public.pa_gmail_thread_links(inquiry_id, linked_at desc);

create table public.pa_gmail_message_index (
  gmail_message_id text primary key check (gmail_message_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  gmail_thread_id text not null check (gmail_thread_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  inquiry_id uuid not null references public.pa_inquiries(id) on delete restrict,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_address text not null check (char_length(from_address) between 1 and 320),
  to_addresses jsonb not null default '[]'::jsonb check (jsonb_typeof(to_addresses) = 'array'),
  cc_addresses jsonb not null default '[]'::jsonb check (jsonb_typeof(cc_addresses) = 'array'),
  subject text not null default '' check (char_length(subject) <= 500),
  sent_at timestamptz,
  received_at timestamptz,
  attachment_metadata jsonb not null default '[]'::jsonb check (jsonb_typeof(attachment_metadata) = 'array'),
  indexed_at timestamptz not null default now(),
  unique (inquiry_id, gmail_message_id)
);

create index pa_gmail_message_index_case_time_idx
  on public.pa_gmail_message_index(inquiry_id, coalesce(received_at, sent_at) desc);

create table public.pa_case_mail_attention (
  inquiry_id uuid primary key references public.pa_inquiries(id) on delete restrict,
  attention_state text not null default 'none'
    check (attention_state in ('new_customer_reply', 'ara_reply_pending', 'waiting_customer', 'handled', 'none')),
  last_seen_inbound_at timestamptz,
  handled_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text check (last_sync_error is null or char_length(last_sync_error) <= 200),
  updated_at timestamptz not null default now()
);

alter table public.pa_gmail_thread_links enable row level security;
alter table public.pa_gmail_message_index enable row level security;
alter table public.pa_case_mail_attention enable row level security;

create policy "PA admins read Gmail thread links"
  on public.pa_gmail_thread_links for select to authenticated
  using (public.is_work_admin());
create policy "PA admins read Gmail message index"
  on public.pa_gmail_message_index for select to authenticated
  using (public.is_work_admin());
create policy "PA admins read Gmail mail attention"
  on public.pa_case_mail_attention for select to authenticated
  using (public.is_work_admin());

revoke all on public.pa_gmail_thread_links from anon, authenticated;
revoke all on public.pa_gmail_message_index from anon, authenticated;
revoke all on public.pa_case_mail_attention from anon, authenticated;
grant select on public.pa_gmail_thread_links to authenticated;
grant select on public.pa_gmail_message_index to authenticated;
grant select on public.pa_case_mail_attention to authenticated;

comment on table public.pa_gmail_thread_links is
  'Gmail thread and PA case link authority. A Gmail thread can link to only one PA case; address-only matching is forbidden.';
comment on table public.pa_gmail_message_index is
  'Gmail message metadata cache/index. Gmail remains the body, attachment and delivery authority.';
comment on table public.pa_case_mail_attention is
  'Mail attention state separate from PA workflow state. Sync must not advance workflow.';

commit;

-- PAM-002 conversation authority
-- Adds roles only. Existing Gmail links retain their identity as secondary links;
-- no case, delivery, workflow or Gmail data is rewritten.

begin;

do $$
begin
  if to_regclass('public.pa_gmail_thread_links') is null then
    raise exception 'PAM-002 conversation authority requires pa_gmail_thread_links';
  end if;
end;
$$;

alter table public.pa_gmail_thread_links
  add column conversation_role text not null default 'secondary_conversation'
    check (conversation_role in ('primary_conversation', 'secondary_conversation', 'system_acknowledgement'));

create unique index pa_gmail_thread_links_one_primary_per_case_idx
  on public.pa_gmail_thread_links (inquiry_id)
  where conversation_role = 'primary_conversation';

comment on column public.pa_gmail_thread_links.conversation_role is
  'Conversation authority: exactly one primary conversation per case; secondary conversations and system acknowledgements remain separately linked.';

commit;

-- ARA-20260724-010
-- Shared, atomic rate limiting for PA API handlers.
-- The table is private and the RPC is callable only by service_role.

begin;

create table if not exists public.api_rate_limit_buckets
(
  bucket_key text primary key
    check (char_length(bucket_key) between 1 and 255),
  window_ms integer not null
    check (window_ms between 1000 and 86400000),
  window_started_at timestamptz not null,
  window_expires_at timestamptz not null,
  request_count integer not null default 0
    check (request_count >= 0),
  created_at timestamptz not null default now(),
  last_hit_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists api_rate_limit_buckets_expires_idx
  on public.api_rate_limit_buckets (window_expires_at);

alter table public.api_rate_limit_buckets enable row level security;

comment on table public.api_rate_limit_buckets is
  'Private durable counters used by service-role PA API rate limiting.';

comment on column public.api_rate_limit_buckets.bucket_key is
  'Opaque HMAC-derived API bucket identifier; raw client addresses are not stored.';

create or replace function public.consume_rate_limit(
  p_bucket_key text,
  p_window_ms integer,
  p_limit integer
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer,
  reset_at timestamptz,
  "limit" integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket_key text := btrim(p_bucket_key);
  v_now timestamptz := clock_timestamp();
  v_bucket public.api_rate_limit_buckets%rowtype;
begin
  if v_bucket_key is null
    or char_length(v_bucket_key) < 1
    or char_length(v_bucket_key) > 255
  then
    raise exception 'invalid rate-limit bucket';
  end if;

  if p_window_ms is null or p_window_ms < 1000 or p_window_ms > 86400000 then
    raise exception 'invalid rate-limit window';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 1000000 then
    raise exception 'invalid rate-limit limit';
  end if;

  insert into public.api_rate_limit_buckets as bucket (
    bucket_key,
    window_ms,
    window_started_at,
    window_expires_at,
    request_count,
    created_at,
    last_hit_at,
    updated_at
  )
  values (
    v_bucket_key,
    p_window_ms,
    v_now,
    v_now + (p_window_ms * interval '1 millisecond'),
    1,
    v_now,
    v_now,
    v_now
  )
  on conflict (bucket_key) do update
  set
    window_ms = case
      when bucket.window_expires_at <= v_now then excluded.window_ms
      else bucket.window_ms
    end,
    window_started_at = case
      when bucket.window_expires_at <= v_now then v_now
      else bucket.window_started_at
    end,
    window_expires_at = case
      when bucket.window_expires_at <= v_now
        then v_now + (excluded.window_ms * interval '1 millisecond')
      else bucket.window_expires_at
    end,
    request_count = case
      when bucket.window_expires_at <= v_now then 1
      else least(bucket.request_count + 1, 2147483647)
    end,
    last_hit_at = v_now,
    updated_at = v_now
  returning bucket.*
  into v_bucket;

  allowed := v_bucket.request_count <= p_limit;
  remaining := greatest(0, p_limit - v_bucket.request_count);
  retry_after_seconds := case
    when allowed then 0
    else greatest(
      1,
      ceil(extract(epoch from (v_bucket.window_expires_at - v_now)))::integer
    )
  end;
  reset_at := v_bucket.window_expires_at;
  "limit" := p_limit;
  return next;
end;
$$;

comment on function public.consume_rate_limit(text, integer, integer) is
  'Atomically consumes a shared PA API rate-limit counter. service_role only.';

revoke all on table public.api_rate_limit_buckets from public, anon, authenticated;
revoke all on function public.consume_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer)
  to service_role;

commit;

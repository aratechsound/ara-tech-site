-- ARA-TECH Stage Plot persistence Phase 1A.
-- Editable JSON is canonical; rendered PDF/PNG and portal document versions are not.

begin;

do $$
begin
  if to_regclass('public.pa_inquiries') is null
    or to_regprocedure('public.is_work_admin()') is null then
    raise exception 'Stage Plot persistence requires PA inquiries and admin authority';
  end if;
end;
$$;

create table if not exists public.pa_stage_plots (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.pa_inquiries(id) on delete restrict,
  schema_version integer not null check (schema_version between 1 and 100000),
  performer_name text not null default '' check (char_length(performer_name) <= 240),
  performer_order text check (performer_order is null or char_length(performer_order) <= 120),
  performance_time text check (performance_time is null or char_length(performance_time) <= 120),
  duration_minutes integer check (duration_minutes is null or duration_minutes between 0 and 1440),
  state jsonb not null,
  current_revision integer not null default 1 check (current_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  updated_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  constraint pa_stage_plots_state_object check (jsonb_typeof(state) = 'object'),
  constraint pa_stage_plots_state_size check (octet_length(state::text) <= 3145728),
  constraint pa_stage_plots_schema_version_matches_state check (
    case
      when jsonb_typeof(state->'schemaVersion') = 'number'
        and (state->>'schemaVersion') ~ '^[1-9][0-9]*$'
      then (state->>'schemaVersion')::integer = schema_version
      else false
    end
  )
);

create table if not exists public.pa_stage_plot_revisions (
  id uuid primary key default gen_random_uuid(),
  stage_plot_id uuid not null references public.pa_stage_plots(id) on delete restrict,
  revision_no integer not null check (revision_no > 0),
  schema_version integer not null check (schema_version between 1 and 100000),
  state jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  constraint pa_stage_plot_revisions_state_object check (jsonb_typeof(state) = 'object'),
  constraint pa_stage_plot_revisions_state_size check (octet_length(state::text) <= 3145728),
  constraint pa_stage_plot_revisions_schema_version_matches_state check (
    case
      when jsonb_typeof(state->'schemaVersion') = 'number'
        and (state->>'schemaVersion') ~ '^[1-9][0-9]*$'
      then (state->>'schemaVersion')::integer = schema_version
      else false
    end
  ),
  unique (stage_plot_id, revision_no)
);

create index if not exists pa_stage_plots_case_updated_idx
  on public.pa_stage_plots(case_id, updated_at desc, id);
create index if not exists pa_stage_plot_revisions_history_idx
  on public.pa_stage_plot_revisions(stage_plot_id, revision_no desc);

create or replace function public.pa_stage_plot_revision_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'stage_plot_revision_immutable';
end;
$$;

drop trigger if exists pa_stage_plot_revisions_immutable on public.pa_stage_plot_revisions;
create trigger pa_stage_plot_revisions_immutable
before update or delete on public.pa_stage_plot_revisions
for each row execute function public.pa_stage_plot_revision_immutable();

alter table public.pa_stage_plots enable row level security;
alter table public.pa_stage_plot_revisions enable row level security;

drop policy if exists "PA admins read stage plots" on public.pa_stage_plots;
drop policy if exists "PA admins read stage plot revisions" on public.pa_stage_plot_revisions;
create policy "PA admins read stage plots"
on public.pa_stage_plots for select to authenticated
using (
  public.is_work_admin()
  and exists (
    select 1 from public.pa_inquiries i
    where i.id = pa_stage_plots.case_id and i.deleted_at is null
  )
);
create policy "PA admins read stage plot revisions"
on public.pa_stage_plot_revisions for select to authenticated
using (
  public.is_work_admin()
  and exists (
    select 1
    from public.pa_stage_plots p
    join public.pa_inquiries i on i.id = p.case_id and i.deleted_at is null
    where p.id = pa_stage_plot_revisions.stage_plot_id
  )
);

revoke all on public.pa_stage_plots, public.pa_stage_plot_revisions from public, anon, authenticated;
grant select on public.pa_stage_plots, public.pa_stage_plot_revisions to authenticated;

create or replace function public.pa_stage_plot_create(p_case_id uuid, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_plot public.pa_stage_plots%rowtype;
  v_schema_version integer;
  v_duration integer;
  v_duration_text text;
begin
  if v_actor is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if not exists(select 1 from public.pa_inquiries where id = p_case_id and deleted_at is null) then
    raise exception 'inquiry_not_found';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object'
    or jsonb_typeof(p_state->'schemaVersion') <> 'number'
    or (p_state->>'schemaVersion') !~ '^[1-9][0-9]*$'
    or char_length(p_state->>'schemaVersion') > 6
    or octet_length(p_state::text) > 3145728 then
    raise exception 'invalid_stage_plot_state';
  end if;
  v_schema_version := (p_state->>'schemaVersion')::integer;
  if v_schema_version > 100000
    or char_length(coalesce(p_state#>>'{metadata,performerName}','')) > 240
    or char_length(coalesce(p_state#>>'{metadata,performanceOrder}','')) > 120
    or char_length(coalesce(p_state#>>'{metadata,performanceTime}','')) > 120 then
    raise exception 'invalid_stage_plot_state';
  end if;
  v_duration_text := nullif(btrim(coalesce(p_state#>>'{metadata,durationMinutes}','')), '');
  if v_duration_text is not null then
    if v_duration_text !~ '^[0-9]{1,4}$' then raise exception 'invalid_stage_plot_state'; end if;
    v_duration := v_duration_text::integer;
  else
    v_duration_text := substring(coalesce(p_state#>>'{metadata,allottedTime}','') from '^[[:space:]]*([0-9]{1,4})[[:space:]]*分?[[:space:]]*$');
    if v_duration_text is not null then v_duration := v_duration_text::integer; end if;
  end if;
  if v_duration is not null and v_duration > 1440 then raise exception 'invalid_stage_plot_state'; end if;

  insert into public.pa_stage_plots(
    case_id, schema_version, performer_name, performer_order, performance_time,
    duration_minutes, state, current_revision, created_by, updated_by
  ) values (
    p_case_id,
    v_schema_version,
    coalesce(p_state#>>'{metadata,performerName}',''),
    nullif(p_state#>>'{metadata,performanceOrder}', ''),
    nullif(p_state#>>'{metadata,performanceTime}', ''),
    v_duration,
    p_state,
    1,
    v_actor,
    v_actor
  ) returning * into v_plot;

  insert into public.pa_stage_plot_revisions(
    stage_plot_id, revision_no, schema_version, state, created_by
  ) values (v_plot.id, 1, v_schema_version, p_state, v_actor);

  return to_jsonb(v_plot);
end;
$$;

create or replace function public.pa_stage_plot_get(p_case_id uuid, p_stage_plot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_plot public.pa_stage_plots%rowtype;
begin
  if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  select * into v_plot
  from public.pa_stage_plots
  where id = p_stage_plot_id and case_id = p_case_id;
  if not found then
    if exists(select 1 from public.pa_stage_plots where id = p_stage_plot_id) then
      raise exception 'stage_plot_case_mismatch';
    end if;
    raise exception 'stage_plot_not_found';
  end if;
  if not exists(select 1 from public.pa_inquiries where id = p_case_id and deleted_at is null) then
    raise exception 'inquiry_not_found';
  end if;
  return to_jsonb(v_plot);
end;
$$;

create or replace function public.pa_stage_plot_list(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if not exists(select 1 from public.pa_inquiries where id = p_case_id and deleted_at is null) then
    raise exception 'inquiry_not_found';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(p) - 'state' order by p.updated_at desc, p.id)
    from public.pa_stage_plots p where p.case_id = p_case_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.pa_stage_plot_save(p_case_id uuid, p_stage_plot_id uuid, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_plot public.pa_stage_plots%rowtype;
  v_schema_version integer;
  v_next_revision integer;
  v_duration integer;
  v_duration_text text;
begin
  if v_actor is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object'
    or jsonb_typeof(p_state->'schemaVersion') <> 'number'
    or (p_state->>'schemaVersion') !~ '^[1-9][0-9]*$'
    or char_length(p_state->>'schemaVersion') > 6
    or octet_length(p_state::text) > 3145728 then
    raise exception 'invalid_stage_plot_state';
  end if;
  v_schema_version := (p_state->>'schemaVersion')::integer;
  if v_schema_version > 100000
    or char_length(coalesce(p_state#>>'{metadata,performerName}','')) > 240
    or char_length(coalesce(p_state#>>'{metadata,performanceOrder}','')) > 120
    or char_length(coalesce(p_state#>>'{metadata,performanceTime}','')) > 120 then
    raise exception 'invalid_stage_plot_state';
  end if;
  v_duration_text := nullif(btrim(coalesce(p_state#>>'{metadata,durationMinutes}','')), '');
  if v_duration_text is not null then
    if v_duration_text !~ '^[0-9]{1,4}$' then raise exception 'invalid_stage_plot_state'; end if;
    v_duration := v_duration_text::integer;
  else
    v_duration_text := substring(coalesce(p_state#>>'{metadata,allottedTime}','') from '^[[:space:]]*([0-9]{1,4})[[:space:]]*分?[[:space:]]*$');
    if v_duration_text is not null then v_duration := v_duration_text::integer; end if;
  end if;
  if v_duration is not null and v_duration > 1440 then raise exception 'invalid_stage_plot_state'; end if;

  select * into v_plot
  from public.pa_stage_plots
  where id = p_stage_plot_id and case_id = p_case_id
  for update;
  if not found then
    if exists(select 1 from public.pa_stage_plots where id = p_stage_plot_id) then
      raise exception 'stage_plot_case_mismatch';
    end if;
    raise exception 'stage_plot_not_found';
  end if;
  if not exists(select 1 from public.pa_inquiries where id = p_case_id and deleted_at is null) then
    raise exception 'inquiry_not_found';
  end if;

  v_next_revision := v_plot.current_revision + 1;
  update public.pa_stage_plots set
    schema_version = v_schema_version,
    performer_name = coalesce(p_state#>>'{metadata,performerName}',''),
    performer_order = nullif(p_state#>>'{metadata,performanceOrder}', ''),
    performance_time = nullif(p_state#>>'{metadata,performanceTime}', ''),
    duration_minutes = v_duration,
    state = p_state,
    current_revision = v_next_revision,
    updated_at = now(),
    updated_by = v_actor
  where id = v_plot.id
  returning * into v_plot;

  insert into public.pa_stage_plot_revisions(
    stage_plot_id, revision_no, schema_version, state, created_by
  ) values (v_plot.id, v_next_revision, v_schema_version, p_state, v_actor);

  return to_jsonb(v_plot);
end;
$$;

create or replace function public.pa_stage_plot_revision_list(p_case_id uuid, p_stage_plot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if not exists(
    select 1 from public.pa_stage_plots p
    join public.pa_inquiries i on i.id = p.case_id and i.deleted_at is null
    where p.id = p_stage_plot_id and p.case_id = p_case_id
  ) then
    if exists(select 1 from public.pa_stage_plots where id = p_stage_plot_id) then
      raise exception 'stage_plot_case_mismatch';
    end if;
    raise exception 'stage_plot_not_found';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) - 'state' order by r.revision_no desc)
    from public.pa_stage_plot_revisions r where r.stage_plot_id = p_stage_plot_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.pa_stage_plot_revision_get(
  p_case_id uuid,
  p_stage_plot_id uuid,
  p_revision_no integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_revision public.pa_stage_plot_revisions%rowtype;
begin
  if auth.uid() is null or not public.is_work_admin() then raise exception 'not_authorized'; end if;
  if not exists(
    select 1 from public.pa_stage_plots p
    join public.pa_inquiries i on i.id = p.case_id and i.deleted_at is null
    where p.id = p_stage_plot_id and p.case_id = p_case_id
  ) then
    if exists(select 1 from public.pa_stage_plots where id = p_stage_plot_id) then
      raise exception 'stage_plot_case_mismatch';
    end if;
    raise exception 'stage_plot_not_found';
  end if;
  select * into v_revision
  from public.pa_stage_plot_revisions
  where stage_plot_id = p_stage_plot_id and revision_no = p_revision_no;
  if not found then raise exception 'stage_plot_revision_not_found'; end if;
  return to_jsonb(v_revision);
end;
$$;

revoke all on function public.pa_stage_plot_create(uuid,jsonb),
  public.pa_stage_plot_get(uuid,uuid),
  public.pa_stage_plot_list(uuid),
  public.pa_stage_plot_save(uuid,uuid,jsonb),
  public.pa_stage_plot_revision_list(uuid,uuid),
  public.pa_stage_plot_revision_get(uuid,uuid,integer)
from public, anon;

grant execute on function public.pa_stage_plot_create(uuid,jsonb),
  public.pa_stage_plot_get(uuid,uuid),
  public.pa_stage_plot_list(uuid),
  public.pa_stage_plot_save(uuid,uuid,jsonb),
  public.pa_stage_plot_revision_list(uuid,uuid),
  public.pa_stage_plot_revision_get(uuid,uuid,integer)
to authenticated;

commit;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PA_PGLITE_MODULE || '@electric-sql/pglite');
const root = path.resolve(__dirname, '../..');
const read = (name) => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const migrationName = '20260903020000_pam005_atomic_estimate_reconciliation.sql';
const actorId = '123e4567-e89b-42d3-a456-426614174001';
const inquiryId = '123e4567-e89b-42d3-a456-426614174000';
const otherId = '223e4567-e89b-42d3-a456-426614174000';
const sentAt = '2026-09-01T12:00:00.000Z';
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function createDatabase({ migrate = true } = {}) {
    const db = new PGlite();
    await db.exec(`
        create role anon;
        create role authenticated;
        create schema auth;
        create table auth.users(id uuid primary key);
        insert into auth.users values ('${actorId}');
        create function auth.jwt() returns jsonb language sql stable as $$
          select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
        $$;
        create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
        create function public.is_work_admin() returns boolean language sql stable as $$
          select coalesce(auth.uid() = '${actorId}'::uuid, false);
        $$;
        select set_config('request.jwt.claims', '{"sub":"${actorId}","email":"fixture@example.invalid"}', false);
        create table public.pa_inquiries (
          id uuid primary key, status text not null, schedule_state text,
          deleted_at timestamptz, updated_at timestamptz not null default now()
        );
        create table public.pa_inquiry_audit (
          id uuid primary key default gen_random_uuid(), inquiry_id uuid references public.pa_inquiries(id),
          actor_user_id uuid references auth.users(id), action text, details jsonb,
          occurred_at timestamptz not null default now()
        );
        create table public.pa_email_deliveries (id uuid primary key);
    `);
    // Execute the complete repository migrations; only auth/inquiry prerequisites
    // above are synthetic. No production endpoint or credentials are used.
    for (const name of [
        '2026-07-24-pa-case-progress.sql',
        '20260902103000_pam001_workflow_projection.sql',
        '20260902130000_pam002_gmail_case_communication.sql',
        '20260902143000_pam002_gmail_conversation_authority.sql',
        '20260902170000_pam003_estimate_submission_projection.sql',
        '20260903010000_pam004_gmail_direct_sent_reconciliation.sql'
    ]) await db.exec(read(name));
    await db.query(`insert into public.pa_inquiries(id,status) values ($1,'rough_estimate'),($2,'schedule_confirmed')`, [inquiryId, otherId]);
    await db.query(`update public.pa_case_progress set estimate_created_on='2026-09-01' where inquiry_id in ($1,$2)`, [inquiryId, otherId]);
    await db.query(`insert into public.pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role)
        values ($1,'thread_123','manual','primary_conversation'),($2,'thread_other','manual','primary_conversation')`, [inquiryId, otherId]);
    await db.query(`insert into public.pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,message_source,sent_at)
        values ('direct_sent_001','thread_123',$1,'outbound','sender@example.invalid','gmail_direct',$2),
        ('other_case_message','thread_other',$3,'outbound','sender@example.invalid','gmail_direct',$2)`, [inquiryId, sentAt, otherId]);
    if (migrate) await db.exec(read(migrationName));
    return db;
}

async function expectedFor(db, id = inquiryId, messageId = 'direct_sent_001') {
    const { rows } = await db.query(`select jsonb_build_object(
      'status', i.status, 'case_updated_at', i.updated_at, 'progress_updated_at', p.updated_at,
      'estimate_created_on', p.estimate_created_on, 'sent_at', m.sent_at
    ) expected from public.pa_inquiries i join public.pa_case_progress p on p.inquiry_id=i.id
      join public.pa_gmail_message_index m on m.inquiry_id=i.id where i.id=$1 and m.gmail_message_id=$2`, [id, messageId]);
    assert.equal(rows.length, 1);
    return rows[0].expected;
}

async function invoke(db, { inquiry = inquiryId, message = 'direct_sent_001', thread = 'thread_123', expected } = {}) {
    const payload = expected || await expectedFor(db, inquiry, message);
    const { rows } = await db.query('select public.reconcile_pa_estimate_submission($1,$2,$3,$4::jsonb) result', [inquiry, message, thread, JSON.stringify(payload)]);
    return rows[0].result;
}

const rpcFetch = (db) => async (target, options) => {
    assert.equal(new URL(target).pathname, '/rest/v1/rpc/reconcile_pa_estimate_submission');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer fixture-user-jwt', 'RPC must use the verified user JWT, never service-role authority');
    const input = JSON.parse(options.body);
    assert(!Object.hasOwn(input, 'actorId'));
    try {
        return json(await invoke(db, { inquiry: input.p_inquiry_id, message: input.p_gmail_message_id, thread: input.p_gmail_thread_id, expected: input.p_expected }));
    } catch (error) {
        return json({ code: error.code }, error.code === '42501' ? 403 : 400);
    }
};

async function state(db, id = inquiryId) {
    return (await db.query(`select jsonb_build_object(
      'case', (select to_jsonb(i) from public.pa_inquiries i where i.id=$1),
      'progress', (select to_jsonb(p) from public.pa_case_progress p where p.inquiry_id=$1),
      'reconciliations', (select coalesce(jsonb_agg(to_jsonb(r) order by r.gmail_message_id),'[]') from public.pa_estimate_submission_reconciliations r where r.inquiry_id=$1),
      'audit', (select coalesce(jsonb_agg(to_jsonb(a) order by a.occurred_at,a.id),'[]') from public.pa_inquiry_audit a where a.inquiry_id=$1)
    ) result`, [id])).rows[0].result;
}

module.exports = { createDatabase, expectedFor, invoke, rpcFetch, state, read, migrationName, actorId, inquiryId, otherId, sentAt };

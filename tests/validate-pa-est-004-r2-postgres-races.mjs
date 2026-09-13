import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This gate deliberately uses separate psql processes. PGlite and a shared
// client connection are not valid substitutes for this test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(root, 'supabase', 'migrations');
const actor = '123e4567-e89b-42d3-a456-426614174001';
const adminUrl = process.env.PA_EST_004_RACE_ADMIN_URL;
const psql = process.env.PA_EST_004_PSQL_PATH || 'psql';
const evidencePath = process.env.PA_EST_004_RACE_EVIDENCE || path.join(root, 'work', 'pa-est-004-r2-postgres-race-evidence.json');
const waitMs = 850;

if (process.env.PA_EST_004_RACE_ALLOW_DISPOSABLE_CLUSTER !== 'YES') {
  throw new Error('Set PA_EST_004_RACE_ALLOW_DISPOSABLE_CLUSTER=YES only for a disposable local PostgreSQL cluster.');
}
if (!adminUrl) throw new Error('PA_EST_004_RACE_ADMIN_URL is required.');
const parsed = new URL(adminUrl);
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('PostgreSQL URL required.');
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('Refusing non-local PostgreSQL host.');
if (spawnSync(psql, ['--version'], { encoding: 'utf8', windowsHide: true }).status !== 0) throw new Error('psql is unavailable.');

const database = `pa_est_004_race_${crypto.randomBytes(6).toString('hex')}`;
const baseEnv = {
  ...process.env,
  PGHOST: parsed.hostname.replace(/^\[|\]$/g, ''),
  PGPORT: parsed.port || '5432',
  PGUSER: decodeURIComponent(parsed.username || 'postgres'),
  PGPASSWORD: decodeURIComponent(parsed.password || ''),
  PGDATABASE: decodeURIComponent(parsed.pathname.slice(1) || 'postgres'),
  PGSSLMODE: parsed.searchParams.get('sslmode') || 'disable'
};
const testEnv = { ...baseEnv, PGDATABASE: database };
const quote = Buffer.from('PA-EST-004R2 isolated PostgreSQL race fixture');
const quote64 = quote.toString('base64');
const quoteSha = crypto.createHash('sha256').update(quote).digest('hex');
const migrationNames = [
  '2026-07-24-pa-case-progress.sql',
  '20260902103000_pam001_workflow_projection.sql',
  '20260902130000_pam002_gmail_case_communication.sql',
  '20260902143000_pam002_gmail_conversation_authority.sql',
  '20260902170000_pam003_estimate_submission_projection.sql',
  '20260903010000_pam004_gmail_direct_sent_reconciliation.sql',
  '20260903020000_pam005_atomic_estimate_reconciliation.sql',
  '20260907130000_pa_formal_contract.sql',
  '20260913110000_pa_case_management_v5.sql',
  '20260913130000_pa_case_management_v5_r1.sql',
  '20260913170000_pa_case_management_v5_payment_race.sql'
];

const lit = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const uuid = () => crypto.randomUUID();
const read = name => fs.readFileSync(path.join(migrations, name), 'utf8');
const sessionPreamble = label => `\\set ON_ERROR_STOP on\nset application_name=${lit(`pa-est-004-r2-${label}`)};\nset lock_timeout='5s';\nset statement_timeout='12s';\nbegin;\nselect 'R2|${label}|BEGIN|'||pg_backend_pid()||'|'||clock_timestamp();\n`;

function runSql(sql, env = testEnv, timeout = 20000) {
  const result = spawnSync(psql, ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], {
    env, input: sql, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function scalar(sql) {
  const output = runSql(sql).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return output.at(-1);
}

function startSession(label, operationSql, { hold = false, rollback = false, failure = false, requireLockMarker = true } = {}) {
  const marker = `R2|${label}|LOCK_HELD|`;
  const sql = sessionPreamble(label)
    + `${operationSql}\nselect '${marker}'||pg_backend_pid()||'|'||clock_timestamp();\n`
    + (hold ? `select pg_sleep(${waitMs / 1000});\n` : '')
    + (failure ? `select 1/0;\n` : '')
    + (rollback ? `rollback;\nselect 'R2|${label}|ROLLBACK|'||pg_backend_pid()||'|'||clock_timestamp();\n` : `commit;\nselect 'R2|${label}|COMMIT|'||pg_backend_pid()||'|'||clock_timestamp();\n`);
  const child = spawn(psql, ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { env: testEnv, windowsHide: true });
  child.stdin.end(sql);
  let stdout = '', stderr = '', markerResolve, markerReject;
  const markerSeen = new Promise((resolve, reject) => { markerResolve = resolve; markerReject = reject; });
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes(marker)) markerResolve(); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const startedAt = Date.now();
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${label} timed out`)); }, 15000);
    child.on('error', error => { clearTimeout(timer); if (requireLockMarker) markerReject(error); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (requireLockMarker && !stdout.includes(marker)) markerReject(new Error(`${label} did not reach lock marker`));
      resolve({ label, code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
  return { markerSeen, done };
}

async function race(name, aSql, bSql, expectations = {}) {
  const a = startSession(`${name}-A`, aSql, { hold: true, rollback: expectations.aRollback, failure: expectations.aFailure });
  await a.markerSeen;
  // A's marker is the synchronization gate. B may be expected to raise while
  // executing the competing operation, before it can emit its post-operation
  // marker; BEGIN/backend identity and connection-exit rollback are still kept.
  const b = startSession(`${name}-B`, bSql, { rollback: expectations.bRollback, requireLockMarker: false });
  const [ar, br] = await Promise.all([a.done, b.done]);
  assert.equal(ar.code, expectations.aCode ?? 0, `${name} session A exit`);
  assert.equal(br.code, expectations.bCode ?? 0, `${name} session B exit: ${br.stderr}`);
  if (expectations.aError) assert.match(ar.stderr, expectations.aError, `${name} expected A error`);
  if (expectations.bError) assert.match(br.stderr, expectations.bError, `${name} expected B error`);
  assert.ok(br.elapsedMs >= waitMs - 150, `${name} session B did not wait on the committed/rolled-back lock (${br.elapsedMs}ms)`);
  return {
    name,
    sessionA: extractSession(ar),
    sessionB: extractSession(br),
    lockWaitObserved: true
  };
}

function extractSession(result) {
  const marks = result.stdout.split(/\r?\n/).map(x => x.trim()).filter(x => x.startsWith('R2|'));
  const begin = marks.find(x => x.includes('|BEGIN|'))?.split('|');
  return {
    identity: begin ? { label: result.label, backendPid: Number(begin[3]), transactionBeganAt: begin[4] } : { label: result.label },
    markers: marks,
    exitCode: result.code,
    elapsedMs: result.elapsedMs,
    outcome: result.code === 0 ? (marks.some(x => x.includes('|ROLLBACK|')) ? 'rollback' : 'commit') : 'connection_exit_rollback',
    error: result.stderr.trim().split(/\r?\n/).at(-1) || null
  };
}

function issueEstimate(caseId, operation, document, expectedRevision = 0, expectedCurrent = null) {
  return `select public.pa_v5_issue_estimate(
    p_actor=>${lit(actor)}::uuid,p_case=>${lit(caseId)}::uuid,p_expected_revision=>${expectedRevision},p_expected_current=>${lit(expectedCurrent)}::uuid,
    p_operation=>${lit(operation)}::uuid,p_document_id=>${lit(document)}::uuid,p_filename=>'race-estimate.pdf',p_mime=>'application/pdf',
    p_content_base64=>${lit(quote64)},p_sha256=>${lit(quoteSha)},p_amount_minor=>100000,p_currency=>'JPY',p_tax_basis=>'tax_included',
    p_conditions=>'{}'::jsonb,p_source_kind=>'managed_send',p_source_sent_at=>null,p_recipient=>'fixture@example.invalid',
    p_subject=>'Race estimate',p_body=>'Isolated race fixture',p_reply_binding=>'{}'::jsonb);`;
}

function issueConfirmation(caseId, estimate, offer, operation, token) {
  return `select public.pa_v5_issue_confirmation(
    p_actor=>${lit(actor)}::uuid,p_case=>${lit(caseId)}::uuid,p_expected_revision=>1,p_estimate=>${lit(estimate)}::uuid,
    p_offer=>${lit(offer)}::uuid,p_operation=>${lit(operation)}::uuid,p_token_hash=>${lit(token)},
    p_secret_envelope=>'isolated-race-envelope-000000000000000000000000000000',
    p_snapshot=>'{"event_name":"Race fixture","event_date":"2026-10-18","amount_minor":100000}'::jsonb,
    p_recipient=>'fixture@example.invalid',p_subject=>'Race confirmation',p_body=>'Isolated race fixture',p_reply_binding=>'{}'::jsonb);`;
}

function insertCase(caseId) {
  runSql(`insert into public.pa_inquiries(id,status,email,customer_name,contact_name,organization_name,event_name,event_date,inquiry_number,request_summary)
    values(${lit(caseId)}::uuid,'rough_estimate','fixture@example.invalid','Fixture','Fixture','Isolated','Race fixture','2026-10-18',${lit(`R2-${caseId.slice(0, 8)}`)},'Isolated local PostgreSQL race fixture');`);
}

function seedEstimate({ finish = true } = {}) {
  const caseId = uuid(), operation = uuid(), document = uuid();
  insertCase(caseId);
  runSql(issueEstimate(caseId, operation, document));
  const estimate = scalar(`select id from public.pa_estimate_revisions where operation_id=${lit(operation)}::uuid;`);
  const outbox = scalar(`select id from public.pa_commercial_outbox where operation_id=${lit(operation)}::uuid;`);
  if (finish) {
    const lease = uuid();
    runSql(`select public.pa_v5_outbox_claim(${lit(actor)}::uuid,${lit(outbox)}::uuid,${lit(lease)}::uuid);
      select public.pa_v5_outbox_finish(${lit(actor)}::uuid,${lit(outbox)}::uuid,${lit(lease)}::uuid,'sent','fixture-message','fixture-thread',null);`);
  }
  return { caseId, estimate, outbox };
}

function seedConfirmation() {
  const seeded = seedEstimate();
  const offer = uuid(), operation = uuid();
  const tokenPlain = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(tokenPlain).digest('hex');
  runSql(issueConfirmation(seeded.caseId, seeded.estimate, offer, operation, tokenHash));
  return { ...seeded, offer, tokenHash, snapshotSha: scalar(`select snapshot_sha256 from public.pa_contract_offers where id=${lit(offer)}::uuid;`) };
}

function acceptSql(seed) {
  return `select public.pa_contract_accept(${lit(seed.tokenHash)},${lit(seed.offer)}::uuid,${lit(seed.snapshotSha)},'Race Customer',true);`;
}

function seedBilling() {
  const seed = seedConfirmation();
  runSql(acceptSql(seed));
  runSql(`select public.pa_v5_confirm_fulfillment_and_settlement(${lit(actor)}::uuid,${lit(seed.caseId)}::uuid,1,${lit(uuid())}::uuid,100000,false,'{}'::jsonb);`);
  const billOp = uuid();
  runSql(`select public.pa_v5_create_billing(${lit(actor)}::uuid,${lit(seed.caseId)}::uuid,2,${lit(billOp)}::uuid,${lit(seed.offer)}::uuid,${lit(seed.estimate)}::uuid,100000,'no_separate_invoice',null,null,null,null,null,'{"status":"unconfirmed"}'::jsonb,null,'{}'::jsonb,null,null,null,'{}'::jsonb);`);
  return { ...seed, billing: scalar(`select id from public.pa_billings where operation_id=${lit(billOp)}::uuid;`) };
}

function finalJson(sql) {
  return JSON.parse(scalar(`select (${sql})::text;`));
}

function auditCount(caseId, action) {
  return Number(scalar(`select count(*) from public.pa_inquiry_audit where inquiry_id=${lit(caseId)}::uuid and action=${lit(action)};`));
}

function recordPassed(result, invariant) {
  result.invariant = invariant;
  result.duplicateRows = 0;
  result.timeoutOrDeadlock = false;
  result.status = 'PASS';
  evidence.tests.push(result);
}

const bootstrap = `
\\set ON_ERROR_STOP on
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
do $$ begin if not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls) then raise exception 'service_role must have BYPASSRLS in the disposable cluster'; end if; end $$;
create schema auth;
create table auth.users(id uuid primary key);
insert into auth.users values('${actor}');
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
create function public.is_work_admin() returns boolean language sql stable as $$ select auth.uid()='${actor}'::uuid $$;
create table public.pa_inquiries(id uuid primary key,status text not null,schedule_state text,deleted_at timestamptz,updated_at timestamptz not null default now());
create table public.pa_inquiry_audit(id uuid primary key default gen_random_uuid(),inquiry_id uuid references public.pa_inquiries(id),actor_user_id uuid references auth.users(id),action text,details jsonb,occurred_at timestamptz not null default now());
create table public.pa_email_deliveries(id uuid primary key);
${migrationNames.slice(0, 7).map(read).join('\n')}
create table public.work_admins(user_id uuid primary key);
insert into public.work_admins values('${actor}');
alter table public.pa_email_deliveries add column inquiry_id uuid,add column status text,add column gmail_thread_id text,add column gmail_message_id text,add column message_type text,add column sent_at timestamptz,add column recipient text,add column subject text;
alter table public.pa_inquiries add column email text,add column customer_name text,add column contact_name text,add column organization_name text,add column event_name text,add column event_date date,add column inquiry_number text,add column request_summary text;
${migrationNames.slice(7).map(read).join('\n')}
`;

const evidence = {
  task: 'PA-EST-004R2',
  generatedAt: new Date().toISOString(),
  isolation: { host: parsed.hostname, port: Number(baseEnv.PGPORT), database, separatePsqlProcesses: true, productionForbidden: true },
  server: null,
  tests: []
};

async function main() {
  runSql(bootstrap, testEnv, 120000);
  evidence.server = JSON.parse(scalar(`select jsonb_build_object('version',version(),'address',inet_server_addr(),'port',inet_server_port(),'database',current_database())::text;`));

  // 1a. Accept takes the case lock first; revision must wait and then reject.
  let s = seedConfirmation();
  let result = await race('accept-first-vs-revision', acceptSql(s), `select public.pa_v5_begin_estimate_revision(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,1,${lit(uuid())}::uuid,'race revision');`, { bCode: 3, bError: /post_contract_change_required/ });
  result.finalState = finalJson(`jsonb_build_object('contracts',(select count(*) from public.pa_contracts where inquiry_id=${lit(s.caseId)}::uuid),'token',(select state from public.pa_contract_tokens where offer_id=${lit(s.offer)}::uuid),'revision_audit',${auditCount(s.caseId, 'estimate_revision_started')})`);
  assert.deepEqual(result.finalState, { contracts: 1, token: 'accepted', revision_audit: 0 });
  recordPassed(result, 'accepted contract remains authoritative; revision creates no state or audit residue');

  // 1b. Revision takes the case lock first; accept waits and then sees revoked token/current change.
  s = seedConfirmation();
  result = await race('revision-first-vs-accept', `select public.pa_v5_begin_estimate_revision(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,1,${lit(uuid())}::uuid,'race revision');`, acceptSql(s), { bCode: 3, bError: /invalid_link/ });
  result.finalState = finalJson(`jsonb_build_object('contracts',(select count(*) from public.pa_contracts where inquiry_id=${lit(s.caseId)}::uuid),'token',(select state from public.pa_contract_tokens where offer_id=${lit(s.offer)}::uuid),'revision_audit',${auditCount(s.caseId, 'estimate_revision_started')},'revoke_audit',${auditCount(s.caseId, 'formal_contract_revoked')})`);
  assert.deepEqual(result.finalState, { contracts: 0, token: 'revoked', revision_audit: 1, revoke_audit: 1 });
  recordPassed(result, 'revision and pending-token revocation commit atomically; stale accept is rejected');

  // 2. Accepted confirmation is immutable against a dedicated revoke.
  s = seedConfirmation();
  result = await race('accept-vs-single-revoke', acceptSql(s), `select public.pa_v5_revoke_confirmation(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,${lit(s.offer)}::uuid,${lit(uuid())}::uuid,'race revoke');`, { bCode: 3, bError: /accepted_contract_immutable/ });
  result.finalState = finalJson(`jsonb_build_object('contracts',(select count(*) from public.pa_contracts where inquiry_id=${lit(s.caseId)}::uuid),'token',(select state from public.pa_contract_tokens where offer_id=${lit(s.offer)}::uuid),'revoke_audit',${auditCount(s.caseId, 'formal_contract_revoked')})`);
  assert.deepEqual(result.finalState, { contracts: 1, token: 'accepted', revoke_audit: 0 });
  recordPassed(result, 'dedicated revoke cannot change an accepted confirmation or append a revoke audit');

  // 3. Exactly one estimate can win the same expected current/revision switch.
  s = seedEstimate();
  const opA = uuid(), opB = uuid(), docA = uuid(), docB = uuid();
  result = await race('simultaneous-current-estimate-switch', issueEstimate(s.caseId, opA, docA, 1, s.estimate), issueEstimate(s.caseId, opB, docB, 1, s.estimate), { bCode: 3, bError: /commercial_state_changed/ });
  result.finalState = finalJson(`jsonb_build_object('estimate_count',(select count(*) from public.pa_estimate_revisions where inquiry_id=${lit(s.caseId)}::uuid),'current_matches_winner',(select current_estimate_revision_id=(select id from public.pa_estimate_revisions where operation_id=${lit(opA)}::uuid) from public.pa_case_commercial_state where inquiry_id=${lit(s.caseId)}::uuid),'loser_document_count',(select count(*) from public.pa_commercial_documents where id=${lit(docB)}::uuid),'issue_audit',${auditCount(s.caseId, 'estimate_revision_issued')})`);
  assert.deepEqual(result.finalState, { estimate_count: 2, current_matches_winner: true, loser_document_count: 0, issue_audit: 2 });
  recordPassed(result, 'one expected-current switch wins; losing estimate and document leave no residue');

  // 4. Exactly one active confirmation can be issued.
  s = seedEstimate();
  const offerA = uuid(), offerB = uuid();
  result = await race('simultaneous-confirmation-issue', issueConfirmation(s.caseId, s.estimate, offerA, uuid(), crypto.randomBytes(32).toString('hex')), issueConfirmation(s.caseId, s.estimate, offerB, uuid(), crypto.randomBytes(32).toString('hex')), { bCode: 3, bError: /confirmation_already_active/ });
  result.finalState = finalJson(`jsonb_build_object('offer_count',(select count(*) from public.pa_contract_offers where inquiry_id=${lit(s.caseId)}::uuid),'active_tokens',(select count(*) from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=${lit(s.caseId)}::uuid and t.state='active'),'loser_offer_count',(select count(*) from public.pa_contract_offers where id=${lit(offerB)}::uuid),'issue_audit',${auditCount(s.caseId, 'formal_contract_issued')})`);
  assert.deepEqual(result.finalState, { offer_count: 1, active_tokens: 1, loser_offer_count: 0, issue_audit: 1 });
  recordPassed(result, 'one active confirmation and one issue audit exist for the current estimate');

  // 5. Same operation retry returns the committed row and does not duplicate facts/audit.
  s = seedBilling(); const payOp = uuid();
  const paymentSql = `select public.pa_v5_record_payment(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,${lit(s.billing)}::uuid,${lit(payOp)}::uuid,'2026-10-20',30000,'bank_transfer','same operation race');`;
  result = await race('same-payment-operation-retry', paymentSql, paymentSql);
  result.finalState = finalJson(`jsonb_build_object('payment_count',(select count(*) from public.pa_payment_records where operation_id=${lit(payOp)}::uuid),'payment_audit',${auditCount(s.caseId, 'payment_recorded')})`);
  assert.deepEqual(result.finalState, { payment_count: 1, payment_audit: 1 });
  recordPassed(result, 'same payment operation commits once and retry returns the committed identity');

  // 6. Distinct payment operations both serialize and commit.
  s = seedBilling(); const payA = uuid(), payB = uuid();
  result = await race('two-different-payment-registrations', `select public.pa_v5_record_payment(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,${lit(s.billing)}::uuid,${lit(payA)}::uuid,'2026-10-20',30000,'bank_transfer','payment A');`, `select public.pa_v5_record_payment(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,${lit(s.billing)}::uuid,${lit(payB)}::uuid,'2026-10-21',20000,'bank_transfer','payment B');`);
  result.finalState = finalJson(`jsonb_build_object('payment_count',(select count(*) from public.pa_payment_records where billing_id=${lit(s.billing)}::uuid),'total',(select sum(round(amount)::bigint) from public.pa_payment_records where billing_id=${lit(s.billing)}::uuid),'payment_audit',${auditCount(s.caseId, 'payment_recorded')})`);
  assert.deepEqual(result.finalState, { payment_count: 2, total: 50000, payment_audit: 2 });
  recordPassed(result, 'different payment operations both commit once with the exact aggregate total');

  // 7. Two workers contend for one queued job; only one lease is installed.
  s = seedEstimate({ finish: false }); const leaseA = uuid(), leaseB = uuid();
  result = await race('outbox-worker-concurrent-claim', `select public.pa_v5_outbox_claim(${lit(actor)}::uuid,${lit(s.outbox)}::uuid,${lit(leaseA)}::uuid);`, `select public.pa_v5_outbox_claim(${lit(actor)}::uuid,${lit(s.outbox)}::uuid,${lit(leaseB)}::uuid);`, { bCode: 3, bError: /outbox_busy/ });
  result.finalState = finalJson(`(select jsonb_build_object('state',state,'lease_id',lease_id,'attempt_count',attempt_count) from public.pa_commercial_outbox where id=${lit(s.outbox)}::uuid)`);
  assert.deepEqual(result.finalState, { state: 'processing', lease_id: leaseA, attempt_count: 1 });
  recordPassed(result, 'one worker owns the non-expired lease and the competing claim is rejected');

  // 8. An expired lease is recoverable exactly once; the concurrent claimant becomes busy.
  s = seedEstimate({ finish: false });
  runSql(`update public.pa_commercial_outbox set state='processing',lease_id=${lit(uuid())}::uuid,lease_expires_at=now()-interval '1 minute',attempt_count=1 where id=${lit(s.outbox)}::uuid;`);
  const recoveredLease = uuid();
  result = await race('expired-worker-lease-recovery', `select public.pa_v5_outbox_claim(${lit(actor)}::uuid,${lit(s.outbox)}::uuid,${lit(recoveredLease)}::uuid);`, `select public.pa_v5_outbox_claim(${lit(actor)}::uuid,${lit(s.outbox)}::uuid,${lit(uuid())}::uuid);`, { bCode: 3, bError: /outbox_busy/ });
  result.finalState = finalJson(`(select jsonb_build_object('state',state,'lease_id',lease_id,'attempt_count',attempt_count) from public.pa_commercial_outbox where id=${lit(s.outbox)}::uuid)`);
  assert.deepEqual(result.finalState, { state: 'processing', lease_id: recoveredLease, attempt_count: 2 });
  recordPassed(result, 'one worker replaces the expired lease exactly once and the competing claim is rejected');

  // 9. A deliberate SQL failure aborts the transaction; connection exit rolls it back,
  // releases the case lock, and leaves no payment/audit residue.
  s = seedBilling(); const rolledBackOp = uuid(), committedOp = uuid();
  result = await race('transaction-failure-rollback', `select public.pa_v5_record_payment(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,${lit(s.billing)}::uuid,${lit(rolledBackOp)}::uuid,'2026-10-20',10000,'bank_transfer','rollback A');`, `select public.pa_v5_record_payment(${lit(actor)}::uuid,${lit(s.caseId)}::uuid,${lit(s.billing)}::uuid,${lit(committedOp)}::uuid,'2026-10-21',20000,'bank_transfer','commit B');`, { aFailure: true, aCode: 3, aError: /division by zero/ });
  result.finalState = finalJson(`jsonb_build_object('rolled_back_rows',(select count(*) from public.pa_payment_records where operation_id=${lit(rolledBackOp)}::uuid),'committed_rows',(select count(*) from public.pa_payment_records where operation_id=${lit(committedOp)}::uuid),'payment_audit',${auditCount(s.caseId, 'payment_recorded')})`);
  assert.deepEqual(result.finalState, { rolled_back_rows: 0, committed_rows: 1, payment_audit: 1 });
  recordPassed(result, 'failed transaction leaves no payment or audit residue and releases the lock for the competitor');

  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({ ...evidence, result: 'PASS', completedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`PASS PA-EST-004R2 PostgreSQL races: ${evidence.tests.length} independent-session scenarios; evidence=${evidencePath}`);
}

let created = false;
try {
  runSql(`create database "${database}";`, baseEnv);
  created = true;
  await main();
} catch (error) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({ ...evidence, result: 'FAIL', error: String(error?.stack || error), completedAt: new Date().toISOString() }, null, 2) + '\n');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (created) {
    try { runSql(`drop database if exists "${database}" with (force);`, baseEnv, 20000); }
    catch (cleanupError) { console.error(`Disposable database cleanup failed: ${cleanupError.message}`); process.exitCode = 1; }
  }
}

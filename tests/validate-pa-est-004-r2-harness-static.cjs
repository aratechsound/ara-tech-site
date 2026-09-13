const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const harness = fs.readFileSync(path.join(__dirname, 'validate-pa-est-004-r2-postgres-races.mjs'), 'utf8');
const proposal = fs.readFileSync(path.join(root, 'docs', 'pa-est-004r2-docker-repair-proposal.md'), 'utf8');

for (const name of [
  'accept-first-vs-revision',
  'revision-first-vs-accept',
  'accept-vs-single-revoke',
  'simultaneous-current-estimate-switch',
  'simultaneous-confirmation-issue',
  'same-payment-operation-retry',
  'two-different-payment-registrations',
  'outbox-worker-concurrent-claim',
  'expired-worker-lease-recovery',
  'transaction-failure-rollback'
]) assert.match(harness, new RegExp(name));

assert.match(harness, /spawn\(psql/);
assert.match(harness, /pg_backend_pid\(\)/);
assert.match(harness, /lock_timeout='5s'/);
assert.match(harness, /statement_timeout='12s'/);
assert.match(harness, /PA_EST_004_RACE_ALLOW_DISPOSABLE_CLUSTER/);
assert.match(harness, /Refusing non-local PostgreSQL host/);
assert.match(harness, /create database/);
assert.match(harness, /drop database if exists/);
assert.doesNotMatch(harness, /supabase\.co|gmail\.com|Production DB/i);

assert.match(proposal, /C:\\Users\\user\\AppData\\Local\\Docker\\run\\dockerInference/);
assert.match(proposal, /dockerInference\.pa-est-004r2-backup-20260913-001/);
assert.match(proposal, /起動回数.*1回/);
assert.match(proposal, /削除しない/);
assert.match(proposal, /Reset to factory defaults.*実行しない/);

console.log('PASS PA-EST-004R2 harness static: independent psql sessions, local disposable DB guard, timeouts, cleanup and bounded Docker proposal');

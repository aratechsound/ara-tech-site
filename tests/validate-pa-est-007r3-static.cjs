const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const commercial = read('api/_pa-commercial.cjs');
const gmail = read('api/_pa-gmail.cjs');
const handler = read('api/_pa-commercial-handler.cjs');
const ui = read('js/pa-commercial-admin.js');
const migration = read('supabase/migrations/20260914213000_pa_est_007r3_delivery_recovery.sql');

assert.match(commercial, /attachments: prepared\.confirmationAttachment/u);
assert.match(commercial, /job\.job_kind === 'confirmation' \? 'confirmation' : 'normal'/u);
assert.match(commercial, /p_failure_phase: failure\.phase/u);
assert.match(commercial, /probeStandaloneDelivery/u);
assert.match(gmail, /productionE2eMessageId\(jobId\)/u);
assert.match(gmail, /provider_request_started: true/u);
assert.match(handler, /recover_production_e2e_delivery/u);
for (const field of ['failure_phase','failure_code','safe_error_message','provider_request_started','provider_response_received','provider_http_status','delivery_state']) assert.match(migration, new RegExp(field));
assert.match(migration, /failed_before_provider/u);
assert.match(migration, /unknown_after_provider_start/u);
assert.match(migration, /a74497c3-9ce1-453f-ae55-c950391fb30d/u);
assert.match(ui, /案内メールを送信できませんでした。/u);
assert.match(ui, /新しい正式受注確認やURLは作成されません。/u);
assert.match(ui, /provider_match_count === 1/u);
console.log('PASS PA-EST-007R3 static: attachment/mode binding, diagnostics, reconciliation-first recovery and Owner UI');

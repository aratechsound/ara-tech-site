const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const commercial = fs.readFileSync(path.join(root, 'js', 'pa-commercial-admin.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'js', 'pa-admin.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pa-admin.html'), 'utf8');

assert.match(commercial, /estimate\.source_sent_at\s*\|\|\s*\(delivery\?\.state === "sent" \? delivery\.finished_at : null\)/u);
assert.match(commercial, /appendLine\(root, "送信", dateTime\(sentAt\)\)/u);
assert.match(commercial, /estimate\.source_kind === "sent_recovery"\) appendLine\(root, "V5登録"/u);
assert.doesNotMatch(commercial, /appendLine\(estimateRoot, "発行", dateTime\(current\.issued_at\)\)/u);
assert.match(commercial, /過去の見積 \$\{historical\.length\}件/u);

for (const route of ['new_estimate', 'revision_estimate', 'change_order']) assert.match(commercial, new RegExp(route, 'u'));
assert.match(commercial, /activeEstimateEntry = Object\.freeze/u);
assert.match(commercial, /data-pa-estimate-entry/u);
assert.match(commercial, /estimateEntryOpening/u);
assert.match(commercial, /準備しています…/u);
assert.match(commercial, /見積作成画面を開けませんでした。もう一度お試しください。/u);
assert.match(commercial, /openChangeProposal\(context, state, accepted\)/u);

assert.match(admin, /options\.source !== "v5" && !getCommercialDraftContext\(\)/u);
assert.match(admin, /currentProgress\?\.estimate_created_on/u);
assert.match(admin, /return openEstimateSubmission\(options\)/u);
assert.match(admin, /gmailReplyPanel\.scrollIntoView\?\./u);
assert.match(admin, /return true;/u);
assert.match(html, /id="pa-v5-estimate"[^>]+type="button"/u);
assert.equal((html.match(/id="pa-v5-estimate"/gu) || []).length, 1);
assert.equal((html.match(/id="pa-estimate-summary"/gu) || []).length, 1);

console.log('PASS PA-EST-004R11A static UI: timestamp authority, single state routing, feedback, guard and V5 Composer bypass');

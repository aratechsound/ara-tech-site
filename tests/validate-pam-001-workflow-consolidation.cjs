const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("pa-admin.html");
const js = read("js/pa-admin.js");
const migration = read("supabase/migrations/20260902103000_pam001_workflow_projection.sql");

const expectedStages = [
    "問い合わせ受付", "ヒアリング", "概算提示", "依頼意思確認",
    "日程・人員調整", "正式見積", "発注確認", "予約確定",
    "事前準備・打合せ", "最終確認", "本番実施", "請求", "入金確認", "完了"
];

expectedStages.forEach((label) => assert.match(js, new RegExp(`"${label}"`, "u")));
assert.match(js, /const workflowPhases = \[/u);
assert.match(js, /const waitingOnForCase/u);
assert.match(js, /CUSTOMER/u);
assert.match(js, /現在はありません。お客様からの返信を待ってください。/u);
assert.match(js, /お客様の返信内容・添付資料を確認してください。/u);
assert.match(js, /案件工程はメール受信だけでは進行しません。/u);
assert.doesNotMatch(js, /salesWorkflowStages|renderSalesWorkflow|salesStageIndexForCase/u);

assert.match(html, /id="current-situation-section"/u);
assert.match(html, /id="current-situation-stage"/u);
assert.match(html, /id="workflow-phase-nav"/u);
assert.match(html, /最近のやり取り/u);
assert.match(html, /内部通知は監査履歴に表示します。/u);
assert.match(html, /id="maintenance-tools"/u);
assert.ok(html.indexOf('id="brand-mail-test"') > html.indexOf('id="detail-card"'));
assert.ok(html.indexOf('id="brand-mail-test"') > html.indexOf('id="audit-section"'));
assert.doesNotMatch(html, /初回営業工程/u);
assert.doesNotMatch(html, /id="overview-status"|id="overview-next-action"/u);

assert.match(js, /const isInternalDelivery/u);
assert.match(js, /currentDeliveries\.filter\(\(delivery\) => !isInternalDelivery\(delivery\)\)/u);
assert.match(js, /currentDeliveries\.filter\(isInternalDelivery\)/u);

assert.match(migration, /No existing case rows are rewritten/u);
assert.match(migration, /when 'waiting_customer_reply' then 2/u);
assert.match(migration, /when 'rough_estimate' then 3/u);
assert.match(migration, /when 'customer_intent_confirmed' then 4/u);
assert.match(migration, /when 'schedule_coordination' then 5/u);
assert.match(migration, /when p_estimate_created_on is null then 6/u);
assert.match(migration, /when coalesce\(p_invoice_sent, false\) is not true then 12/u);
assert.doesNotMatch(migration, /update\s+public\.pa_case_progress/iu);
assert.doesNotMatch(migration, /PA-20260901-00013/u);

console.log("PAM-001 workflow consolidation validation passed (static projection only; no email or case mutation)");

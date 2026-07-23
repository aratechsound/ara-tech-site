const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const adminHtml = read("pa-admin.html");
const adminCss = read("pa-admin.css");
const adminJs = read("js/pa-admin.js");
const migration = read("supabase/migrations/2026-07-24-pa-case-progress.sql");

assert.match(adminHtml, /<title>PA案件管理 \| ARA-TECH<\/title>/);
assert.match(adminHtml, /<h1>PA案件管理<\/h1>/);
assert.match(adminHtml, /問い合わせ受付から日程確保、見積り、正式予約、イベント実施、請求、手動入金確認、ケースクローズまで/);
assert.match(adminHtml, /id="case-tabs"[^>]*role="tablist"/);
assert.match(adminHtml, /id="progress-summary"/);
assert.match(adminHtml, /id="progress-management-section"/);
assert.match(adminHtml, /id="payment-section"/);
assert.match(adminHtml, /id="payment-mismatch-confirmed"/);
assert.match(adminHtml, /id="payment-confirmation-panel"/);
assert.match(adminHtml, /id="confirm-payment-close"/);
assert.match(adminHtml, /入金確認とケースクローズを同一トランザクションで確定/);
assert.match(adminHtml, /pa-admin\.css\?v=ara-20260724-003/);
assert.match(adminHtml, /js\/pa-admin\.js\?v=ara-20260724-003-2/);

const workflowSource = adminJs.match(/const workflowSteps = \[([\s\S]*?)\];/);
assert.ok(workflowSource, "14-step workflow declaration must exist");
const workflowSteps = [...workflowSource[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.equal(workflowSteps.length, 14);
assert.deepEqual(workflowSteps, [
    "PA予約・お問い合わせ内容確認",
    "日程調整が必要か判断",
    "日程確保フォーム専用URL発行",
    "お客様回答確認",
    "日程確保結果の確定・連絡",
    "見積作成",
    "見積送付・内容調整",
    "見積承認",
    "正式予約",
    "イベント準備",
    "イベント実施",
    "請求",
    "入金確認",
    "ケースクローズ"
]);

assert.match(adminJs, /const renderProgressSteps = \(\) =>/);
assert.match(adminJs, /workflow-step--\$\{state\}/);
assert.match(adminJs, /state === "completed" \? "✓" : String\(step\)/);
assert.match(adminJs, /\? "保留中"[\s\S]*?: step === 4 \? "回答待ち" : "次に対応"/);
assert.match(adminJs, /stateLabel = "今後の工程"/);
assert.match(adminJs, /activeCaseTab = "active"/);
assert.match(adminJs, /filter\(isClosedCase\)[\s\S]*?map\(eventYearForCase\)/);
assert.match(adminJs, /progress\.confirmed_event_date \|\| item\?\.event_date \|\| item\?\.received_at/);
assert.match(adminJs, /result\.sort\(compareCasesForList\)/);
assert.match(adminJs, /receivedTimestamp\(b\.received_at\) - receivedTimestamp\(a\.received_at\)/);
assert.match(adminJs, /inquirySequenceNumber\(b\.inquiry_number\) - inquirySequenceNumber\(a\.inquiry_number\)/);
assert.match(adminJs, /progressGroups = \[/);
assert.match(adminJs, /activeProgressFilter = activeProgressFilter === group\.id \? "" : group\.id/);

assert.match(adminJs, /supabase\.rpc\("update_pa_case_progress"/);
assert.match(adminJs, /supabase\.rpc\("confirm_pa_payment_and_close"/);
assert.match(
    adminJs,
    /const openCase = async \(id\) =>[\s\S]*?currentProgress = progressResult\.data;[\s\S]*?renderOverview\(\);\s*populateProgressManagement\(\);/
);
assert.match(adminJs, /paymentForm\.addEventListener\("submit"/);
assert.match(adminJs, /preparePaymentConfirmation\(\)/);
assert.match(adminJs, /#confirm-payment-close"\)\.addEventListener\("click", confirmPaymentClose\)/);
assert.match(adminJs, /amountsDiffer\(currentProgress\?\.invoice_amount, input\.amount\)/);
assert.match(adminJs, /mismatch && !\$\("#payment-mismatch-confirmed"\)\.checked/);
assert.match(adminJs, /案件はクローズされていません/);
assert.match(adminJs, /currentSessionUser\?\.email/);
assert.match(adminJs, /\.from\("pa_payment_records"\)/);
assert.match(adminJs, /operator_label/);

assert.match(migration, /create table if not exists public\.pa_case_progress/);
assert.match(migration, /current_step smallint not null default 1 check \(current_step between 1 and 14\)/);
[
    "estimate_amount",
    "estimate_created_on",
    "estimate_sent_on",
    "estimate_adjusting",
    "estimate_approved_on",
    "booking_confirmed_on",
    "confirmed_event_date",
    "event_preparation_completed_on",
    "event_completed_on",
    "invoice_amount",
    "invoice_issued_on",
    "payment_due_on",
    "invoice_sent",
    "close_reason",
    "closed_at"
].forEach((field) => assert.match(migration, new RegExp(`\\b${field}\\b`)));

assert.match(migration, /create table if not exists public\.pa_payment_records/);
assert.match(migration, /confirmation_source text not null default 'manual'/);
assert.match(migration, /external_transaction_id text/);
assert.match(migration, /create unique index if not exists pa_payment_records_one_close_per_case/);
assert.match(migration, /create or replace function public\.derive_pa_workflow_step/);
assert.match(migration, /create or replace function public\.update_pa_case_progress/);
assert.match(migration, /create or replace function public\.confirm_pa_payment_and_close/);
assert.match(migration, /if not public\.is_work_admin\(\) then/);
assert.match(migration, /payment amount mismatch confirmation required/);
assert.match(migration, /insert into public\.pa_payment_records[\s\S]*?update public\.pa_case_progress[\s\S]*?update public\.pa_inquiries[\s\S]*?insert into public\.pa_inquiry_audit/);
assert.doesNotMatch(migration, /exception\s+when/i);
assert.match(migration, /alter table public\.pa_case_progress enable row level security/);
assert.match(migration, /alter table public\.pa_payment_records enable row level security/);
assert.match(migration, /grant select on public\.pa_case_progress to authenticated/);
assert.match(migration, /grant select on public\.pa_payment_records to authenticated/);
assert.match(migration, /grant execute on function public\.update_pa_case_progress/);
assert.match(migration, /grant execute on function public\.confirm_pa_payment_and_close/);
assert.match(migration, /confirmation_sourceとexternal_transaction_idは将来自動照合用に予約/);

assert.match(adminCss, /\.workflow-step--completed\s*\{/);
assert.match(adminCss, /\.workflow-step--current\s*\{/);
assert.match(adminCss, /\.workflow-step--future\s*\{/);
assert.match(adminCss, /\.workflow-step--skipped\s*\{/);
assert.match(adminCss, /\.progress-summary\s*\{/);
assert.match(adminCss, /\.progress-edit-grid\s*\{/);
assert.match(adminCss, /@media \(max-width: 700px\)[\s\S]*?\.workflow-list, \.progress-edit-grid\s*\{\s*grid-template-columns:\s*1fr/);
assert.match(adminCss, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/s);

new vm.Script(adminJs.replace(/^import .*$/gm, ""), {
    filename: "js/pa-admin.js"
});

const stage = ({
    status = "schedule_confirmed",
    estimateCreated = null,
    estimateSent = null,
    adjusting = false,
    approved = null,
    booking = null,
    prepCompleted = null,
    eventCompleted = null,
    invoiceSent = false
}) => {
    if (["schedule_unavailable", "declined", "cancelled", "closed"].includes(status)) return 14;
    if (status !== "schedule_confirmed") return {
        new: 1,
        reviewing: 2,
        second_form_not_issued: 3,
        schedule_unconfirmed: 3,
        second_form_issued: 4,
        customer_responded: 5,
        schedule_adjusting: 5,
        needs_confirmation: 5,
        on_hold: 2
    }[status] || 1;
    if (!estimateCreated) return 6;
    if (!estimateSent || adjusting) return 7;
    if (!approved) return 8;
    if (!booking) return 9;
    if (!prepCompleted) return 10;
    if (!eventCompleted) return 11;
    if (!invoiceSent) return 12;
    return 13;
};

assert.equal(stage({}), 6);
assert.equal(stage({ estimateCreated: "2026-08-01" }), 7);
assert.equal(stage({ estimateCreated: "2026-08-01", estimateSent: "2026-08-02" }), 8);
assert.equal(stage({ estimateCreated: "1", estimateSent: "2", approved: "3" }), 9);
assert.equal(stage({ estimateCreated: "1", estimateSent: "2", approved: "3", booking: "4" }), 10);
assert.equal(stage({ estimateCreated: "1", estimateSent: "2", approved: "3", booking: "4", prepCompleted: "5" }), 11);
assert.equal(stage({ estimateCreated: "1", estimateSent: "2", approved: "3", booking: "4", prepCompleted: "5", eventCompleted: "6" }), 12);
assert.equal(stage({ estimateCreated: "1", estimateSent: "2", approved: "3", booking: "4", prepCompleted: "5", eventCompleted: "6", invoiceSent: true }), 13);
assert.equal(stage({ status: "schedule_unavailable" }), 14);

console.log("ARA-20260724-003 PA case-progress regression validation passed");

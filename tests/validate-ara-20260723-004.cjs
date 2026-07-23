const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const adminHtml = read("pa-admin.html");
const adminJs = read("js/pa-admin.js");
const scheduleHtml = read("pa-schedule-confirm.html");
const scheduleJs = read("js/pa-schedule-confirm.js");
const migration = read("supabase/migrations/2026-07-23-pa-inquiry-management.sql");
const inquiryHtml = read("pa-inquiry.html");
const inquiryJs = read("js/pa-inquiry.js");
const sitemap = read("api/sitemap.js");
const vercel = JSON.parse(read("vercel.json"));

assert.match(adminHtml, /<meta name="robots" content="noindex, nofollow, noarchive">/);
assert.match(adminHtml, /WORKS管理/);
assert.match(adminHtml, /PA案件管理/);
assert.match(adminHtml, /日程確保フォームURLを発行/);
assert.match(adminHtml, /この内容でGmail送信/);
assert.doesNotMatch(adminHtml, /件名をコピー|本文をコピー|メールアプリで開く|mailto:/);
assert.match(adminHtml, /結果メールのGmail送信成功後にだけ更新/);

assert.match(adminJs, /crypto\.getRandomValues\(bytes\)/);
assert.match(adminJs, /new Uint8Array\(32\)/);
assert.match(adminJs, /issue_pa_schedule_token/);
assert.match(adminJs, /revoke_pa_schedule_token/);
assert.match(adminJs, /action: "send_result"/);
assert.match(adminJs, /日程確保フォームへの回答だけでは、契約・予約または日程確保は確定しません/);
assert.doesNotMatch(adminJs, /service_role/i);

assert.match(scheduleHtml, /noindex,nofollow,noarchive,nosnippet/);
assert.match(scheduleHtml, /<meta name="referrer" content="no-referrer">/);
assert.match(scheduleHtml, /この操作だけでは日程確保は完了しません/);
assert.match(scheduleHtml, /日程確保料33,000円/);
assert.doesNotMatch(scheduleHtml, /LOCAL PROTOTYPE|ローカル試作|確認用サンプル/);
assert.doesNotMatch(scheduleHtml, /href="(?:index|contact|pa-rental|works)\.html"/);
assert.doesNotMatch(scheduleHtml, /内部メモ/);

assert.match(scheduleJs, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
assert.match(scheduleJs, /get_pa_schedule_case/);
assert.match(scheduleJs, /\/api\/pa-schedule-response/);
assert.match(scheduleJs, /credentials: "omit"/);
assert.match(scheduleJs, /referrerPolicy: "no-referrer"/);
assert.doesNotMatch(scheduleJs, /localStorage|sessionStorage|document\.cookie/);
assert.doesNotMatch(scheduleJs, /console\./);

[
    "public.pa_inquiries",
    "public.pa_schedule_tokens",
    "public.pa_schedule_responses",
    "public.pa_inquiry_audit"
].forEach((table) => {
    assert.match(migration, new RegExp(`alter table ${table.replace(".", "\\.")} enable row level security`));
});

assert.match(migration, /digest\(convert_to\(p_token, 'UTF8'\), 'sha256'\)/);
assert.match(migration, /update public\.pa_schedule_tokens\s+set revoked_at = now\(\)/);
assert.match(migration, /v_token\.expires_at <= now\(\)/);
assert.match(migration, /already_answered/);
assert.match(migration, /schedule_state = 'completed'/);
assert.match(migration, /customer_confirmation_sent_at = v_confirmed_at/);
assert.match(migration, /grant execute on function public\.get_pa_schedule_case\(text\) to anon, authenticated/);
assert.match(migration, /grant execute on function public\.submit_pa_schedule_response\(text, jsonb, uuid\) to anon, authenticated/);
assert.doesNotMatch(migration, /token\s+text\s+not null/i);

assert.match(inquiryHtml, /action="\/api\/pa-inquiry"/);
assert.doesNotMatch(inquiryHtml, /formspree/i);
assert.match(inquiryJs, /fetch\(form\.action/);
assert.doesNotMatch(inquiryJs, /pa_inquiries|create_pa_inquiry/);

assert.doesNotMatch(sitemap, /pa-schedule-confirm|pa-admin/);

const scheduleHeaders = vercel.headers.find((entry) => entry.source === "/pa-schedule-confirm.html");
assert.ok(scheduleHeaders, "第2フォームの本番ヘッダー設定が必要です");
const headerMap = Object.fromEntries(scheduleHeaders.headers.map((entry) => [entry.key.toLowerCase(), entry.value]));
assert.match(headerMap["cache-control"], /no-store/);
assert.equal(headerMap["referrer-policy"], "no-referrer");
assert.match(headerMap["x-robots-tag"], /noindex/);
assert.match(headerMap["content-security-policy"], /frame-ancestors 'none'/);

console.log("ARA-20260723-004 static validation passed");

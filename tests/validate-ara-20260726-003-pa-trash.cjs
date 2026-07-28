const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const adminHtml = read("pa-admin.html");
const adminCss = read("pa-admin.css");
const adminJs = read("js/pa-admin.js");
const trashApiSource = read("api/pa-case-trash.js");
const mailSource = read("api/_pa-mail.cjs");
const migration = read("supabase/migrations/2026-07-26-pa-case-trash.sql");

[
    "trash-case-dialog",
    "restore-case-dialog",
    "purge-case-dialog",
    "trash-confirm-number",
    "trash-confirm-customer",
    "trash-confirm-event",
    "trash-confirm-date",
    "trash-reason",
    "trash-list",
    "empty-trash",
    "purge-confirmation",
    "purge-impact-list"
].forEach((id) => assert.match(adminHtml, new RegExp(`id="${id}"`)));

assert.match(adminHtml, /通常の業務完了案件は削除せず、「済／ケースクローズ」として年別履歴に残してください。/);
assert.match(adminHtml, /案件の進捗状態は保持されますが、通常一覧・検索・年別履歴から除外/);
assert.match(adminHtml, /顧客用URLは利用できなくなります。メールは送信されません。/);
assert.match(adminHtml, /この操作は元に戻せません。/);
assert.match(adminHtml, /進捗・入金・専用URL／トークン・回答・メール送信履歴・監査履歴/);
assert.match(adminHtml, /js\/pa-admin\.js\?v=ara-20260726-003/);

assert.match(adminCss, /\.case-dialog\s*\{/);
assert.match(adminCss, /\.case-dialog::backdrop/);
assert.match(adminCss, /\.trash-table\s*\{[^}]*min-width/s);
assert.match(adminCss, /@media \(max-width: 700px\)[\s\S]*?\.case-dialog__actions \.button\s*\{\s*width:\s*100%/);
assert.match(adminCss, /@media \(max-width: 700px\)[\s\S]*?\.dialog-summary\s*\{\s*grid-template-columns:\s*1fr/);

assert.match(adminJs, /let trashedCases = \[\]/);
assert.match(adminJs, /\.is\("deleted_at", null\)/);
assert.match(adminJs, /\.not\("deleted_at", "is", null\)/);
assert.match(adminJs, /\{ id: "trash", label: "ゴミ箱", count: trashedCases\.length \}/);
assert.match(adminJs, /activeCaseTab === "trash"/);
assert.match(adminJs, /const renderTrashCases = \(\) =>/);
assert.match(adminJs, /const confirmTrashCase = async \(\) =>/);
assert.match(adminJs, /const confirmRestoreCase = async \(\) =>/);
assert.match(adminJs, /const confirmPurgeCase = async \(\) =>/);
assert.match(adminJs, /action: "inspect"/);
assert.match(adminJs, /action: "trash"/);
assert.match(adminJs, /action: "restore"/);
assert.match(adminJs, /action: "purge"/);
assert.match(adminJs, /result\.case\.active_token_restored/);
assert.match(adminJs, /#purge-confirmation"\)\.value !== selectedTrashCase\?\.inquiry_number/);
assert.match(adminJs, /if \(trashActionInProgress \|\| !selectedTrashCase\) return/);
assert.match(adminJs, /メールは送信していません。/);

const renderCasesSource = adminJs.match(
    /const renderCases = \(\) => \{([\s\S]*?)\r?\n\};\r?\n\r?\nconst trashCaseSummary/
);
assert.ok(renderCasesSource, "normal case renderer must remain separate from trash renderer");
assert.doesNotMatch(renderCasesSource[1], /完全削除|confirmPurgeCase|openPurgeDialog/);

assert.match(trashApiSource, /verifyAdmin\(bearerToken\(request\)\)/);
assert.match(trashApiSource, /require\("\.\/_request-security\.cjs"\)/);
assert.match(trashApiSource, /requestOriginMatchesHost\(request, response\)/);
assert.match(trashApiSource, /MAX_BODY_BYTES = 4_096/);
assert.match(trashApiSource, /purge:\s*5/);
assert.match(trashApiSource, /Retry-After/);
assert.match(trashApiSource, /trash_pa_case/);
assert.match(trashApiSource, /restore_pa_case/);
assert.match(trashApiSource, /get_pa_case_delete_impact/);
assert.match(trashApiSource, /purge_pa_case/);
assert.doesNotMatch(trashApiSource, /GMAIL_|gmailapis|sendGmail|createScheduleDelivery/);
assert.match(mailSource, /id: `eq\.\$\{inquiryId\}`,\s*deleted_at: "is\.null"/s);

assert.match(migration, /add column if not exists deleted_at timestamptz/);
assert.match(migration, /add column if not exists delete_reason text/);
assert.match(migration, /add column if not exists deleted_by uuid/);
assert.match(migration, /delete_reason in \('test_case', 'duplicate', 'input_error', 'other'\)/);
assert.match(migration, /create index if not exists pa_inquiries_active_status_idx[\s\S]*?where deleted_at is null/);
assert.match(migration, /create or replace function public\.guard_pa_inquiry_soft_delete/);
assert.match(migration, /create or replace function public\.guard_deleted_pa_related_write/);
[
    "pa_schedule_tokens_guard_deleted_case",
    "pa_schedule_responses_guard_deleted_case",
    "pa_case_progress_guard_deleted_case",
    "pa_payment_records_guard_deleted_case",
    "pa_email_deliveries_guard_deleted_case"
].forEach((trigger) => assert.match(migration, new RegExp(`create trigger ${trigger}`)));

const trashFunction = migration.match(
    /create or replace function public\.trash_pa_case\(([\s\S]*?)create or replace function public\.restore_pa_case\(/
);
assert.ok(trashFunction);
assert.match(trashFunction[1], /deleted_at = v_deleted_at/);
assert.match(trashFunction[1], /delete_reason = p_reason/);
assert.match(trashFunction[1], /status_preserved/);
assert.doesNotMatch(trashFunction[1], /\bstatus\s*=/);
assert.doesNotMatch(trashFunction[1], /\bschedule_state\s*=/);
assert.doesNotMatch(trashFunction[1], /insert into public\.pa_email_deliveries|send/);

const restoreFunction = migration.match(
    /create or replace function public\.restore_pa_case\(([\s\S]*?)create or replace function public\.get_pa_case_delete_impact\(/
);
assert.ok(restoreFunction);
assert.match(restoreFunction[1], /revoked_at is null/);
assert.match(restoreFunction[1], /answered_at is null/);
assert.match(restoreFunction[1], /expires_at > now\(\)/);
assert.match(restoreFunction[1], /deleted_at = null/);
assert.doesNotMatch(restoreFunction[1], /\bstatus\s*=/);
assert.doesNotMatch(restoreFunction[1], /\bschedule_state\s*=/);

const purgeFunction = migration.match(
    /create or replace function public\.purge_pa_case\(([\s\S]*?)-- 顧客URLは/
);
assert.ok(purgeFunction);
assert.match(purgeFunction[1], /p_confirmation <> v_case\.inquiry_number/);
assert.match(purgeFunction[1], /v_case\.deleted_at is null/);
assert.match(purgeFunction[1], /set_config\('app\.pa_case_delete_mode', 'purge', true\)/);
assert.match(purgeFunction[1], /set schedule_result_delivery_id = null/);
assert.match(purgeFunction[1], /update public\.pa_email_deliveries as delivery[\s\S]*?set retry_of = null/);
assert.match(
    purgeFunction[1],
    /delete from public\.pa_payment_records[\s\S]*?delete from public\.pa_schedule_responses[\s\S]*?delete from public\.pa_schedule_tokens[\s\S]*?delete from public\.pa_email_deliveries[\s\S]*?delete from public\.pa_case_progress[\s\S]*?delete from public\.pa_inquiry_audit[\s\S]*?delete from public\.pa_inquiries/
);

assert.match(migration, /where id = v_token\.inquiry_id\s+and deleted_at is null/);
assert.match(migration, /join public\.pa_inquiries i on i\.id = t\.inquiry_id[\s\S]*?and i\.deleted_at is null/);
assert.match(migration, /grant execute on function public\.trash_pa_case\(uuid, text, uuid\) to service_role/);
assert.match(migration, /grant execute on function public\.purge_pa_case\(uuid, text, uuid\) to service_role/);
assert.doesNotMatch(migration, /grant execute on function public\.(?:trash|restore|purge)_pa_case\([^;]+to authenticated/);
assert.match(migration, /^begin;/m);
assert.match(migration, /^commit;/m);

new vm.Script(adminJs.replace(/^import .*$/gm, ""), {
    filename: "js/pa-admin.js"
});

const trashApi = require(path.join(root, "api", "pa-case-trash.js"));

const makeResponse = () => ({
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
    },
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(payload) {
        this.payload = payload;
        return this;
    }
});

const makeRequest = (body, headers = {}) => ({
    method: "POST",
    body,
    headers: {
        host: "ara-tech.cc",
        origin: "https://ara-tech.cc",
        authorization: "Bearer admin-access-token",
        "x-forwarded-for": "203.0.113.30",
        ...headers
    },
    socket: { remoteAddress: "203.0.113.30" }
});

const invoke = async (request) => {
    const response = makeResponse();
    await trashApi(request, response);
    return response;
};

const testApi = async () => {
    const previousFetch = global.fetch;
    const previousUrl = process.env.SUPABASE_URL;
    const previousServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
    const calls = [];
    const rpcResults = new Map([
        ["trash_pa_case", [
            { result: "trashed", inquiry_id: "00000000-0000-4000-8000-000000000111", inquiry_number: "PA-20260726-TEST01" },
            { result: "already_trashed", inquiry_id: "00000000-0000-4000-8000-000000000111", inquiry_number: "PA-20260726-TEST01" }
        ]],
        ["restore_pa_case", [
            { result: "restored", inquiry_id: "00000000-0000-4000-8000-000000000111", inquiry_number: "PA-20260726-TEST01", active_token_restored: true }
        ]],
        ["get_pa_case_delete_impact", [
            { result: "ready", inquiry_number: "PA-20260726-TEST01", progress_count: 1, payment_count: 1, token_count: 1, response_count: 1, email_count: 2, audit_count: 4 }
        ]],
        ["purge_pa_case", [
            { result: "confirmation_mismatch", inquiry_number: "PA-20260726-TEST01" },
            { result: "purged", inquiry_id: "00000000-0000-4000-8000-000000000111", inquiry_number: "PA-20260726-TEST01", payments_deleted: 1, emails_deleted: 2 },
            { result: "not_found" }
        ]]
    ]);

    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    process.env.ALLOWED_ORIGINS = "https://ara-tech.cc";
    global.fetch = async (url, options = {}) => {
        const target = String(url);
        calls.push({ target, options });
        if (target.endsWith("/auth/v1/user")) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ id: "00000000-0000-4000-8000-000000000999" })
            };
        }
        if (target.includes("/rest/v1/work_admins?")) {
            return {
                ok: true,
                status: 200,
                json: async () => [{ user_id: "00000000-0000-4000-8000-000000000999" }]
            };
        }
        const rpcMatch = target.match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
        if (rpcMatch) {
            if (rpcMatch[1] === "consume_rate_limit") {
                const body = JSON.parse(options.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => [{
                        allowed: true,
                        remaining: Math.max(0, body.p_limit - 1),
                        retry_after_seconds: 0,
                        reset_at: "2026-07-26T12:01:00Z",
                        limit: body.p_limit
                    }]
                };
            }
            const queue = rpcResults.get(rpcMatch[1]);
            assert.ok(queue?.length, `unexpected RPC call ${rpcMatch[1]}`);
            return {
                ok: true,
                status: 200,
                json: async () => [queue.shift()]
            };
        }
        throw new Error(`unexpected fetch ${target}`);
    };

    try {
        const invalidOrigin = await invoke(makeRequest(
            { action: "trash", inquiry_id: "00000000-0000-4000-8000-000000000111", reason: "test_case" },
            { origin: "https://attacker.example" }
        ));
        assert.equal(invalidOrigin.statusCode, 403);
        assert.equal(invalidOrigin.payload.code, "invalid_origin");
        assert.equal(calls.length, 0);

        const noAuth = await invoke(makeRequest(
            { action: "trash", inquiry_id: "00000000-0000-4000-8000-000000000111", reason: "test_case" },
            { authorization: "" }
        ));
        assert.equal(noAuth.statusCode, 401);
        assert.equal(noAuth.payload.code, "not_authorized");
        assert.equal(calls.length, 0);

        const trashRequest = () => makeRequest({
            action: "trash",
            inquiry_id: "00000000-0000-4000-8000-000000000111",
            reason: "test_case"
        });
        const firstTrash = await invoke(trashRequest());
        const secondTrash = await invoke(trashRequest());
        assert.equal(firstTrash.statusCode, 200);
        assert.equal(firstTrash.payload.changed, true);
        assert.equal(secondTrash.statusCode, 200);
        assert.equal(secondTrash.payload.changed, false);

        const restored = await invoke(makeRequest({
            action: "restore",
            inquiry_id: "00000000-0000-4000-8000-000000000111"
        }));
        assert.equal(restored.statusCode, 200);
        assert.equal(restored.payload.case.active_token_restored, true);

        const impact = await invoke(makeRequest({
            action: "inspect",
            inquiry_id: "00000000-0000-4000-8000-000000000111"
        }));
        assert.equal(impact.statusCode, 200);
        assert.equal(impact.payload.case.payment_count, 1);
        assert.equal(impact.payload.case.email_count, 2);

        const mismatch = await invoke(makeRequest({
            action: "purge",
            inquiry_id: "00000000-0000-4000-8000-000000000111",
            confirmation: "WRONG"
        }));
        assert.equal(mismatch.statusCode, 400);
        assert.equal(mismatch.payload.code, "confirmation_mismatch");

        const purged = await invoke(makeRequest({
            action: "purge",
            inquiry_id: "00000000-0000-4000-8000-000000000111",
            confirmation: "PA-20260726-TEST01"
        }));
        assert.equal(purged.statusCode, 200);
        assert.equal(purged.payload.changed, true);

        const repeatedPurge = await invoke(makeRequest({
            action: "purge",
            inquiry_id: "00000000-0000-4000-8000-000000000111",
            confirmation: "PA-20260726-TEST01"
        }));
        assert.equal(repeatedPurge.statusCode, 404);
        assert.equal(repeatedPurge.payload.code, "not_found");

        const rateLimitCalls = calls.filter((call) => call.target.endsWith("/rest/v1/rpc/consume_rate_limit"));
        const rpcCalls = calls.filter((call) => (
            call.target.includes("/rest/v1/rpc/")
            && !call.target.endsWith("/rest/v1/rpc/consume_rate_limit")
        ));
        assert.equal(rateLimitCalls.length, 7);
        assert.equal(rpcCalls.length, 7);
        rateLimitCalls.forEach((call) => {
            const body = JSON.parse(call.options.body);
            assert.match(body.p_bucket_key, /^pa-api:v1:pa-case-trash-/);
            assert.ok(Number.isInteger(body.p_limit));
            assert.ok(Number.isInteger(body.p_window_ms));
        });
        rpcCalls.forEach((call) => {
            const body = JSON.parse(call.options.body);
            assert.equal(body.p_actor_user_id, "00000000-0000-4000-8000-000000000999");
            assert.equal(call.options.headers.authorization, "Bearer test-service-role");
        });
        assert.ok(calls.every((call) => !/googleapis|gmail/u.test(call.target)));
    } finally {
        global.fetch = previousFetch;
        if (previousUrl === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = previousUrl;
        if (previousServiceRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRole;
        if (previousAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
    }
};

testApi()
    .then(() => console.log("ARA-20260726-003 PA trash static, security, and API validation passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

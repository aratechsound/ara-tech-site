const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const inquiryHtml = read("pa-inquiry.html");
const inquiryJs = read("js/pa-inquiry.js");
const adminHtml = read("pa-admin.html");
const adminJs = read("js/pa-admin.js");
const privacyHtml = read("privacy.html");
const migration = read("supabase/migrations/2026-07-23-pa-public-inquiry-registration.sql");
const apiSource = read("api/pa-inquiry.js");
const api = require(path.join(root, "api/pa-inquiry.js"));

const validInquiry = {
    submission_key: "123e4567-e89b-42d3-a456-426614174000",
    website: "",
    form_source: "direct",
    form_service: "PAレンタル",
    event_name: "架空検証イベント",
    event_date: "2026-08-20",
    time_undecided: "",
    start_time: "10:00",
    end_time: "18:00",
    venue_name: "架空検証会場",
    venue_address: "広島県テスト市1-2-3",
    venue_type: "屋内",
    expected_attendance: "101〜300名",
    event_overview: "公開後検証専用の架空案件です。",
    event_status: "検討中",
    requested_services: ["PA・音響", "照明"],
    requested_service_other: "",
    organizer_type: "団体・事業者",
    organizer_name: "架空検証団体",
    organizer_representative: "検証 太郎",
    organizer_email: "",
    organizer_phone: "",
    requester_relation: "主催団体の担当者",
    requester_relation_other: "",
    requester_name: "検証 花子",
    requester_organization: "架空検証団体",
    requester_authority: "ある",
    contact_source: "requester",
    contact_name: "",
    contact_email: "ara-test@example.com",
    contact_phone: "080-0000-0000",
    preferred_contact_method: "メール",
    payer_source: "organizer",
    invoice_name: "",
    payer_name: "",
    payer_organization: "",
    payer_email: "",
    payer_phone: "",
    estimate_notes: "テストデータ",
    questions: "回答不要",
    confirmation_consent: "同意する"
};

const normalized = api.normalizeInquiry(validInquiry);
assert.equal(normalized.submission_source, "public_form");
assert.equal(normalized.organization_name, "架空検証団体");
assert.equal(normalized.contact_name, "検証 花子");
assert.equal(normalized.email, "ara-test@example.com");
assert.equal(normalized.event_time, "10:00〜18:00");
assert.deepEqual(normalized.requested_services, ["PA・音響", "照明"]);
assert.equal(normalized.first_form_data.contact_phone, "080-0000-0000");

assert.throws(() => api.normalizeInquiry({ ...validInquiry, event_date: "" }), api.ValidationError);
assert.throws(() => api.normalizeInquiry({ ...validInquiry, contact_email: "invalid" }), api.ValidationError);
assert.throws(() => api.normalizeInquiry({ ...validInquiry, website: "https://spam.example" }), api.ValidationError);
assert.throws(() => api.normalizeInquiry({ ...validInquiry, submission_key: "not-a-uuid" }), api.ValidationError);

assert.match(inquiryHtml, /<form id="pa-inquiry-form" action="\/api\/pa-inquiry"/);
assert.match(inquiryHtml, /name="website"/);
assert.doesNotMatch(inquiryHtml, /formspree/i);
assert.match(inquiryJs, /sessionStorage/);
assert.match(inquiryJs, /submission_key/);
assert.match(inquiryJs, /Content-Type": "application\/json"/);
assert.doesNotMatch(inquiryJs, /console\./);
assert.doesNotMatch(inquiryJs, /\.innerHTML\s*=/);
new vm.Script(inquiryJs, { filename: "js/pa-inquiry.js" });

assert.match(apiSource, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
assert.doesNotMatch(apiSource, /sb_secret_|service_role\s*[:=]\s*["']/i);
assert.match(apiSource, /resolution=ignore-duplicates/);
assert.match(apiSource, /MAX_BODY_BYTES/);
assert.match(apiSource, /RATE_LIMIT/);
assert.match(apiSource, /website/);

assert.match(migration, /add column if not exists submission_key uuid/);
assert.match(migration, /pa_inquiries_submission_key_unique unique \(submission_key\)/);
assert.match(migration, /alter column created_by drop not null/);
assert.match(migration, /revoke all on public\.pa_inquiries from anon/);
assert.match(migration, /public\.is_work_admin\(\)/);

assert.match(adminHtml, /id="first-form-section"/);
assert.match(adminHtml, /id="contact-name"/);
assert.match(adminHtml, /Webフォームの問い合わせは自動登録されます/);
assert.doesNotMatch(adminHtml, /通知を確認後、案件を手入力/);
assert.match(adminJs, /renderFirstFormData/);
assert.match(adminJs, /submission_source === "public_form"/);
assert.doesNotMatch(adminJs, /\.innerHTML\s*=/);

assert.match(privacyHtml, /PAお問い合わせ・空き状況確認フォーム/);
assert.match(privacyHtml, /PA予約管理システム/);

const validateIdempotentLookup = async () => {
    const previousUrl = process.env.SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = "https://project.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-secret";
    const calls = [];
    const mockFetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || "GET", prefer: options.headers?.prefer || "" });
        if (calls.length === 1) {
            return { ok: true, json: async () => [] };
        }
        return {
            ok: true,
            json: async () => [{
                id: "00000000-0000-4000-8000-000000000001",
                inquiry_number: "PA-20260723-00001",
                received_at: "2026-07-23T12:00:00Z"
            }]
        };
    };

    try {
        const result = await api.registerInquiry(normalized, mockFetch);
        assert.equal(result.duplicate, true);
        assert.equal(result.inquiry_number, "PA-20260723-00001");
        assert.equal(calls.length, 2);
        assert.equal(calls[0].method, "POST");
        assert.match(calls[0].prefer, /resolution=ignore-duplicates/);
        assert.equal(calls[1].method, "GET");
        assert.match(calls[1].url, /submission_key=eq\./);
    } finally {
        if (previousUrl === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = previousUrl;
        if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    }
};

validateIdempotentLookup()
    .then(() => console.log("ARA-20260723-006 static validation passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

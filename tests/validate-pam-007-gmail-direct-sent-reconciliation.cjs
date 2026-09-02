const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const gmail = require(path.join(root, "api", "_pa-gmail.cjs"));
const client = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260903010000_pam004_gmail_direct_sent_reconciliation.sql"), "utf8");
const dbFixture = require("./helpers/pa-estimate-fixture.cjs");
Object.assign(process.env, { GMAIL_CLIENT_ID: "test-client", GMAIL_CLIENT_SECRET: "test-secret", GMAIL_REFRESH_TOKEN: "test-refresh", GMAIL_SENDER_ADDRESS: "aratechsound@gmail.com", GMAIL_REPLY_TO: "aratechsound@gmail.com", SUPABASE_SERVICE_ROLE_KEY: "test-service-key" });

const inquiryId = "123e4567-e89b-42d3-a456-426614174000";
const actorId = "123e4567-e89b-42d3-a456-426614174001";
const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
const directMessage = {
    id: "direct_sent_001", threadId: "thread_123", internalDate: String(Date.parse(dbFixture.sentAt)),
    payload: { headers: [
        { name: "From", value: "aratechsound@gmail.com" }, { name: "To", value: "customer@example.com" },
        { name: "Subject", value: "Estimate" }, { name: "Message-ID", value: "<direct@example.com>" }
    ], mimeType: "multipart/mixed", parts: [{ partId: "0.1", filename: "estimate.pdf", mimeType: "application/pdf", body: { attachmentId: "attachment_1", size: 12 } }] }
};

(async () => {
    const db = await dbFixture.createDatabase();
    const reconciliationFetch = dbFixture.rpcFetch(db);
    const reconciliationInput = {
        inquiryId, gmailMessageId: "direct_sent_001", gmailThreadId: "thread_123",
        accessToken: "fixture-user-jwt", expected: await dbFixture.expectedFor(db)
    };
    const indexWrites = [];
    let auditWrites = 0;
    const fetchFixture = async (url, options = {}) => {
        if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "fixture-token" });
        if (url.includes("/rest/v1/pa_inquiries?")) return json([{ id: inquiryId, inquiry_number: "PA-TEST-001" }]);
        if (url.includes("/rest/v1/pa_gmail_thread_links?")) return json([{ inquiry_id: inquiryId, gmail_thread_id: "thread_123", conversation_role: "primary_conversation" }]);
        if (url.includes("/rest/v1/pa_email_deliveries?")) return json([]);
        if (url.includes("/rest/v1/pa_inquiry_audit?") && options.method !== "POST") return json([]);
        if (url.includes("/threads/thread_123?format=full")) return json({ messages: [directMessage] });
        if (url.includes("/rest/v1/pa_gmail_message_index?") && options.method === "POST") { indexWrites.push(JSON.parse(options.body)); return json([]); }
        if (url.includes("/rest/v1/pa_case_mail_attention")) return json([]);
        if (url.includes("/rest/v1/pa_inquiry_audit") && options.method === "POST") { auditWrites += 1; return json([]); }
        if (url.includes("/rest/v1/pa_gmail_message_index?")) return json(url.includes("other_case_message") ? [] : [{ gmail_message_id: "direct_sent_001" }]);
        throw new Error(`unexpected fixture URL: ${url}`);
    };

    const synced = await gmail.syncCase({ inquiryId, actorId }, fetchFixture);
    assert.equal(synced.messages.length, 1, "a historical message in an existing linked thread is synchronized");
    assert.equal(synced.messages[0].source, "gmail_direct", "outbound without PA-managed message identity is Gmail direct");
    assert.equal(synced.messages[0].attachments[0].id, "attachment_1", "direct Sent attachment retains exact message/attachment identity");
    assert.equal(indexWrites[0].message_source, "gmail_direct");

    const before = await dbFixture.state(db);
    const first = await gmail.reconcileEstimateSubmission(reconciliationInput, reconciliationFetch);
    const afterFirst = await dbFixture.state(db);
    const second = await gmail.reconcileEstimateSubmission(reconciliationInput, reconciliationFetch);
    assert.equal(first.already_reconciled, false);
    assert.equal(second.already_reconciled, true, "reconciliation is idempotent");
    assert.equal(afterFirst.reconciliations.length, 1);
    assert.equal(auditWrites + afterFirst.audit.filter((row) => row.action === "gmail_direct_estimate_submission_reconciled").length, 2, "sync audit plus exactly one explicit reconciliation audit");
    assert.equal(afterFirst.audit.filter((row) => row.action === "case_progress_updated").length, 1);
    assert.equal(before.progress.estimate_sent_on, null, "Gmail direct sync alone leaves progress unchanged");
    assert.equal(first.progress.estimate_sent_on, "2026-09-01");
    assert.equal(Date.parse(first.submitted_at), Date.parse(synced.messages[0].occurred_at), "the immutable date comes from the same canonical Gmail message");
    assert.deepEqual(await dbFixture.state(db), afterFirst, "replay leaves dates, progress, and both audit histories byte-equivalent");

    await assert.rejects(gmail.reconcileEstimateSubmission({ ...reconciliationInput, gmailMessageId: "other_case_message" }, reconciliationFetch), /invalid_estimate_reconciliation/u, "a message identity outside this case cannot be reconciled");
    assert.deepEqual(await dbFixture.state(db), afterFirst, "cross-case rejection writes nothing");
    assert.match(client, /message\.source === "gmail_direct"/u, "timeline distinguishes Gmail direct send from PA-managed send");
    assert.match(client, /reconcile_estimate_submission/u, "stage change is behind an explicit reconciliation action");
    assert.match(migration, /unique \(inquiry_id, gmail_message_id\)/u, "database uniqueness prevents duplicate reconciliation history");
    assert.match(migration, /does not change workflow stage itself/u, "direct Gmail sync never advances stage by itself");
    await db.close();
    console.log("PAM-007 Gmail direct Sent reconciliation validation: PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });

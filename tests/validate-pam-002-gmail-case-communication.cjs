const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const gmail = require(path.join(root, "api", "_pa-gmail.cjs"));
const mail = require(path.join(root, "api", "_pa-mail.cjs"));
const security = require(path.join(root, "api", "_request-security.cjs"));

assert.equal(gmail.validGmailId("18f8A-_z"), true);
assert.equal(gmail.validGmailId("bad thread id"), false);
assert.equal(gmail.caseReference("PA-20260901-00013"), true);
assert.equal(gmail.caseReference("PA-20260901-00013-extra"), false);

const raw = Buffer.from(mail.buildRawMessage({
    to: "customer@example.com",
    subject: "Re: 件名",
    body: "本文",
    messageType: "customer_receipt",
    replyHeaders: { inReplyTo: "<message@example.com>", references: "<message@example.com>" },
    config: {
        senderAddress: "aratechsound@gmail.com",
        senderName: "ARA-TECH",
        replyTo: "aratechsound@gmail.com",
        signature: "ARA-TECH"
    }
}), "base64url").toString("utf8");
assert.match(raw, /In-Reply-To: <message@example\.com>/u);
assert.match(raw, /References: <message@example\.com>/u);

["PA_GMAIL_SYNC", "PA_GMAIL_MANUAL_LINK", "PA_GMAIL_ATTACHMENT_GET", "PA_GMAIL_REPLY_PREVIEW", "PA_GMAIL_SEND_REPLY"].forEach((policy) => {
    assert.equal(security.getRateLimitPolicy(policy).identity, "scope");
});

const migration = read("supabase/migrations/20260902130000_pam002_gmail_case_communication.sql");
assert.match(migration, /create table public\.pa_gmail_thread_links/u);
assert.match(migration, /unique \(gmail_thread_id\)/u);
assert.match(migration, /address-only matching is forbidden/u);
assert.match(migration, /create table public\.pa_gmail_message_index/u);
assert.match(migration, /create table public\.pa_case_mail_attention/u);
assert.doesNotMatch(migration, /^\s*(update|insert|delete|drop)\b|alter table public\.pa_inquiries/imu);

const authorityMigration = read("supabase/migrations/20260902143000_pam002_gmail_conversation_authority.sql");
assert.match(authorityMigration, /add column conversation_role text not null default 'secondary_conversation'/u);
assert.match(authorityMigration, /primary_conversation/u);
assert.match(authorityMigration, /system_acknowledgement/u);
assert.match(authorityMigration, /where conversation_role = 'primary_conversation'/u);
assert.doesNotMatch(authorityMigration, /^\s*(update|insert|delete|drop)\b/imu);

const api = read("api/pa-gmail.js");
assert.match(api, /verifyAdmin\(bearer\(request\)\)/u);
assert.match(api, /applyOriginPolicy/u);
assert.match(api, /checkRateLimit/u);
assert.match(api, /confirmation_token/u);
assert.match(api, /attachment_download/u);

const client = read("js/pa-admin.js");
assert.match(client, /action: "sync"/u);
assert.match(client, /action: "manual_link"/u);
assert.match(client, /action: "reply_preview"/u);
assert.match(client, /action: "send_reply"/u);
assert.match(client, /action: "attachment_download"/u);
assert.match(client, /案件工程は変更していません/u);
assert.doesNotMatch(client, /\.update\(\{\s*status:\s*["']customer_responded/u);

const gmailService = read("api/_pa-gmail.cjs");
assert.match(gmailService, /resolveExactDelivery\(hearing, fetchImpl\)/u);
assert.match(gmailService, /role: "primary_conversation"/u);
assert.match(gmailService, /role: "system_acknowledgement"/u);
assert.match(gmailService, /const fallbackCandidates/u);
assert.ok(gmailService.indexOf("resolveExactDelivery(hearing, fetchImpl)") < gmailService.indexOf("fallbackCandidates(inquiry, hearing, fetchImpl)"));
assert.match(gmailService, /new Map\(indexed\.flatMap\(\(result\) => result\.messages\)\.map\(\(message\) => \[message\.id, message\]\)\)/u);
assert.match(gmailService, /getPrimaryLink\(inquiryId, fetchImpl\)/u);
assert.match(gmailService, /pa_inquiry_audit[\s\S]{0,600}prefer: "return=representation"/u);
assert.doesNotMatch(gmailService, /recipient-only/iu);
assert.match(gmailService, /latest\?\.direction === "inbound"/u);
assert.match(gmailService, /latest\?\.to_addresses/u);
assert.doesNotMatch(gmailService, /latest\?\.direction !== "inbound"/u);

console.log("PAM-002 Gmail case communication validation: PASS");

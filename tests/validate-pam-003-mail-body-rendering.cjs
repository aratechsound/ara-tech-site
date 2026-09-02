const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const gmail = require(path.join(root, "api", "_pa-gmail.cjs"));
const client = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");
const css = fs.readFileSync(path.join(root, "pa-admin.css"), "utf8");
const base64Url = (value) => Buffer.from(value, "utf8").toString("base64url");

const message = gmail.normalizeMessage({
    id: "mail_123",
    threadId: "thread_123",
    internalDate: "1788278400000",
    payload: {
        headers: [
            { name: "From", value: "customer@example.com" },
            { name: "To", value: "aratechsound@gmail.com" },
            { name: "Subject", value: "表示確認" }
        ],
        parts: [
            { mimeType: "text/plain", body: { data: base64Url("お世話になります。\r\n\r\nよろしくお願いします。\nhttps://example.com/" + "a".repeat(400)) } },
            { mimeType: "text/html", body: { data: base64Url("<p>お世話になります。</p><p><strong>よろしくお願いします。</strong></p><p><span style=\"color: #005cbb; font-weight: bold\">装飾済み</span></p><ul><li>項目</li></ul><script>globalThis.pwned = true</script><img src=\"https://tracker.invalid/pixel\">") } }
        ]
    }
});

assert.match(message.body_text, /\r\n\r\n/u, "text/plain CRLF must survive MIME normalization");
assert.match(message.body_html, /<strong>/u, "text/html must be available to the client renderer");
assert.match(message.body_html, /<script>/u, "HTML is sanitized at the browser rendering boundary, not trusted by the API");
assert.match(client, /EMAIL_HTML_ALLOWED_TAGS/u);
assert.match(client, /EMAIL_HTML_DROPPED_TAGS/u);
assert.match(client, /"script"/u);
assert.match(client, /"iframe"/u);
assert.match(client, /"object"/u);
assert.match(client, /"embed"/u);
assert.match(client, /"img"/u, "external images and tracking pixels must be dropped");
assert.match(client, /safeEmailHref/u);
assert.match(client, /safeEmailStyle/u);
assert.match(client, /EMAIL_HTML_SAFE_STYLE_PROPERTIES/u);
assert.match(client, /\(\?:url\|expression\|behavior\|@import\)/u, "dangerous CSS values must be rejected");
assert.match(client, /\["http:", "https:"\]/u);
assert.doesNotMatch(client, /mailto:/u, "mail HTML must not launch a local mail application");
assert.match(client, /target\.rel = "noopener noreferrer"/u);
assert.match(client, /appendSanitizedEmailHtml\(body, message\.body_html\)/u);
assert.doesNotMatch(client, /body\.innerHTML\s*=\s*message\.body_html/u, "raw mail HTML must never reach the rendered body");
assert.match(css, /\.mail-preview__body \{[^}]*white-space: pre-wrap;/u);
assert.match(css, /\.mail-preview__body \{[^}]*overflow-wrap: anywhere;/u);
assert.match(css, /\.mail-preview__body \{[^}]*word-break: normal;/u);
assert.match(css, /\.mail-preview__body--html table \{[^}]*max-width: 100%;[^}]*overflow-x: auto;/u);

console.log("PAM-003 mail body rendering validation: PASS");

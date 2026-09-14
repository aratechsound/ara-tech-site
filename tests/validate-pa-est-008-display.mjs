import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirmationDisplayState } from "../js/pa-confirmation-display.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyPanel = fs.readFileSync(path.join(root, "js", "pa-contract-admin.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");
const html = fs.readFileSync(path.join(root, "pa-admin.html"), "utf8");

const classify = (accepted, active, state) => confirmationDisplayState({
    accepted,
    active,
    delivery: state ? { state } : null
}).label;

assert.equal(classify(false, true, "sent"), "回答待ち");
assert.equal(classify(false, true, "reconciled_sent"), "回答待ち");
assert.equal(classify(false, true, "definitely_not_sent"), "送信未完了");
assert.equal(classify(false, true, "failed_before_provider"), "送信未完了");
assert.equal(classify(false, true, "unknown"), "送信結果確認中");
assert.equal(classify(false, true, "unknown_after_provider_start"), "送信結果確認中");
assert.equal(classify(false, true), "送信結果確認中");
assert.equal(classify(true, false), "正式受注済み");
assert.equal(classify(false, false), "未発行");

assert.doesNotMatch(legacyPanel, /active:'回答待ち'/);
assert.doesNotMatch(legacyPanel, /pending\?'正式受注確認：お客様の回答待ち'/);
assert.match(legacyPanel, /active:'発行済み'/);
assert.match(admin, /pa-commercial-admin\.js\?v=pa-est-009/);
assert.match(html, /pa-admin\.js\?v=pa-est-009/);

console.log("PASS PA-EST-008 delivery/response display separation and cache binding");

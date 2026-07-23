const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const adminHtml = read("pa-admin.html");
const adminCss = read("pa-admin.css");
const adminJs = read("js/pa-admin.js");

const completed = [
    "schedule_unavailable",
    "declined",
    "cancelled",
    "closed"
];
const active = [
    "schedule_confirmed",
    "new",
    "reviewing",
    "second_form_not_issued",
    "second_form_issued",
    "customer_responded",
    "schedule_unconfirmed",
    "schedule_adjusting",
    "needs_confirmation",
    "on_hold"
];

const completedSetSource = adminJs.match(
    /const completedStatuses = new Set\(\[([\s\S]*?)\]\);/
);
assert.ok(completedSetSource, "completed status set must be declared");
const implementedCompleted = [
    ...completedSetSource[1].matchAll(/"([^"]+)"/g)
].map((match) => match[1]);

assert.deepEqual(implementedCompleted, completed);
active.forEach((status) => {
    assert.ok(!implementedCompleted.includes(status), `${status} must remain active`);
});

assert.match(adminJs, /const isCompletedStatus = \(status, progress = null\) =>/);
assert.match(adminJs, /Boolean\(progress\?\.closed_at\) \|\| completedStatuses\.has\(status\)/);
assert.match(adminJs, /const inquirySequenceNumber = \(inquiryNumber\) =>/);
assert.match(adminJs, /match\(\/\(\\d\+\)\$\/\)/);
assert.match(adminJs, /const compareCasesForList = \(a, b\) =>/);
assert.match(adminJs, /receivedTimestamp\(b\.received_at\) - receivedTimestamp\(a\.received_at\)/);
assert.match(adminJs, /inquirySequenceNumber\(b\.inquiry_number\) - inquirySequenceNumber\(a\.inquiry_number\)/);
assert.match(adminJs, /result\.sort\(compareCasesForList\)/);
assert.match(adminJs, /const isCompleted = isCompletedStatus\(item\.status, progress\)/);
assert.match(adminJs, /row\.classList\.toggle\("case-row--completed", isCompleted\)/);
assert.match(adminJs, /row\.dataset\.completionState = isCompleted \? "completed" : "active"/);
assert.match(adminJs, /completedStamp\.textContent = "済"/);
assert.match(adminJs, /completedStamp\.setAttribute\("aria-label", "ケースクローズ済み"\)/);
assert.match(adminJs, /completedStamp\.title = `ケースクローズ済み：/);

assert.match(adminJs, /openButton\.addEventListener\("click", \(\) => openCase\(item\.id\)\)/);
assert.match(adminJs, /#case-search"\)\.addEventListener\("input", renderCases\)/);
assert.match(adminJs, /#case-status-filter"\)\.addEventListener\("change", renderCases\)/);
assert.match(adminJs, /#case-sort"\)\.addEventListener\("change", renderCases\)/);
assert.match(adminJs, /stateCell\.append\(statusBadge\(item\.status\)\)/);
assert.match(adminJs, /currentCase = result\.data;[\s\S]*?await loadCases\(\);[\s\S]*?await openCase\(currentCase\.id\)/);
assert.match(adminJs, /applyCaseState\(apiResult\.case_state\);[\s\S]*?await loadCases\(\)/);
assert.match(adminJs, /const renderCaseTabs = \(\) =>/);
assert.match(adminJs, /activeCaseTab === "active" && isClosedCase\(item\)/);
assert.match(adminJs, /activeCaseTab\.startsWith\("year-"\)/);
assert.match(adminHtml, /value="received-desc">受付日時の新しい順/);
assert.doesNotMatch(adminHtml, /value="received-asc"/);
assert.doesNotMatch(adminHtml, /value="event-(?:asc|desc)"/);

assert.match(adminCss, /\.completed-stamp\s*\{[^}]*border-radius:\s*50%/s);
assert.match(adminCss, /\.completed-stamp\s*\{[^}]*transform:\s*rotate\(-8deg\)/s);
assert.match(adminCss, /\.case-reference\s*\{[^}]*flex-wrap:\s*wrap/s);
assert.match(adminCss, /\.case-row--completed td\s*\{[^}]*background:/s);
assert.match(adminCss, /\.case-row--completed td\s*\{[^}]*color:/s);
assert.doesNotMatch(adminCss, /\.case-row--completed[^{]*\{[^}]*opacity:/s);
assert.match(adminCss, /\.table-wrap\s*\{[^}]*max-width:\s*100%/s);
assert.match(adminCss, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/s);

assert.match(adminHtml, /pa-admin\.css\?v=ara-20260724-003/);
assert.match(adminHtml, /js\/pa-admin\.js\?v=ara-20260724-003/);

new vm.Script(adminJs.replace(/^import .*$/gm, ""), {
    filename: "js/pa-admin.js"
});

const helpersSource = adminJs.match(
    /const completedStatuses = new Set\(\[[\s\S]*?const compareCasesForList = \(a, b\) => \{[\s\S]*?\n\};/
);
assert.ok(helpersSource, "list ordering helpers must be extractable");

const helperContext = {};
vm.runInNewContext(
    `${helpersSource[0]}\nglobalThis.__helpers = { isCompletedStatus, compareCasesForList };`,
    helperContext
);
const { isCompletedStatus, compareCasesForList } = helperContext.__helpers;

assert.equal(isCompletedStatus("schedule_confirmed"), false);
completed.forEach((status) => assert.equal(isCompletedStatus(status), true));
active.forEach((status) => assert.equal(isCompletedStatus(status), false));

const sameReceivedAt = "2026-07-24T01:00:00Z";
const listFixture = [
    { inquiry_number: "PA-20260724-00006", status: "schedule_confirmed", received_at: sameReceivedAt },
    { inquiry_number: "PA-20260724-00007", status: "schedule_unavailable", received_at: sameReceivedAt },
    { inquiry_number: "PA-20260724-00008", status: "needs_confirmation", received_at: sameReceivedAt },
    { inquiry_number: "PA-20260724-00009", status: "declined", received_at: sameReceivedAt },
    { inquiry_number: "PA-20260724-00005", status: "reviewing", received_at: "2026-07-24T02:00:00Z" },
    { inquiry_number: "PA-20260724-00004", status: "closed", received_at: "2026-07-24T03:00:00Z" }
];
const activeFixture = listFixture
    .filter((item) => !isCompletedStatus(item.status))
    .sort(compareCasesForList);
assert.deepEqual(
    activeFixture.map((item) => item.inquiry_number),
    [
        "PA-20260724-00005",
        "PA-20260724-00008",
        "PA-20260724-00006"
    ]
);
const closedFixture = listFixture
    .filter((item) => isCompletedStatus(item.status))
    .sort(compareCasesForList);
assert.deepEqual(
    closedFixture.map((item) => item.inquiry_number),
    [
        "PA-20260724-00004",
        "PA-20260724-00009",
        "PA-20260724-00007"
    ]
);

const sameGroupNumbers = [6, 7, 8, 9].map((number) => ({
    inquiry_number: `PA-20260724-${String(number).padStart(5, "0")}`,
    status: "reviewing",
    received_at: sameReceivedAt
}));
assert.deepEqual(
    sameGroupNumbers.sort(compareCasesForList).map((item) => inquirySequenceNumberForTest(item.inquiry_number)),
    [9, 8, 7, 6]
);

console.log("ARA-20260724-002 completed-state and list-order regression validation passed");

function inquirySequenceNumberForTest(inquiryNumber) {
    return Number.parseInt(inquiryNumber.match(/(\d+)$/)[1], 10);
}

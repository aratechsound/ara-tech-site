'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'..'),base='d541006c81f70a1c4ee093b41ad140b20cc486f2';
const git=(...args)=>cp.execFileSync('git',args,{cwd:root});
// Exact production baseline: tests, business APIs, sync, sender and legacy UI.
const protectedFiles=['api/_pa-gmail.cjs','api/_pa-mail.cjs','api/_pa-reply-operations.cjs','api/_pa-reply-proof.cjs','api/_pa-commercial.cjs','api/_pa-commercial-handler.cjs','api/_pa-change-evidence.cjs','pa-ui/js/case-workflows.mjs','pa-ui/js/commercial-workflows.mjs','pa-ui/js/mail-discovery.mjs','pa-ui/js/order-documents.mjs','pa-ui/js/quote-adoption.mjs','pa-ui/js/quote-history.mjs','pa-ui/js/portal-document-view.mjs','pa-admin-legacy.html','vercel.json'];
// PAUI-063 separately authorizes the reviewed document-workflow integration.
const scope=JSON.parse(fs.readFileSync(path.join(root,'docs/PAUI-063-reviewed-scope.json'),'utf8'));
assert.equal(scope.task_id,'PAUI-063');assert.equal(scope.schema_apply,false);assert.equal(scope.origin_change,false);assert.equal(scope.legacy_change,false);
const invoiceScope=JSON.parse(fs.readFileSync(path.join(root,'docs/PAUI-064-reviewed-scope.json'),'utf8'));
assert.equal(invoiceScope.task_id,'PAUI-064');assert.equal(invoiceScope.production_base,'f58efac7c428628b7330d307efc9025b1b961ba1');
for(const k of ['schema_apply','origin_change','legacy_change','customer_send'])assert.equal(invoiceScope[k],false);
const generalScope=JSON.parse(fs.readFileSync(path.join(root,'docs/PAUI-068-reviewed-scope.json'),'utf8'));
assert.equal(generalScope.task_id,'PAUI-068');for(const k of ['production_changed','db_applied','gmail_send'])assert.equal(generalScope[k],false);
const generalAllowed=["api/_ara-unlinked-mail.cjs", "api/_pa-mail-discovery.cjs", "api/pa-gmail.js", "api/_ara-inbox-registration.cjs", "pa-ui/js/desk.mjs", "pa-ui/js/model.mjs", "pa-ui/js/case-workflows.mjs", "pa-ui/js/general-inbox.mjs", "pa-ui/brand-black.css", "ops/PAUI-066-thread-identity-guard-CANDIDATE.sql", "ops/PAUI-068-inbox-message-registration-CANDIDATE.sql", "docs/PAUI-066-isolated-implementation-review.md"];
assert.deepEqual(Object.keys(generalScope.reviewed_product_files).sort(),[...generalAllowed].sort());
for(const [p,sha]of Object.entries(generalScope.reviewed_test_files))assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),sha,p+' PAUI-068 audited test changed');
// PAUI-069: exact direct-intake product scope and individually reviewed
// legacy-contract tests. No prefix/pattern exceptions to protected files.
const directScope=JSON.parse(fs.readFileSync(path.join(root,'docs/PAUI-069-reviewed-scope.json'),'utf8'));
assert.equal(directScope.task_id,'PAUI-069');assert.equal(directScope.inherited_source,'b5f2dfd551d7d25c37325adfa15b0fa1d849d0cb');
for(const k of ['production_changed','db_applied','gmail_send'])assert.equal(directScope[k],false);
assert.deepEqual(Object.keys(directScope.reviewed_product_files).sort(),['api/pa-inquiry.js','general-inquiry.html','js/ara-general-inquiry.js']);
assert.deepEqual(Object.keys(directScope.reviewed_test_files).sort(),['tests/validate-ara-case-r3-config.cjs','tests/validate-ara-case-r3.cjs','tests/validate-ara-direct-intake-069.cjs']);
for(const [p,sha]of Object.entries(directScope.reviewed_test_files))assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),sha,p+' PAUI-069 audited test changed');
// PAUI-071: allowlist exactly TWO independently SHA-reviewed obsolete Formspree
// static tests, replaced with mandatory fail-closed COMMON direct-intake checks.
// All unrelated legacy regressions remain pinned to their historical Git blobs.
const routing071=JSON.parse(fs.readFileSync(path.join(root,'docs/PAUI-071-reviewed-scope.json'),'utf8'));
assert.equal(routing071.task_id,'PAUI-071');
assert.equal(routing071.base_commit,'73bdc0a738e3325fc6d0df9b523a4954d6359277');
assert.equal(routing071.side_effects_allowed,false);
const routing071Paths=['tests/validate-ara-20260723-003.cjs','tests/validate-ara-20260724-004.cjs'];
assert.deepEqual(Object.keys(routing071.reviewed_test_files).sort(),routing071Paths);
const routing071Pinned = {"tests/validate-ara-20260723-003.cjs":"e7fa544ae823f8f2b4d4f42222ee710990145e23afda8abab02200111fd63752","tests/validate-ara-20260724-004.cjs":"a6caf240e847df3ab538933570dc9d819dd0b19d5504312b07d39881c2029577"};
assert.deepEqual(routing071.reviewed_test_files,routing071Pinned,'PAUI-071 exact SHA allowlist manifest drift');
for(const [p,sha]of Object.entries(routing071.reviewed_test_files)){
 assert.match(sha,/^[a-f0-9]{64}$/);
 assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),sha,p+' PAUI-071 reviewed legacy Formspree test changed');
}

// PAUI-072: exact six-file fixture/test repairs; product scopes and all older
// byte/hash protections remain mandatory. No prefix or arbitrary manifest SHA.
const repair072=JSON.parse(fs.readFileSync(path.join(root,'docs/PAUI-072-reviewed-scope.json'),'utf8'));
assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'docs/PAUI-072-reviewed-scope.json'))).digest('hex'),'cea97166f54919a19f89230e9aef7f9f9ccda0eb2bf82e0280d3f4dc71cc8f74','PAUI-072 scope manifest bytes changed');
const repair072Pinned={"tests/start-ara-case-postgres.py":"5e8195ae370447665ff77fb964d67624745fd58a4ca6310e9158b0c7e852a8ce","tests/validate-ara-integration-063-browser.cjs":"3bc042eb19e1d437ad190319b2a6dd95fdcbfbfbc2a178e1ca61f6a336ff9e8a","tests/helpers/reply-route-preservation.cjs":"a7a8d939cda0a2f5e0d05e6cd87149b07879c359cfa26b6afe3684e9c8bb8dbf","tests/helpers/reviewed-fixture-transition.cjs":"c1ca2655025c12cd3826946a16b2ae5faf14d7070a3e164de3d8c4a02ef3906c","tests/validate-ara-paui-integration.cjs":"dd8afbee5f48fb0323281925ef9dd11acb7343ecd14bb710a796b16df0c2967c","tests/validate-ara-paui038-excerpts.cjs":"d7016af42a4b40076c3e21c1a74eb885fbf9c3b989f7a4a43732d427209086cb"};
assert.equal(repair072.task_id,'PAUI-072');assert.equal(repair072.base_commit,'73bdc0a738e3325fc6d0df9b523a4954d6359277');
for(const k of ['product_code_changed','production_changed','production_db_apply','gmail_send'])assert.equal(repair072[k],false);
assert.deepEqual(repair072.allowed_changes,["docs/PAUI-072-reviewed-scope.json", "tests/helpers/reply-route-preservation.cjs", "tests/helpers/reviewed-fixture-transition.cjs", "tests/start-ara-case-postgres.py", "tests/validate-ara-download-release-boundary.cjs", "tests/validate-ara-integration-063-browser.cjs", "tests/validate-ara-paui-integration.cjs", "tests/validate-ara-paui038-excerpts.cjs"],'PAUI-072 allowed paths changed');
assert.deepEqual(repair072.reviewed_files,repair072Pinned,'PAUI-072 exact repair manifest drift');
for(const [p,h]of Object.entries(repair072Pinned))assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),h,p+' PAUI-072 exact repair changed');
const reviewed={...scope.reviewed_product_files,...invoiceScope.reviewed_product_files,...generalScope.reviewed_product_files,...directScope.reviewed_product_files,...directScope.reviewed_test_files};
for(const [p,sha]of Object.entries({...reviewed,...scope.approved_sql,...invoiceScope.reviewed_test_helpers}))assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),sha,p+' reviewed scope mismatch');
const tracked=git('ls-tree','-r','--name-only',base).toString().trim().split('\n');
// PAUI-062's unified editable composer supersedes two old screen-specific UI
// fixtures. Pin their reviewed replacements; every other baseline remains exact.
// PAUI-066 audited safety correction: one exact protected legacy regression
// changed to reject cross-customer mail in an already linked thread. Do not
// alter any other baseline test; fingerprint reviewed before release.
const reviewed066Tests={'tests/validate-ara-paui041-discovery.cjs':'78ad7176190e398c40cc8eeacdf80e33ae1112dd29bde14b5ba138334dfaf72f'};
const unifiedUi={
 'tests/validate-ara-case-workflows-browser.cjs':'76fcc20af5e577da5b1be53104cf6363f927f39e5d0885a5578dae9b3a10b4cf',
 'tests/validate-ara-candidate-recovery-browser.cjs':'d175ec32ee1c17a9012308424e2bfbab6ec4ad1de9c1bda3c3dde780e1dcb475'
};
for(const p of new Set([...protectedFiles.filter(p=>tracked.includes(p)),...tracked.filter(p=>p.startsWith('tests/')||p.startsWith('ops/')||p.startsWith('.github/'))])){
 const bytes=fs.readFileSync(path.join(root,p));if(repair072Pinned[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),repair072Pinned[p],p+' PAUI-072 repair changed');else if(reviewed[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),reviewed[p],p+' reviewed integration changed');else if(routing071.reviewed_test_files[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),routing071.reviewed_test_files[p],p+' PAUI-071 safety contract changed');else if(reviewed066Tests[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),reviewed066Tests[p],p+' PAUI-066 cross-customer guard changed');else if(unifiedUi[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),unifiedUi[p],p+' unified UI contract changed');
 else assert.deepEqual(bytes,git('show',base+':'+p),p+' production contract changed');
}
// Preserve every PAUI-063 regression verbatim except this scope validator and
// the explicitly pinned shared fixture's read-only invoice-history response.
const previousTests=git('ls-tree','-r','--name-only',invoiceScope.production_base).toString().trim().split('\n').filter(p=>p.startsWith('tests/'));
for(const p of previousTests){if(p==='tests/validate-ara-download-release-boundary.cjs')continue;
 if(repair072Pinned[p]){assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),repair072Pinned[p],p+' PAUI-072 repaired regression changed');continue;}
 if(directScope.reviewed_test_files[p]){assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),directScope.reviewed_test_files[p],p+' PAUI-069 exact legacy contract changed');continue;}
 if(routing071.reviewed_test_files[p]){assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),routing071.reviewed_test_files[p],p+' PAUI-071 exact legacy contract changed');continue;}
 if(reviewed066Tests[p]){assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),reviewed066Tests[p],p+' PAUI-066 preserved regression changed');continue;}
 const bytes=fs.readFileSync(path.join(root,p));if(invoiceScope.reviewed_test_helpers[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),invoiceScope.reviewed_test_helpers[p]);
 else assert.deepEqual(bytes,git('show',invoiceScope.production_base+':'+p),p+' PAUI-063 regression changed');}
const backend=fs.readFileSync(path.join(root,'api/_pa-workspace-read.cjs'),'utf8');
assert(backend.includes('commercial_originals_read:true'));assert(!backend.includes('pa_case_mail_operation_v1'));assert(!backend.includes('contract-receipt'));assert(!backend.includes('pa_sent_quote_adopt'));
const save=fs.readFileSync(path.join(root,'api/_pa-original-download.cjs'),'utf8');assert(!save.includes("require('./_pa-gmail.cjs')"),'Shared sender is independent');
assert(fs.existsSync(path.join(root,'api/_pa-sent-quote.cjs')));assert(fs.existsSync(path.join(root,'api/_pa-reply-documents.cjs')));
assert.deepEqual(fs.readFileSync(path.join(root,'api/pa-case-trash.js')),git('show',scope.production_base+':api/pa-case-trash.js'),'Reuse existing trash authority');
console.log(JSON.stringify({status:'PASS',base,baseline_test_files_unchanged:tracked.filter(p=>p.startsWith('tests/')).length-2,unified_composer_ui_tests_migrated:2,reviewed_ui_test_hashes_pinned:true,production_business_sync_send_legacy_preserved:true,owner_authorized_063_integration_pinned:true,migrations:0,origin_changes:0,production_changes:0}));

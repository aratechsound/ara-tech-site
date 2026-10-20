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
 const bytes=fs.readFileSync(path.join(root,p));if(reviewed[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),reviewed[p],p+' reviewed integration changed');else if(reviewed066Tests[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),reviewed066Tests[p],p+' PAUI-066 cross-customer guard changed');else if(unifiedUi[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),unifiedUi[p],p+' unified UI contract changed');
 else assert.deepEqual(bytes,git('show',base+':'+p),p+' production contract changed');
}
// Preserve every PAUI-063 regression verbatim except this scope validator and
// the explicitly pinned shared fixture's read-only invoice-history response.
const previousTests=git('ls-tree','-r','--name-only',invoiceScope.production_base).toString().trim().split('\n').filter(p=>p.startsWith('tests/'));
for(const p of previousTests){if(p==='tests/validate-ara-download-release-boundary.cjs')continue;
 if(directScope.reviewed_test_files[p]){assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),directScope.reviewed_test_files[p],p+' PAUI-069 exact legacy contract changed');continue;}
 if(reviewed066Tests[p]){assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex'),reviewed066Tests[p],p+' PAUI-066 preserved regression changed');continue;}
 const bytes=fs.readFileSync(path.join(root,p));if(invoiceScope.reviewed_test_helpers[p])assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),invoiceScope.reviewed_test_helpers[p]);
 else assert.deepEqual(bytes,git('show',invoiceScope.production_base+':'+p),p+' PAUI-063 regression changed');}
const backend=fs.readFileSync(path.join(root,'api/_pa-workspace-read.cjs'),'utf8');
assert(backend.includes('commercial_originals_read:true'));assert(!backend.includes('pa_case_mail_operation_v1'));assert(!backend.includes('contract-receipt'));assert(!backend.includes('pa_sent_quote_adopt'));
const save=fs.readFileSync(path.join(root,'api/_pa-original-download.cjs'),'utf8');assert(!save.includes("require('./_pa-gmail.cjs')"),'Shared sender is independent');
assert(fs.existsSync(path.join(root,'api/_pa-sent-quote.cjs')));assert(fs.existsSync(path.join(root,'api/_pa-reply-documents.cjs')));
assert.deepEqual(fs.readFileSync(path.join(root,'api/pa-case-trash.js')),git('show',scope.production_base+':api/pa-case-trash.js'),'Reuse existing trash authority');
console.log(JSON.stringify({status:'PASS',base,baseline_test_files_unchanged:tracked.filter(p=>p.startsWith('tests/')).length-2,unified_composer_ui_tests_migrated:2,reviewed_ui_test_hashes_pinned:true,production_business_sync_send_legacy_preserved:true,owner_authorized_063_integration_pinned:true,migrations:0,origin_changes:0,production_changes:0}));

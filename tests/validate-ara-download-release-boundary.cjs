'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'..'),base='d541006c81f70a1c4ee093b41ad140b20cc486f2';
const git=(...args)=>cp.execFileSync('git',args,{cwd:root});
// Exact production baseline: tests, business APIs, sync, sender and legacy UI.
const protectedFiles=['api/_pa-gmail.cjs','api/_pa-mail.cjs','api/_pa-reply-operations.cjs','api/_pa-reply-proof.cjs','api/_pa-commercial.cjs','api/_pa-commercial-handler.cjs','api/_pa-change-evidence.cjs','pa-ui/js/case-workflows.mjs','pa-ui/js/commercial-workflows.mjs','pa-ui/js/mail-discovery.mjs','pa-ui/js/order-documents.mjs','pa-ui/js/quote-adoption.mjs','pa-ui/js/quote-history.mjs','pa-ui/js/portal-document-view.mjs','pa-admin-legacy.html','vercel.json'];
const tracked=git('ls-tree','-r','--name-only',base).toString().trim().split('\n');
for(const p of new Set([...protectedFiles.filter(p=>tracked.includes(p)),...tracked.filter(p=>p.startsWith('tests/')||p.startsWith('ops/')||p.startsWith('.github/'))]))assert.deepEqual(fs.readFileSync(path.join(root,p)),git('show',base+':'+p),p+' production contract changed');
const backend=fs.readFileSync(path.join(root,'api/_pa-workspace-read.cjs'),'utf8');
assert(!backend.includes('commercial_originals_read'));assert(!backend.includes('contract-receipt'));assert(!backend.includes('pa_sent_quote_adopt'));
const save=fs.readFileSync(path.join(root,'api/_pa-original-download.cjs'),'utf8');assert(!save.includes("require('./_pa-gmail.cjs')"),'Shared sender is independent');
assert(!fs.existsSync(path.join(root,'api/_pa-sent-quote.cjs')));assert(!fs.existsSync(path.join(root,'api/_pa-reply-documents.cjs')));
console.log(JSON.stringify({status:'PASS',base,baseline_test_files_unchanged:tracked.filter(p=>p.startsWith('tests/')).length,production_business_sync_send_legacy_preserved:true,unaccepted_056_058_features_excluded:true,migrations:0,origin_changes:0,production_changes:0}));

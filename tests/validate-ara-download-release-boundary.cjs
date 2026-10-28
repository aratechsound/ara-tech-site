"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base='01d93b0834e6077c5b2d5e7ca6231c8a0a8957a5';
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,maxBuffer:16*1024*1024});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');
// Advance the release boundary to the user's exact current Production source.
// Older reviewed manifests, SQL, business APIs, authorization, legacy UI and
// PAUI-079/080 candidates remain byte-exact to that deployed baseline.
const manifestPath='docs/PAUI-087-reviewed-scope.json';
const bytes=fs.readFileSync(path.join(root,manifestPath));
assert.equal(sha(bytes),'79d081f60b3319251941ed8a7622eb68d78e3ca86d21b4b86e06cf45d9efdfac','PAUI-087 reviewed scope manifest drift');
const scope=JSON.parse(bytes);
assert.equal(scope.task_id,'PAUI-087');assert.equal(scope.production_base,base);
assert.equal(scope.schema_apply,false);assert.equal(scope.gmail_send,false);
assert.deepEqual(scope.holds_preserved,['PAUI-079','PAUI-080']);
assert.deepEqual(scope.product_paths,['api/_pa-gmail.cjs']);
const exactPaths=['api/_pa-gmail.cjs','tests/helpers/assert-case-mail-sent.cjs','tests/validate-ara-candidate-recovery-browser.cjs','tests/validate-ara-case-workflows-browser.cjs','tests/validate-ara-direct-intake-069.cjs','tests/validate-ara-general-inquiry-068-browser.cjs','tests/validate-ara-invoice-ui-064-browser.cjs','tests/validate-ara-paui087-gmail-drafts.cjs','tests/validate-ara-reply-documents-browser.cjs','tests/validate-paui087.cjs','tests/validate-ara-paui-integration.cjs','tests/validate-ara-paui038-excerpts.cjs','tests/validate-ara-paui036-static.cjs'];
assert.deepEqual(Object.keys(scope.files).sort(),exactPaths.sort());
const baseline=new Map(git('ls-tree','-r','-z',base).toString('utf8').split('\0').filter(Boolean).map(entry=>{const [meta,p]=entry.split('\t'),[mode,type,id]=meta.split(' ');assert.equal(type,'blob');return [p,{mode,id}];}));
for(const [p,pin]of Object.entries(scope.files)){
 assert.equal(sha(fs.readFileSync(path.join(root,p))),pin.after_sha256,p+' reviewed postimage changed');
 if(baseline.has(p))assert.equal(sha(git('show',base+':'+p)),pin.before_sha256,p+' predecessor drift');
 else assert.equal(pin.before_sha256,null,p+' unexpected predecessor');
}
// Verify the complete implementation delta, including every original safety
// filter and index-write field. No arbitrary product hash exception is enough.
const before=git('show',base+':api/_pa-gmail.cjs').toString('utf8');
const old='    const messages = (thread.messages || []).map(normalizeMessage).filter((message) => {';
const replacement=`    // Drafts have the official From address, but have never been sent.
    // Filter the Gmail-owned label before direction inference and DB indexing.
    // Do not mutate Gmail originals or infer successful delivery from From.
    const messages = (thread.messages || []).filter(raw =>
        !Array.isArray(raw?.labelIds) || !raw.labelIds.includes("DRAFT")
    ).map(normalizeMessage).filter((message) => {`;
assert.equal(before.split(old).length,2);
assert.equal(fs.readFileSync(path.join(root,'api/_pa-gmail.cjs'),'utf8'),before.replace(old,replacement),'product delta exceeds the supplied DRAFT filter');
const exemptions=new Set([...exactPaths,manifestPath,'tests/validate-ara-download-release-boundary.cjs']);
// WORKS-202611: the Owner separately authorized this exact image-only release.
// Preserve the PAUI-087 proof above and all other historical source pins.
const worksManifestPath='docs/WORKS-202611-IMAGE-FIX-reviewed-scope.json';
const worksManifestBytes=fs.readFileSync(path.join(root,worksManifestPath));
assert.equal(sha(worksManifestBytes),'a4ba4a8834d42dc7819d94efb78c53ff3c74451434f0c431393ed4aeb03e00f8','WORKS reviewed scope manifest drift');
const worksScope=JSON.parse(worksManifestBytes);
assert.equal(worksScope.task_id,'WORKS-202611-IMAGE-FIX');
assert.equal(worksScope.production_base,'15cafac6bfa1919770f786359f770e43c0ec737d');
assert.deepEqual(worksScope.target_work_ids,[89,90,91,92,93,94,95,96,97,98]);
assert.deepEqual(worksScope.product_paths,['admin.html','js/admin.js','js/work-image-upload.mjs']);
assert.equal(worksScope.schema_apply,false);assert.equal(worksScope.gmail_send,false);assert.equal(worksScope.gmail_sync,false);
const worksPaths=['admin.html','js/admin.js','js/work-image-upload.mjs','tests/validate-ara-20261029-work-image-upload.cjs'];
assert.deepEqual(Object.keys(worksScope.files).sort(),worksPaths.sort());
for(const [p,pin]of Object.entries(worksScope.files)){
 assert.equal(sha(fs.readFileSync(path.join(root,p))),pin.after_sha256,p+' reviewed WORKS postimage changed');
 if(pin.before_sha256!==null)assert.equal(sha(git('show',worksScope.production_base+':'+p)),pin.before_sha256,p+' WORKS predecessor drift');
 else assert.equal(git('ls-tree',worksScope.production_base,'--',p).length,0,p+' unexpected WORKS predecessor');
 exemptions.add(p);
}
exemptions.add(worksManifestPath);
let preserved=0;
for(const [p,entry]of baseline){
 assert(fs.existsSync(path.join(root,p)),p+' baseline file deleted');
 if(exemptions.has(p))continue;
 assert.equal(blob(fs.readFileSync(path.join(root,p))),entry.id,p+' changed outside authorized scope');preserved++;
}
const index=git('ls-files','--stage','-z').toString('utf8').split('\0').filter(Boolean);
for(const entry of index){const [meta,p]=entry.split('\t'),[mode]=meta.split(' ');assert(baseline.has(p)||exemptions.has(p),p+' unexpected new tracked file');assert.equal(mode,baseline.get(p)?.mode||'100644',p+' mode changed');}
for(const p of exemptions)assert(index.some(e=>e.endsWith('\t'+p)),p+' reviewed file not tracked');
console.log(JSON.stringify({status:'PASS',task_id:'PAUI-087',production_base:base,baseline_files_preserved:preserved,product_delta:'exact supplied DRAFT filter only',test_contracts:'durable SENT closure and UNKNOWN/duplicate guards',schema_changes:0,gmail_send:0,prior_holds_preserved:true}));

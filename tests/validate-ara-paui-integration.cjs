'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),base='21fa957b1b5fc086e363156ceb677abd9fed412c';
const blob=p=>execFileSync('git',['show',base+':'+p],{cwd:root});
const protectedFiles=['pa-admin-legacy.html','js/pa-admin.js','api/pa-gmail.js','api/_pa-mail-discovery.cjs','pa-ui/js/mail-discovery.mjs','supabase/migrations/20261015140000_paui041_mail_discovery.sql'];
for(const p of protectedFiles){const current=fs.readFileSync(path.join(root,p));if(p==='api/pa-gmail.js')assert.equal(require('./helpers/reply-route-preservation.cjs')(current.toString()),blob(p).toString().replace(/\r\n/g,'\n'),'Existing handler bytes outside authorized reply extensions changed');else if(p==='api/_pa-mail-discovery.cjs')require('./helpers/reviewed-fixture-transition.cjs')(p,current.toString(),blob(p).toString());else assert(current.equals(blob(p)),'Protected legacy/discovery source changed: '+p);}
// Current release delta; historical source guards above remain mandatory.
const changed=execFileSync('git',['diff','--name-only','01d93b0834e6077c5b2d5e7ca6231c8a0a8957a5'],{cwd:root,encoding:'utf8'}).trim().split('\n');
assert(!changed.some(p=>p.startsWith('supabase/')||/semantic|paui037|ai-summary/i.test(p)),'No DB migration or paid AI component belongs to the integration');
const desk=fs.readFileSync(path.join(root,'pa-ui/js/desk.mjs'),'utf8');
for(const hook of ['newestMessages(rows).map','date(mailDateValue(r))','discovery.mount(selected)','discovery.check(selected)','discovery.cancel()'])assert(desk.includes(hook),'Lost PAUI040/041 behavior: '+hook);
assert(desk.includes('deliveryUnknown')&&desk.includes('warehouseItems'),'Missing adopted dependency');
// PAUI-072: real guard negatives, without touching source files or expected values.
const preserve=require('./helpers/reply-route-preservation.cjs'),handler=fs.readFileSync(path.join(root,'api/pa-gmail.js'),'utf8');
assert.throws(()=>preserve(handler+'\n// unauthorized handler change'),/exact reviewed Gmail handler changed/);
assert.throws(()=>preserve(handler.replace('actorId:user.id','actorId:null')),/exact reviewed Gmail handler changed/);
const transition=require('./helpers/reviewed-fixture-transition.cjs'),testPath='tests/validate-ara-20260723-003.cjs',testActual=fs.readFileSync(path.join(root,testPath),'utf8'),testPrevious=blob(testPath).toString();
transition(testPath,testActual,testPrevious);
assert.throws(()=>transition(testPath,testActual+'\n// unauthorized',testPrevious));
assert.throws(()=>transition(testPath,testActual,testPrevious+'\n// baseline drift'));
assert.throws(()=>transition('tests/unreviewed-negative.cjs','changed','original'));
console.log(JSON.stringify({status:'PASS',protected_files:protectedFiles.length,discovery_and_mail_order_hooks:5,migrations:0,paid_AI_components:0}));

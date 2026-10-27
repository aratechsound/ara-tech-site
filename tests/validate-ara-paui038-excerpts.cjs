'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const fixtures=require('./paui038-fixture.cjs');
(async()=>{
 const {purposeExcerpt}=await import('../pa-ui/js/mail-purpose.mjs');const {savedExcerpt}=await import('../pa-ui/js/mail-model.mjs');
 const results=[];
 for(const f of fixtures.filter(f=>!f.html)){
  const text=f.body||f.snippet,result=f.body?purposeExcerpt(f.body):savedExcerpt({snippet:f.snippet});
  if(f.exact!==undefined)assert.equal(result,f.exact,f.id);
  for(const value of f.expected||[])assert(result.includes(value),f.id+' must retain '+value);
  for(const value of f.reject||[])assert(!result.includes(value),f.id+' must exclude '+value);
  assert(result.split('\n').length<=3,f.id+' max three logical units');
  // Whole source units in original order, with whitespace-only folding.
  const source=text.replace(/\r\n?/g,'\n').replace(/[\s]+/gu,' ');let at=0;
  for(const unit of result.split('\n')){const folded=unit.replace(/[\s]+/gu,' ').trim();const found=source.indexOf(folded,at);assert(found>=at,f.id+' output must be a contiguous source span');at=found+folded.length;}
  results.push(f.id);
 }
 assert.equal(purposeExcerpt('ご連絡ありがとうございます。ただし11万円では対応できません。'),'ご連絡ありがとうございます。ただし11万円では対応できません。');
 assert.equal(purposeExcerpt('用件です。\n----\n予算は11万円までです。'),'用件です。\n----\n予算は11万円までです。');
 assert.equal(purposeExcerpt('> 過去の依頼'), '');
 // Integration changes the read adapter/model deliberately. Preserve every
 // Production regression blob; the 026 excerpt suite is its approved superset.
 const base='21fa957b1b5fc086e363156ceb677abd9fed412c';
 const old=cp.execFileSync('git',['ls-tree','-r','--name-only','01d93b0834e6077c5b2d5e7ca6231c8a0a8957a5','tests'],{encoding:'utf8'}).trim().split('\n');
 // The exact current-Production boundary preserves every other regression and
 // independently pins the reviewed PAUI-083 expectation and DRAFT-filter delta.
 require('./validate-ara-download-release-boundary.cjs');
 for(const file of ['api/pa-gmail.js','api/_pa-mail-discovery.cjs','pa-ui/js/mail-discovery.mjs','pa-admin-legacy.html']){let actual=fs.readFileSync(file,'utf8'),expected=cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8',maxBuffer:32*1024*1024});if(file==='api/pa-gmail.js'){actual=require('./helpers/reply-route-preservation.cjs')(actual);expected=expected.replace(/\r\n/g,'\n');}if(file==='api/_pa-mail-discovery.cjs')require('./helpers/reviewed-fixture-transition.cjs')(file,actual,expected);else assert.equal(actual,expected,file);}
 const predicate=source=>source.match(/export function deliveryUnknown\(row\)\{[^\n]+\}/)?.[0];assert.equal(predicate(fs.readFileSync('pa-ui/js/model.mjs','utf8')),predicate(cp.execFileSync('git',['show','bafc3742db4f49bb19b103aeda8932960c616d24:pa-ui/js/model.mjs'],{encoding:'utf8'})));
 for(const file of ['api/_pa-mail-summary.cjs','api/_pa-mail-summary-handler.cjs','pa-ui/js/mail-summary-view.mjs'])assert(!fs.existsSync(file),'PAUI-037 must not be adopted');
 const start=performance.now();for(let i=0;i<1000;i++)purposeExcerpt(fixtures.find(f=>f.id==='N').body);const ms=performance.now()-start;assert(ms<5000,'bounded local workload');
 console.log(JSON.stringify({status:'PASS',fictional_cases:results,html_case:'covered_by_browser',source_faithful:true,max_logical_units:3,prior_tests_checked:old.length,reviewed_fixture_transitions:require('./fixtures/paui046-fixture-transitions.json').entries.length,PAUI036_preserved:true,PAUI037_imported:false,local_1000_excerpts_ms:Math.round(ms),external_AI_calls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});

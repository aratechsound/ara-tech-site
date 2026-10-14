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
 const base='bafc3742db4f49bb19b103aeda8932960c616d24';const old=cp.execFileSync('git',['ls-tree','-r','--name-only',base,'tests'],{encoding:'utf8'}).trim().split('\n');
 for(const file of [...old,'pa-ui/js/model.mjs','api/_pa-workspace-read.cjs','api/pa-gmail.js'])assert.equal(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8',maxBuffer:32*1024*1024}).replace(/\r\n/g,'\n'),file);
 for(const file of ['api/_pa-mail-summary.cjs','api/_pa-mail-summary-handler.cjs','pa-ui/js/mail-summary-view.mjs'])assert(!fs.existsSync(file),'PAUI-037 must not be adopted');
 const start=performance.now();for(let i=0;i<1000;i++)purposeExcerpt(fixtures.find(f=>f.id==='N').body);const ms=performance.now()-start;assert(ms<5000,'bounded local workload');
 console.log(JSON.stringify({status:'PASS',fictional_cases:results,html_case:'covered_by_browser',source_faithful:true,max_logical_units:3,prior_test_contents_preserved:old.length,PAUI036_preserved:true,PAUI037_imported:false,local_1000_excerpts_ms:Math.round(ms),external_AI_calls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});

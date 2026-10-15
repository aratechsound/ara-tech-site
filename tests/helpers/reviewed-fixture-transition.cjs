'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const manifest=require('../fixtures/paui046-fixture-transitions.json');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
module.exports=(file,actual,expected)=>{
 const entry=manifest.entries.find(e=>e.file===file);
 if(!entry)return assert.equal(actual,expected,file);
 assert.equal(entry.task_id,'PAUI-046');assert(entry.reason.length>20);
 assert.equal(sha(expected),entry.previous_sha256,file+' original fixture must remain the reviewed baseline');
 assert.equal(sha(actual),entry.candidate_sha256,file+' must match the exact reviewed fixture transition');
};

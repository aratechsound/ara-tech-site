'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const manifest=require('../fixtures/paui046-fixture-transitions.json');
const fs=require('node:fs'),path=require('node:path');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const reviewed072={"tests/validate-ara-20260723-003.cjs":{"previous_sha256":"1cfb9c78016bfea458ac88e9b27b343ec13e890a7475d96afffee706bb43d1a8","candidate_sha256":"e7fa544ae823f8f2b4d4f42222ee710990145e23afda8abab02200111fd63752"},"tests/validate-ara-20260724-004.cjs":{"previous_sha256":"87dae3656b59cea786a5404fab239e29ad52fd406e02c56305e725e74ae47fdd","candidate_sha256":"a6caf240e847df3ab538933570dc9d819dd0b19d5504312b07d39881c2029577"},"tests/validate-ara-case-r3-config.cjs":{"previous_sha256":"0e9818b633e1c20b017821d5d34f0269541823527f0c6d22fab45f530da8adf7","candidate_sha256":"4477d8be54683f26fabe8c01704a6030fc4a5764eddb60206175c77e01c7b05c"},"tests/validate-ara-case-r3.cjs":{"previous_sha256":"9c27ba1e913d754092ec7e79c50e7f8c4c1bb1953e2c111cdd4468c3b986bcd0","candidate_sha256":"57fa5774787e20dd6aee49a47d42f7ad80dae18bd9938cfd86e2b9511232562f"},"tests/validate-ara-paui041-discovery.cjs":{"previous_sha256":"84ca0992fbd621a9772073d0321a3cf1b6db07eb3b3fe1b88bc7c4cde60bb8d5","candidate_sha256":"78ad7176190e398c40cc8eeacdf80e33ae1112dd29bde14b5ba138334dfaf72f"},"tests/start-ara-case-postgres.py":{"previous_sha256":"c9a8dc20b0df7267bb94eebe005c8f80c2f574768afab4fce5cafa125bb85041","candidate_sha256":"5e8195ae370447665ff77fb964d67624745fd58a4ca6310e9158b0c7e852a8ce"},"api/_pa-mail-discovery.cjs":{"previous_sha256":"90f185b85b298da17c38b664e9fedc53ab6fca084a82edf7eb6b44c7eb414784","candidate_sha256":"3ec6cfedd6184494bf7b45ac608d18db850c2ac1c97043fd96c5887e30acc8bb"}};
assert.equal(sha(fs.readFileSync(path.join(__dirname,'../fixtures/paui046-fixture-transitions.json'))),'63c9b8e7a2ae40e5da8bf12e9f4b04ce4e36e77eaf2ed842fb687c5235f53f09','PAUI-046 original transition manifest changed');
module.exports=(file,actual,expected)=>{
 const pair=reviewed072[file];if(pair){assert.equal(sha(expected),pair.previous_sha256,file+' PAUI-072 historical baseline changed');assert.equal(sha(actual),pair.candidate_sha256,file+' PAUI-072 exact reviewed transition changed');return;}

 const entry=manifest.entries.find(e=>e.file===file);
 if(!entry)return assert.equal(actual,expected,file);
 assert.equal(entry.task_id,'PAUI-046');assert(entry.reason.length>20);
 assert.equal(sha(expected),entry.previous_sha256,file+' original fixture must remain the reviewed baseline');
 assert.equal(sha(actual),entry.candidate_sha256,file+' must match the exact reviewed fixture transition');
};

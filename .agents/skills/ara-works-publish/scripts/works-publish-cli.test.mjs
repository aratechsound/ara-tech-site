import {test} from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSignature, isPublished, imageAllowed, imageOmitted, publishWithRuntime } from './works-publish-cli.mjs';
const sha='a'.repeat(64);
const base={id:99,is_published:false,publication_review_status:'publication_pending_approval',candidate_hash:sha,flyer_path:'flyers/x.jpg',image_usage_status:'confirmed',use_image_on_public_page:true,public_image_sha256:sha,image_publication_confirmed_at:'now',image_publication_confirmed_by:'uid'};
const cli=fileURLToPath(new URL('./works-publish-cli.mjs',import.meta.url));
function run(...args){const dir=mkdtempSync(join(tmpdir(),'ara-works-cli-test-'));try{const p=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,LOCALAPPDATA:dir}});return JSON.parse(p.stdout);}finally{rmSync(dir,{recursive:true,force:true});}}
test('pending candidate is not formally published',()=>assert.equal(isPublished(base),false));
test('formal publication must have matching hashes and actor/time',()=>{
 const p={...base,is_published:true,publication_review_status:null,approved_hash:sha,approved_at:'now',approved_by:'uid'};
 assert.equal(isPublished(p),true);
 assert.equal(isPublished({...p,approved_hash:'b'.repeat(64)}),false);
 assert.equal(isPublished({...p,approved_by:null}),false);
});
test('image verification requires confirmed and storage SHA',()=>{
 assert.equal(imageAllowed(base),true);
 assert.equal(imageAllowed({...base,image_publication_confirmed_by:null}),false);
 assert.equal(imageAllowed({...base,public_image_sha256:'wrong'}),false);
 assert.equal(imageAllowed({...base,use_image_on_public_page:false}),false);
});
test('explicit omission is allowed but not confused with confirmed image',()=>{
 const p={...base,use_image_on_public_page:false,image_usage_status:'not_permitted'};
 assert.equal(imageOmitted(p),true);assert.equal(imageAllowed(p),false);
 assert.equal(imageOmitted(base),false);
});
test('JPEG signature check',()=>{const b=Buffer.alloc(32);b[0]=255;b[1]=216;b[2]=255;assert.equal(imageSignature(b,'image/jpeg'),true);assert.equal(imageSignature(b,'image/png'),false);});
test('PNG signature check',()=>{const b=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);assert.equal(imageSignature(b,'image/png'),true);});
test('WebP signature check',()=>{const b=Buffer.alloc(32);b.write('RIFF',0);b.write('WEBP',8);assert.equal(imageSignature(b,'image/webp'),true);});
test('unsupported content type rejected',()=>{const b=Buffer.alloc(32);assert.equal(imageSignature(b,'text/html'),false);});
test('invalid candidate hash fails before credential access',()=>{const r=run('publish','--id','99','--hash','bad','--owner-ref','approved');assert.equal(r.result,'HOLD');assert.equal(r.reason,'invalid_review_pin');});
test('missing one-time login prevents any publish RPC',()=>{const r=run('publish','--id','99','--hash',sha,'--owner-ref','approved');assert.equal(r.result,'HOLD');assert.equal(r.reason,'one_time_login_required');});

function runtime(options={}){
 let calls=0,reads=0,row=structuredClone(base);
 const run=()=>publishWithRuntime({id:99,expected:sha,owner:'WKS-002 explicit event approval',
  authorize:async()=>{if(options.auth)throw Error(options.auth);return {id:'uid'};},
  readWork:async()=>{reads++;if(options.change&&reads===2)row.candidate_hash='b'.repeat(64);if(options.readFail&&reads===3)throw Error('network');return structuredClone(row);},
  verifyImage:async()=>({sha256:options.imageBad?'c'.repeat(64):sha,decoded:true}),
  callRpc:async args=>{calls++;assert.deepEqual(args,{p_work_id:99,p_candidate_hash:sha});if(!options.uncommitted)Object.assign(row,{is_published:true,publication_review_status:null,approved_hash:sha,approved_at:'now',approved_by:'uid'});if(options.lost)throw Error('lost');return [{result:'published'}];}});
 return {run,calls:()=>calls};
}
test('CLI runtime rejects absent login and missing admin membership before RPC',async()=>{for(const auth of ['one_time_login_required','work_admins_membership_missing']){const h=runtime({auth});await assert.rejects(h.run,new RegExp(auth));assert.equal(h.calls(),0);}});
test('CLI runtime rejects candidate hash changed during image validation',async()=>{const h=runtime({change:true});await assert.rejects(h.run,/candidate_changed/);assert.equal(h.calls(),0);});
test('CLI runtime rejects verified image SHA mismatch',async()=>{const h=runtime({imageBad:true});await assert.rejects(h.run,/image_sha256_mismatch/);assert.equal(h.calls(),0);});
test('CLI runtime publishes once then skips re-execution',async()=>{const h=runtime();assert.equal((await h.run()).result,'PUBLISHED');assert.equal((await h.run()).result,'ALREADY_PUBLISHED');assert.equal(h.calls(),1);});
test('CLI lost RPC response is recovered using committed readback',async()=>{const h=runtime({lost:true});assert.equal((await h.run()).result,'PUBLISHED');assert.equal(h.calls(),1);});
test('CLI unknown RPC result without commit is HOLD, never automatic retry',async()=>{const h=runtime({lost:true,uncommitted:true});assert.equal((await h.run()).result,'HOLD');assert.equal(h.calls(),1);});
test('CLI readback failure after RPC reports one attempt and HOLD',async()=>{const h=runtime({lost:true,readFail:true});const r=await h.run();assert.equal(r.reason,'post_rpc_readback_failed');assert.equal(r.rpcAttempts,1);assert.equal(h.calls(),1);});

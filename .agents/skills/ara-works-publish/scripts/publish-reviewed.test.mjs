import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishReviewed,resolveExisting,restoreWorksAdministrator} from './publish-reviewed.mjs';
import {assessWorksRuntime,prepareWorksHandoff} from './runtime-routing.mjs';
const hash='a'.repeat(64),sha='b'.repeat(64);
const base={id:99,title:'Fixture concert',event_date:'2026-11-21',venue:'Fixture Hall',area:'Hiroshima',performer_name:'Fixture artist',lifecycle_status:'upcoming',assignment_items:['pa_operation'],official_announcement_url:'https://venue.example/event',candidate_hash:hash,is_published:false,publication_review_status:'publication_pending_approval',flyer_path:'flyers/existing.jpg',public_image_source_url:'https://venue.example/image.jpg',public_image_sha256:sha,image_usage_status:'confirmed',use_image_on_public_page:true,image_publication_confirmed_at:'2026-11-05',image_publication_confirmed_by:'admin',slug:'actual-slug'};
function harness(options={}) {
    const pin={...base,...options.fields};
    let row=structuredClone(pin), reads=0, calls=0;
    const client={auth:{getUser:async()=>({data:{user:options.auth===false?null:{id:'admin'}}})},
        from(table){return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:options.admin===false?null:{user_id:'admin'}}),single:async()=>{reads++; if(options.change && reads===2) row.candidate_hash='c'.repeat(64);return {data:structuredClone(row)};}};},
        async rpc(name,args){calls++;assert.equal(name,'publish_work_candidate');assert.deepEqual(args,{p_work_id:99,p_candidate_hash:hash});if(!options.fail) Object.assign(row,{is_published:true,publication_review_status:null,approved_hash:row.candidate_hash,approved_at:'now',approved_by:'admin'});if(options.lost)throw Error('lost');return {data:[{result:'published'}]};}};
    const run=overrides=>publishReviewed({client,pin:structuredClone(pin),authorization:{workId:99,candidateHash:hash,actorId:'admin',instructionRef:'Owner WKS-002 explicit event publication',publish:true,image:pin.use_image_on_public_page},verifyImage:async()=>({sha256:sha,decoded:true}),...overrides});
    return {run,calls:()=>calls};
}
test('explicit reviewed scope publishes using one RPC and readback; rerun skips',async()=>{const h=harness();assert.equal((await h.run()).status,'published');assert.equal((await h.run()).status,'already_published');assert.equal(h.calls(),1);});
test('wrong work or missing explicit publication authorization sends nothing',async()=>{const h=harness();assert.equal((await h.run({authorization:{workId:98}})).reason,'authorization_scope_missing');assert.equal(h.calls(),0);});
test('unauthenticated and non-admin clients cannot publish',async()=>{for(const opt of [{auth:false},{admin:false}]){const h=harness(opt);assert.equal((await h.run()).status,'held');assert.equal(h.calls(),0);}});
test('candidate changed during image validation is held before RPC',async()=>{const h=harness({change:true});assert.equal((await h.run()).reason,'candidate_changed');assert.equal(h.calls(),0);});
test('image mismatch is held before RPC',async()=>{const h=harness();assert.equal((await h.run({verifyImage:async()=>({sha256:'wrong',decoded:true})})).reason,'image_verification_failed');assert.equal(h.calls(),0);});
test('lost response with committed publication is recovered by readback',async()=>{const h=harness({lost:true});const r=await h.run();assert.equal(r.status,'published');assert.equal(r.response_error,true);assert.equal(h.calls(),1);});
test('unknown unsuccessful publication is not automatically retried',async()=>{const h=harness({lost:true,fail:true});assert.equal((await h.run()).status,'needs_readback');assert.equal(h.calls(),1);});
test('existing candidate reused: client has no insert, update, delete or upload interface',async()=>{const h=harness();assert.equal((await h.run()).status,'published');assert.equal(h.calls(),1);});
test('duplicate search reuses one existing draft and holds ambiguous identities',()=>{const e={event_date:'2026-11-21',venue:'LIVE VANQUISH',performer_name:'AK-69',title:'AK-69 TOUR'};const p={...e,id:99,is_published:false};assert.equal(resolveExisting([p],e).id,99);assert.equal(resolveExisting([],e),null);assert.throws(()=>resolveExisting([p,{...p,id:100}],e),/duplicate_candidates/);assert.throws(()=>resolveExisting([{...p,title:'Different tour'}],e),/identity_conflict/);});
test('missing authenticated execution runtime fails closed without network',async()=>{assert.equal((await publishReviewed({pin:base})).reason,'authenticated_runtime_missing');});

test('explicit image omission needs no image approval, bytes, or SHA', async () => {
    const fixture = harness({ fields: { use_image_on_public_page: false, image_usage_status: 'unknown', public_image_sha256: null } });
    const result = await fixture.run({ verifyImage: async () => assert.fail('must skip image verification') });
    assert.equal(result.status, 'published');
    assert.equal(result.image_included, false);
    assert.equal(fixture.calls(), 1);
});

test('missing event fields still prevent image-free publication', async () => {
    const fixture = harness({ fields: { use_image_on_public_page: false, venue: '' } });
    assert.equal((await fixture.run()).reason, 'validation_failed');
    assert.equal(fixture.calls(), 0);
});

test('session restore waits before asking the existing client for identity and RLS membership', async () => {
    const calls = [];
    let release;
    const session = new Promise(resolve => { release = resolve; });
    const client = {
        auth: { getSession: () => session, getUser: async () => {
            calls.push('getUser');
            return { data: { user: { id: 'admin' } } };
        } },
        from: table => {
            calls.push(table);
            return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { user_id: 'admin' } }) };
        }
    };
    const restored = restoreWorksAdministrator(client);
    assert.deepEqual(calls, []);
    release({ data: { session: {} } });
    assert.equal((await restored).status, 'ready');
    assert.deepEqual(calls, ['getUser', 'work_admins']);
});

test('Cloud and PC route by observed capabilities and assess browser Return independently', () => {
    const yes = { status: 'verified', evidence: 'observed' };
    assert.equal(assessWorksRuntime({ host: 'Cloud', adminSession: yes, authenticatedApi: yes }).publicationRoute, 'authenticated_api');
    assert.equal(assessWorksRuntime({ host: 'PC', adminSession: yes, adminPanel: yes }).publicationRoute, 'owner_panel');
    const route = assessWorksRuntime({ host: 'PC', productionRead: yes, browserReturn: yes });
    assert.equal(route.publicationRoute, 'handoff');
    assert.equal(route.browserReturn, true);
});

test('handoff preserves the task and distinguishes local review hash from production CAS hash', () => {
    const args = { taskId: 'WKS-X', parentTask: 'WKS-W', event: base, localHash: hash };
    const pending = prepareWorksHandoff(args);
    assert.equal(pending.task_id, 'WKS-X');
    assert.equal(pending.parent_task, 'WKS-W');
    assert.equal(pending.work_id, null);
    assert.equal(pending.database_candidate_hash, null);
    const unknown = prepareWorksHandoff({ ...args, workId: 99, databaseHash: sha, lastRpc: 'unknown' });
    assert.equal(unknown.resume, 'read_back_same_work_no_rpc');
    assert.throws(() => prepareWorksHandoff({ ...args, workId: 99 }), /handoff_scope_incomplete/);
});

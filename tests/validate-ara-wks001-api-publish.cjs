const assert = require('node:assert/strict');
(async () => {
    const { publishWks001, WKS001_IDS } = await import('../js/work-batch-publish.mjs');
    const seed = () => WKS001_IDS.map(id => ({ id, candidate_hash: 'old-' + id, flyer_path: id + '.jpg', public_image_sha256: 'a'.repeat(64), public_image_source_url: 'https://example.org/' + id, is_published: false, publication_review_status: 'publication_pending_approval', use_image_on_public_page: false, image_usage_status: 'unknown' }));
    const expected = seed(), rows = new Map(seed().map(p => [p.id, p])), calls = [], updates = [];
    const client = {
        auth: { async getUser() { return { data: { user: { id: 'admin' } } }; } },
        from(table) {
            const conditions = [];
            let patch;
            const chain = { select() { return this; }, eq(k,v) { conditions.push([k,v]); return this; }, update(v) { patch = v; return this; },
                async maybeSingle() { return this.single(); },
                async single() {
                    if (table === 'work_admins') return { data: { user_id: 'admin' } };
                    const id = conditions.find(([k]) => k === 'id')[1], row = rows.get(id);
                    if (patch) {
                        assert.deepEqual(Object.keys(patch).sort(), ['image_usage_status','use_image_on_public_page']);
                        assert(conditions.every(([k,v]) => row[k] === v));
                        updates.push(id);
                        Object.assign(row, patch, { candidate_hash: 'new-' + id, image_publication_confirmed_at: 'now', image_publication_confirmed_by: 'admin' });
                    }
                    return { data: { ...row } };
                }
            };
            return chain;
        },
        async rpc(name,args) {
            assert.equal(name, 'publish_work_candidate'); calls.push(args.p_work_id);
            assert.equal(args.p_candidate_hash, 'new-' + args.p_work_id);
            if (args.p_work_id === 90) throw new Error('lost response');
            const row = rows.get(args.p_work_id);
            Object.assign(row, { is_published: true, publication_review_status: null, approved_at: 'now', approved_by: 'admin', approved_hash: row.candidate_hash });
            return { data: [{ result: 'published' }] };
        }
    };
    const result = await publishWks001({ client, expected, verifyImage: async p => { if (p.id === 91) throw new Error('corrupt image'); } });
    assert.equal(result.filter(p => p.status === 'published').length, 8);
    assert.equal(result.find(p => p.id === 90).status, 'needs_readback');
    assert.equal(result.find(p => p.id === 91).status, 'held');
    assert.deepEqual(calls, [89,90,92,93,94,95,96,97,98]);
    assert(!updates.includes(91));
    calls.length = 0;
    const second = await publishWks001({ client, expected, verifyImage: async () => {} });
    assert.equal(second.filter(p => p.status === 'already_published').length, 8);
    assert.deepEqual(calls, [91]); // Ambiguous row 90 has a changed hash: never resend.
    await assert.rejects(publishWks001({ client, expected: expected.slice(1), verifyImage: async () => {} }), /10件/u);
    const denied = { ...client, auth: { async getUser() { return { data: { user: null } }; } } };
    await assert.rejects(publishWks001({ client: denied, expected, verifyImage: async () => {} }), /ログイン/u);
    console.log('WKS-001: exact scope, real-user gate, image failure isolation, fresh hash, partial success and no ambiguous RPC retry PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });

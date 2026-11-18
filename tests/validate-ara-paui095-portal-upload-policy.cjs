'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture, actor } = require('./helpers/ara-case-fixture.cjs');

const operation = name => fs.readFileSync(path.join(__dirname, '../supabase/operations', name), 'utf8');
const hash = 'a'.repeat(64);
const object = (prefix, suffix) => prefix + '/123e4567-e89b-42d3-a456-4266141740' + suffix + '/' + hash;

(async () => {
    const { db } = await createFixture();
    const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const insertCase = async name => scalar(
        "insert into pa_inquiries(customer_name,email,event_name,case_type,status) values($1,'fixture@example.invalid',$1,'PA_EVENT','new') returning id", [name]
    );
    const selectObjects = async (role, principal) => {
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [principal]);
        await db.exec('set role ' + role);
        try {
            return (await db.query('select bucket_id,name from storage.objects order by bucket_id,name')).rows;
        } finally {
            await db.exec('reset role');
        }
    };
    const denied = async (sql, args) => {
        await db.exec('set role authenticated');
        try { await assert.rejects(() => db.query(sql, args), /row-level security/); }
        finally { await db.exec('reset role'); }
    };
    try {
        await db.exec(`
          create schema storage;
          create table storage.buckets(id text primary key, public boolean not null);
          create table storage.objects(bucket_id text references storage.buckets, name text, primary key(bucket_id,name));
          alter table storage.objects enable row level security;
          insert into storage.buckets values ('pa-portal-assets', false), ('work-flyers', true);
          grant usage on schema storage to authenticated,anon;
          grant select,insert,update,delete on storage.objects to authenticated,anon;
          create policy "Anyone can view work flyers" on storage.objects for select using (bucket_id='work-flyers');
          insert into storage.objects values ('work-flyers', 'fixture');
        `);
        const first = await insertCase('Synthetic one');
        const second = await insertCase('Synthetic two');
        const portal = await scalar('insert into pa_portals(case_id) values($1) returning id,public_ref', [first.id]);
        const other = await scalar('insert into pa_portals(case_id) values($1) returning id,public_ref', [second.id]);
        const card = await scalar("insert into pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind) values($1,'other','PDF','fixed','ara_tech') returning id", [portal.id]);
        const ownerPath = object('cases/' + first.id, '11');
        const organizerPath = object('organizer/' + portal.public_ref, '12');
        const archivedPath = object('cases/' + first.id, '13');
        const orphan = object('cases/' + first.id, '14');
        const otherPortalPath = object('organizer/' + other.public_ref, '15');
        const wrongHash = object('cases/' + first.id, '16');
        const reference = (storagePath, sha256 = hash) => JSON.stringify({ storage_path: storagePath, sha256 });
        await db.query(
            "insert into pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind) values($1,'portal_upload','owner',$2,'資料.pdf','application/pdf','ara_tech')",
            [card.id, reference(ownerPath)]
        );
        for (const [key, filename, archived, sha256] of [
            ['organizer', organizerPath, false, hash], ['archived', archivedPath, true, hash],
            ['wrong-portal', otherPortalPath, false, hash], ['wrong-hash', wrongHash, false, 'b'.repeat(64)]
        ]) {
            await db.query(
                "insert into pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind,owner_kind,archived_at) values($1,'portal_upload',$2,$3,'写真.png','image/png','organizer','organizer',case when $4 then now() end)",
                [portal.id, key, reference(filename, sha256), archived]
            );
        }
        for (const filename of [ownerPath, organizerPath, archivedPath, orphan, otherPortalPath, wrongHash]) {
            await db.query("insert into storage.objects values ('pa-portal-assets',$1)", [filename]);
        }
        const publicFlyer = [{ bucket_id: 'work-flyers', name: 'fixture' }];
        assert.deepEqual(await selectObjects('authenticated', actor), publicFlyer);
        await db.exec(operation('paui095-portal-upload-read.sql'));
        const expected = [ownerPath, organizerPath].sort().map(name => ({ bucket_id: 'pa-portal-assets', name })).concat(publicFlyer);
        assert.deepEqual(await selectObjects('authenticated', actor), expected);
        assert.deepEqual(await selectObjects('authenticated', '123e4567-e89b-42d3-a456-426614174099'), publicFlyer);
        assert.deepEqual(await selectObjects('anon', ''), publicFlyer);
        await selectObjects('authenticated', actor);
        await denied("insert into storage.objects values ('pa-portal-assets',$1)", [object('cases/' + first.id, '99')]);
        await db.exec('set role authenticated');
        try {
            assert.equal((await db.query("delete from storage.objects where bucket_id='pa-portal-assets'")).affectedRows, 0);
            assert.equal((await db.query("update storage.objects set name=name where bucket_id='pa-portal-assets'")).affectedRows, 0);
        } finally {
            await db.exec('reset role');
        }
        await db.query('update pa_portal_document_cards set archived_at=now() where id=$1', [card.id]);
        assert.deepEqual(await selectObjects('authenticated', actor), [expected.find(row => row.name === organizerPath), ...publicFlyer]);
        await db.query('update pa_portal_document_cards set archived_at=null where id=$1', [card.id]);
        await db.query("select * from trash_pa_case($1,'test_case',$2)", [first.id, actor]);
        assert.deepEqual(await selectObjects('authenticated', actor), publicFlyer);
        await db.query('select * from restore_pa_case($1,$2)', [first.id, actor]);
        assert.deepEqual(await selectObjects('authenticated', actor), expected);
        await db.query('delete from work_admins where user_id=$1', [actor]);
        assert.deepEqual(await selectObjects('authenticated', actor), publicFlyer);
        await db.query('insert into work_admins(user_id) values($1)', [actor]);
        await db.exec(operation('paui095-portal-upload-read-rollback.sql'));
        assert.deepEqual(await selectObjects('authenticated', actor), publicFlyer);
        console.log('PASS isolated RLS: owner and organizer-upload originals readable only for active bound records and work admin; anon, revoked, non-admin, archived, orphan, cross-portal and wrong hash denied; writes denied; exact policy rollback');
    } finally {
        await db.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

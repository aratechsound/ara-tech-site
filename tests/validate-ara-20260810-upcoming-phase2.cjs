const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');

(async () => {
    const {
        buildCandidate,
        candidateHash,
        createApproval,
        createRequest,
        exportPublication,
        parseInstruction,
        renderReview,
        reviseCandidate
    } = await import('../scripts/lib/upcoming-event-workflow.mjs');

    const now = new Date('2026-08-10T03:00:00+09:00');
    const parsed = parseInstruction('2026年8月14日、BURK、Club L2、PA担当。開催予定に追加');
    assert.equal(parsed.event_date, '2026-08-14');
    assert.equal(parsed.performer_or_event_name, 'BURK');
    assert.equal(parsed.venue, 'Club L2');
    assert.equal(parsed.ara_assignment_text, 'PA担当');
    assert.equal(parsed.assignment_label, 'PA・音響');
    assert.deepEqual(parsed.service_types, ['pa_sound']);
    assert.equal(parsed.event_type, '');

    const request = createRequest('2026年8月14日、BURK、Club L2、PA担当。開催予定に追加', { now });
    assert.equal(request.status, 'RESEARCH_REQUIRED');
    assert.equal(request.production_mutation_permitted, false);
    request.minimum_input.event_type = 'クラブ・DJイベント';

    const baseResearch = {
        workflow_id: request.workflow_id,
        checked_on: '2026-08-10',
        resolved: {
            title: 'BURK SPECIAL LIVE', performer_name: 'BURK', event_date: '2026-08-14',
            open_time: '18:00', start_time: '19:00', venue: 'Club L2', area: '広島県広島市',
            venue_address: '広島県広島市中区1-2-3', organizer_name: 'Club L2',
            official_announcement_url: 'https://official.example/events/burk'
        },
        official_sources: [{
            type: 'venue_official_web', label: 'Club L2公式', url: 'https://official.example/events/burk',
            confirms: {
                event_date: '2026-08-14', venue: 'Club L2', performer_or_event_name: 'BURK',
                open_time: '18:00', open_time_label: 'OPEN', start_time: '19:00', start_time_label: 'START'
            }
        }],
        conflicts: [],
        image: {
            status: 'direct_success', acquisition_method: 'img_src',
            source_url: 'https://official.example/images/burk.jpg', local_path: 'work/burk.jpg',
            usage_permission: 'confirmed', alt: 'BURK SPECIAL LIVEのフライヤー'
        }
    };

    // Case A: normal official page and directly available image.
    const direct = buildCandidate(request, baseResearch, { now });
    assert.equal(direct.status, 'PUBLICATION_PENDING_APPROVAL');
    assert.equal(direct.image.publication_allowed, true);
    assert.equal(direct.database_payload.is_published, false);
    assert.equal(direct.database_payload.announcement_confirmed_on, null);
    assert.equal(direct.database_payload.open_time, '18:00');
    assert.equal(direct.database_payload.start_time, '19:00');
    assert.equal(direct.seo.title, 'BURK SPECIAL LIVE｜2026年 Club L2｜ARA-TECH 音響担当予定');
    assert.match(renderReview(direct), /この内容で公開してよいか/);

    // A venue's operating-hours range is neither OPEN nor START.
    const timeRangeOnly = buildCandidate(request, {
        ...baseResearch,
        resolved: { ...baseResearch.resolved, open_time: '22:00', start_time: '04:00' },
        official_sources: [{
            ...baseResearch.official_sources[0],
            confirms: {
                event_date: '2026-08-14', venue: 'Club L2', performer_or_event_name: 'BURK',
                open_time: '22:00', start_time: '04:00', time_range: '22:00 - 04:00'
            }
        }]
    }, { now });
    assert.equal(timeRangeOnly.event.open_time, null);
    assert.equal(timeRangeOnly.event.start_time, null);

    const openOnly = buildCandidate(request, {
        ...baseResearch,
        official_sources: [{
            ...baseResearch.official_sources[0],
            confirms: {
                event_date: '2026-08-14', venue: 'Club L2', performer_or_event_name: 'BURK',
                open_time: '22:00', open_time_label: 'OPEN'
            }
        }]
    }, { now });
    assert.equal(openOnly.event.open_time, '22:00');
    assert.equal(openOnly.event.start_time, null);

    const afterMidnight = buildCandidate(request, {
        ...baseResearch,
        official_sources: [{
            ...baseResearch.official_sources[0],
            confirms: {
                event_date: '2026-08-14', venue: 'Club L2', performer_or_event_name: 'BURK',
                open_time: '22:00', open_time_label: 'OPEN', start_time: '25:00', start_time_label: 'START'
            }
        }]
    }, { now });
    assert.equal(afterMidnight.event.open_time, '22:00');
    assert.equal(afterMidnight.event.start_time, null);

    // Case B: image discovered by structure analysis.
    const complex = buildCandidate(request, {
        ...baseResearch,
        image: { ...baseResearch.image, status: 'structure_analysis_success', acquisition_method: 'ogp_json_dom' }
    }, { now });
    assert.equal(complex.status, 'PUBLICATION_PENDING_APPROVAL');
    assert.equal(complex.image.status, 'structure_analysis_success');

    // Case C: image unavailable does not block the event candidate.
    const withoutImage = buildCandidate(request, {
        ...baseResearch,
        image: { status: 'no_image_available', acquisition_method: 'none', usage_permission: 'not_confirmed' }
    }, { now });
    assert.equal(withoutImage.status, 'PUBLICATION_PENDING_APPROVAL');
    assert.equal(withoutImage.image.publication_allowed, false);
    const protectedImage = buildCandidate(request, {
        ...baseResearch,
        image: { status: 'human_action_required', acquisition_method: 'login_or_access_control', usage_permission: 'not_confirmed' }
    }, { now });
    assert.equal(protectedImage.status, 'PUBLICATION_PENDING_APPROVAL');
    assert.equal(protectedImage.image.publication_allowed, false);

    // Case D: multiple matching official sources are accepted.
    const multiple = buildCandidate(request, {
        ...baseResearch,
        official_sources: [
            ...baseResearch.official_sources,
            {
                type: 'artist_official_web', label: 'BURK公式', url: 'https://artist.example/live',
                confirms: { event_date: '2026-08-14', venue: 'Club L2', performer_or_event_name: 'BURK SPECIAL LIVE' }
            }
        ]
    }, { now });
    assert.equal(multiple.status, 'PUBLICATION_PENDING_APPROVAL');
    assert.equal(multiple.official_information.sources.length, 2);
    const ambiguous = buildCandidate(request, {
        ...baseResearch,
        official_sources: [
            ...baseResearch.official_sources,
            {
                type: 'artist_official_web', label: '別候補', url: 'https://artist.example/other-live',
                confirms: { event_date: '2026-08-15', venue: 'OTHER HALL', performer_or_event_name: 'BURK' }
            }
        ]
    }, { now });
    assert.equal(ambiguous.status, 'RESEARCH_REVIEW_REQUIRED');
    assert.ok(ambiguous.blockers.includes('official_sources:event_date_conflict'));
    assert.ok(ambiguous.blockers.includes('official_sources:venue_conflict'));

    // Case E: an official-information mismatch blocks approval.
    const conflict = buildCandidate(request, {
        ...baseResearch,
        resolved: { ...baseResearch.resolved, event_date: '2026-08-15' }
    }, { now });
    assert.equal(conflict.status, 'RESEARCH_REVIEW_REQUIRED');
    assert.ok(conflict.blockers.some((item) => item.includes('event_date')));
    assert.throws(() => createApproval(conflict, 'OK', { now }), /not approvable/);
    const wrongWorkflow = buildCandidate(request, { ...baseResearch, workflow_id: 'another-event' }, { now });
    assert.ok(wrongWorkflow.blockers.includes('workflow_id:mismatch'));

    // Case F: a wording correction changes the hash and requires a new review/approval.
    const approvalBeforeRevision = createApproval(direct, 'OK', { now });
    const revised = reviseCandidate(direct, {
        publication: { description: '代表の修正を反映した掲載文章です。' },
        seo: { meta_description: '代表の修正を反映した掲載文章です。' }
    }, { now: new Date('2026-08-10T03:05:00+09:00') });
    assert.equal(revised.status, 'PUBLICATION_PENDING_APPROVAL');
    assert.notEqual(revised.candidate_hash, direct.candidate_hash);
    assert.throws(() => exportPublication(revised, approvalBeforeRevision, { now }), /matching approval/);
    const coreRevised = reviseCandidate(direct, { event: { event_date: '2026-08-15' } }, { now });
    assert.equal(coreRevised.status, 'RESEARCH_RECHECK_REQUIRED');
    const stillBlocked = reviseCandidate(conflict, { publication: { description: '文章だけ修正' } }, { now });
    assert.equal(stillBlocked.status, 'RESEARCH_REVIEW_REQUIRED');
    assert.ok(stillBlocked.blockers.length > 0);
    const replacementImage = reviseCandidate(direct, {
        image: { source_url: 'https://official.example/images/replacement.jpg', usage_permission: 'unknown' }
    }, { now });
    assert.equal(replacementImage.image.publication_allowed, false);

    // Case G: no matching approval means no publishable payload.
    assert.throws(() => exportPublication(direct, null, { now }), /matching approval/);
    const approval = createApproval(direct, '公開して', { now });
    const publication = exportPublication(direct, approval, { now });
    assert.equal(publication.status, 'READY_FOR_EXISTING_ADMIN_PUBLICATION');
    assert.equal(publication.payload.is_published, true);
    assert.equal(publication.payload.announcement_confirmed_on, '2026-08-10');
    assert.equal(publication.candidate_hash, candidateHash(direct));
    assert.equal(publication.safety.direct_service_role_usage_permitted, false);

    // A successful technical fetch without usage permission never exports the image.
    const rightsUnknown = buildCandidate(request, {
        ...baseResearch,
        image: { ...baseResearch.image, usage_permission: 'unknown' }
    }, { now });
    const rightsApproval = createApproval(rightsUnknown, 'それでいい', { now });
    assert.equal(exportPublication(rightsUnknown, rightsApproval, { now }).image_upload, null);

    // CLI end-to-end: init and prepare are local-only; export is impossible before approval.
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'ara-tech-upcoming-'));
    try {
        const cli = resolve(__dirname, '../scripts/add-upcoming-event.mjs');
        const instruction = '2027年1月15日、SAMPLE ARTIST、EXAMPLE HALL、音響担当。開催予定に追加';
        const run = (...cliArgs) => spawnSync(process.execPath, [cli, ...cliArgs], { encoding: 'utf8' });
        const init = run('init', '--instruction', instruction, '--out-dir', temporaryRoot, '--now', '2027-01-01T00:00:00+09:00');
        assert.equal(init.status, 0, init.stderr);
        const cliRequest = JSON.parse(readFileSync(join(temporaryRoot, 'request.json'), 'utf8'));
        const cliResearch = {
            ...baseResearch,
            workflow_id: cliRequest.workflow_id,
            checked_on: '2027-01-01',
            resolved: {
                ...baseResearch.resolved,
                title: 'SAMPLE ARTIST LIVE 2027', performer_name: 'SAMPLE ARTIST', event_date: '2027-01-15',
                venue: 'EXAMPLE HALL', official_announcement_url: 'https://official.example/events/sample'
            },
            official_sources: [{
                type: 'venue_official_web', label: 'EXAMPLE HALL公式', url: 'https://official.example/events/sample',
                confirms: { event_date: '2027-01-15', venue: 'EXAMPLE HALL', performer_or_event_name: 'SAMPLE ARTIST' }
            }],
            image: { status: 'no_image_available', acquisition_method: 'none', usage_permission: 'not_confirmed' }
        };
        writeFileSync(join(temporaryRoot, 'research.json'), `${JSON.stringify(cliResearch, null, 2)}\n`, 'utf8');
        const prepare = run('prepare', '--request', join(temporaryRoot, 'request.json'), '--research', join(temporaryRoot, 'research.json'), '--now', '2027-01-01T00:05:00+09:00');
        assert.equal(prepare.status, 0, prepare.stderr);
        const cliCandidate = JSON.parse(readFileSync(join(temporaryRoot, 'candidate.json'), 'utf8'));
        assert.equal(cliCandidate.status, 'RESEARCH_REVIEW_REQUIRED');
        assert.ok(cliCandidate.blockers.includes('event_type:required'));
        const prematureExport = run('export', '--candidate', join(temporaryRoot, 'candidate.json'), '--approval-file', join(temporaryRoot, 'approval.json'));
        assert.notEqual(prematureExport.status, 0);
        assert.equal(existsSync(join(temporaryRoot, 'publication-payload.json')), false);
    } finally {
        const safePrefix = `${resolve(tmpdir())}${sep}`.toLowerCase();
        assert.ok(resolve(temporaryRoot).toLowerCase().startsWith(safePrefix));
        rmSync(temporaryRoot, { recursive: true, force: true });
    }

    console.log('ARA-20260810 upcoming Phase 2 validation passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

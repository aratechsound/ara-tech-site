const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../js/work-sort.mjs')).href;
    const { compareUpcomingWorks } = await import(moduleUrl);

    const posts = [
        { id: 71, event_date: '2026-09-20', open_time: '22:00:00', title: 'MANAKA' },
        { id: 69, event_date: '2026-09-20', open_time: null, start_time: null, title: 'M-line' },
        { id: 72, event_date: '2026-09-22', open_time: '22:00:00', title: 'Sad Kid Yaz' },
        { id: 68, event_date: '2026-09-19', open_time: null, start_time: null, title: 'Quubi' }
    ];

    posts.sort(compareUpcomingWorks);
    assert.deepEqual(
        posts.map(({ title }) => title),
        ['Quubi', 'M-line', 'MANAKA', 'Sad Kid Yaz'],
        'same-day date-only or multi-performance entries must precede explicitly late events'
    );

    const timed = [
        { id: 2, event_date: '2026-10-01', open_time: '22:00:00' },
        { id: 1, event_date: '2026-10-01', start_time: '13:30:00' }
    ].sort(compareUpcomingWorks);
    assert.deepEqual(timed.map(({ id }) => id), [1, 2], 'known same-day times remain chronological');

    console.log('ARA-20260913 WORKS same-day upcoming order validation passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

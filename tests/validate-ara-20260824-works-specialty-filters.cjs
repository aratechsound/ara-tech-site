const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

(async () => {
    const filters = await import(pathToFileURL(resolve(root, 'js/work-filters.mjs')));
    const worksJs = read('js/works.js');
    const worksHtml = read('works.html');

    const artist = filters.filterFromSearch('?service=artist_pa_operation');
    const localSupport = filters.filterFromSearch('?service=local_touring_pa_support');
    const dance = filters.filterFromSearch('?event=%E3%83%80%E3%83%B3%E3%82%B9%E7%99%BA%E8%A1%A8%E4%BC%9A%E3%83%BB%E3%82%B7%E3%83%A7%E3%83%BC%E3%82%B1%E3%83%BC%E3%82%B9');

    assert.deepEqual(artist, { kind: 'service', value: 'artist_pa_operation', label: 'アーティストPAオペレート' });
    assert.deepEqual(localSupport, { kind: 'service', value: 'local_touring_pa_support', label: '乗り込みPA・現地技術サポート' });
    assert.deepEqual(dance, { kind: 'event', value: 'ダンス発表会・ショーケース', label: 'ダンス発表会・ショーケース' });
    assert.equal(filters.filterHref(artist), '/works.html?service=artist_pa_operation');
    assert.equal(filters.filterHref(localSupport), '/works.html?service=local_touring_pa_support');
    assert.equal(filters.filterHref(dance), '/works.html?event=%E3%83%80%E3%83%B3%E3%82%B9%E7%99%BA%E8%A1%A8%E4%BC%9A%E3%83%BB%E3%82%B7%E3%83%A7%E3%83%BC%E3%82%B1%E3%83%BC%E3%82%B9');

    assert.equal(filters.filterFromSearch('?service=pa_sound'), null);
    assert.equal(filters.filterFromSearch('?event=%E3%83%A9%E3%82%A4%E3%83%96%E3%83%BB%E3%82%B3%E3%83%B3%E3%82%B5%E3%83%BC%E3%83%88'), null);
    assert.equal(filters.filterFromSearch('?service=unknown'), null);
    assert.equal(filters.filterFromSearch('?service=artist_pa_operation&event=%E3%83%80%E3%83%B3%E3%82%B9%E7%99%BA%E8%A1%A8%E4%BC%9A%E3%83%BB%E3%82%B7%E3%83%A7%E3%83%BC%E3%82%B1%E3%83%BC%E3%82%B9'), null);

    const artistPost = { event_type: 'ライブ・コンサート', service_types: ['artist_pa_operation'] };
    const localPost = { event_type: 'クラブ・DJイベント', service_types: ['local_touring_pa_support'] };
    const dancePost = { event_type: 'ダンス発表会・ショーケース', service_types: ['pa_sound'] };
    assert.equal(filters.workMatchesFilter(artistPost, artist), true);
    assert.equal(filters.workMatchesFilter(localPost, artist), false);
    assert.equal(filters.workMatchesFilter(localPost, localSupport), true);
    assert.equal(filters.workMatchesFilter(dancePost, dance), true);
    assert.equal(filters.workMatchesFilter(artistPost, dance), false);

    assert.match(worksJs, /document\.createElement\(eventFilter \? 'a' : 'span'\)/u);
    assert.match(worksJs, /document\.createElement\(serviceFilter \? 'a' : 'span'\)/u);
    assert.match(worksJs, /workMatchesFilter\(post, activeFilter\)/u);
    assert.match(worksJs, /すべての実績を見る/u);
    assert.match(worksJs, /現在、この分類の実績はまだ掲載されていません。/u);
    assert.match(worksHtml, /work-card__detail-link \{ inset: 0; position: absolute; z-index: 1; \}/u);
    assert.match(worksHtml, /work-card__filter-link \{ cursor: pointer; position: relative;[^}]*z-index: 2;/u);
    assert.match(worksHtml, /work-card__event-type--filter \{ display: inline-flex; justify-self: start; width: fit-content; \}/u);
    assert.match(worksHtml, /@media \(hover: hover\)/u);
    assert.match(worksHtml, /id="works-filter-status"/u);

    console.log('ARA-20260824 WORKS specialty-filter validation passed');
})();

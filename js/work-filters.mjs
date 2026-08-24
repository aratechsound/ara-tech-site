import { eventTypes, normalizeServiceTypes, serviceTypeLabels } from './work-taxonomy.mjs';

// WORKSの専門実績として営業共有する3分類だけを、既存taxonomyの正式値で公開する。
const filterableServiceTypes = new Set([
    'artist_pa_operation',
    'local_touring_pa_support'
].filter((value) => Object.hasOwn(serviceTypeLabels, value)));

const filterableEventTypes = new Set([
    'ダンス発表会・ショーケース'
].filter((value) => eventTypes.includes(value)));

const createFilter = (kind, value, label) => Object.freeze({ kind, value, label });

export const filterForServiceType = (value) => filterableServiceTypes.has(value)
    ? createFilter('service', value, serviceTypeLabels[value])
    : null;

export const filterForEventType = (value) => filterableEventTypes.has(value)
    ? createFilter('event', value, value)
    : null;

export const filterFromSearch = (search = '') => {
    const parameters = new URLSearchParams(search);
    const serviceValues = parameters.getAll('service');
    const eventValues = parameters.getAll('event');

    // 複数値・異なる軸の同時指定は、意図しない絞り込みにせず通常一覧として扱う。
    if (serviceValues.length > 1 || eventValues.length > 1 || (serviceValues[0] && eventValues[0])) return null;

    return filterForServiceType(serviceValues[0]) || filterForEventType(eventValues[0]);
};

export const workMatchesFilter = (post, filter) => {
    if (!filter) return true;
    if (filter.kind === 'service') return normalizeServiceTypes(post.service_types).includes(filter.value);
    if (filter.kind === 'event') return post.event_type === filter.value;
    return true;
};

export const filterHref = (filter) => {
    if (!filter) return '/works.html';
    const parameters = new URLSearchParams();
    parameters.set(filter.kind, filter.value);
    return `/works.html?${parameters.toString()}`;
};

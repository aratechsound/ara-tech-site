(function exposeWorkLifecycle(root, factory) {
    const lifecycle = factory();
    if (typeof module === 'object' && module.exports) module.exports = lifecycle;
    if (root) root.AraTechWorkLifecycle = lifecycle;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    'use strict';

    const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
    const TOKYO_TIME_ZONE = 'Asia/Tokyo';

    const normalizeDateOnly = (value) => {
        const text = String(value || '');
        const match = text.match(DATE_PATTERN);
        if (!match) return '';
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
        return text;
    };

    const getJstDateString = (now = new Date()) => {
        const date = now instanceof Date ? now : new Date(now);
        if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid current time');
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: TOKYO_TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(date);
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    };

    const getEffectiveLifecycleStatus = (post, now = new Date()) => {
        if (post?.lifecycle_status !== 'upcoming') return 'completed';
        const eventDate = normalizeDateOnly(post?.event_date);
        if (!eventDate) return 'upcoming';
        return eventDate < getJstDateString(now) ? 'completed' : 'upcoming';
    };

    const isUpcomingWork = (post, now = new Date()) => getEffectiveLifecycleStatus(post, now) === 'upcoming';

    return Object.freeze({
        TOKYO_TIME_ZONE,
        getEffectiveLifecycleStatus,
        getJstDateString,
        isUpcomingWork,
        normalizeDateOnly
    });
}));

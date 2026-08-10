(() => {
    'use strict';

    if (window.__araAnalyticsInitialized) return;
    window.__araAnalyticsInitialized = true;

    const measurementId = 'G-K8VZM111TY';
    const loader = document.currentScript;
    const campaignParameterNames = [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_id',
        'utm_term',
        'utm_content'
    ];
    const campaignValuePattern = /^[\p{L}\p{N}][\p{L}\p{N} .,_~+\-]{0,99}$/u;
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

    const sanitizeCampaignValue = (name, value) => {
        const trimmed = value.trim();
        if (!campaignValuePattern.test(trimmed)) return '';
        if (emailPattern.test(trimmed)) return '';
        if (/(?:https?:\/\/|mailto:|tel:)/i.test(trimmed)) return '';

        const digits = trimmed.replace(/\D/g, '');
        const phoneLike = /^[+\d\s().-]+$/.test(trimmed) && digits.length >= 10;
        if (name !== 'utm_id' && phoneLike) return '';

        return trimmed;
    };

    const sanitizeUrl = (value, { preserveCampaignParameters = false } = {}) => {
        if (!value) return '';

        try {
            const parsed = new URL(value, window.location.origin);
            const sanitized = new URL(`${parsed.origin}${parsed.pathname}`);

            if (preserveCampaignParameters) {
                for (const name of campaignParameterNames) {
                    const safeValue = sanitizeCampaignValue(name, parsed.searchParams.get(name) || '');
                    if (safeValue) sanitized.searchParams.set(name, safeValue);
                }
            }

            return sanitized.toString();
        } catch {
            return '';
        }
    };

    const initialize = () => {
        const pageLocation = sanitizeUrl(window.location.href, { preserveCampaignParameters: true });
        const pageReferrer = sanitizeUrl(document.referrer);

        window.va = window.va || function () {
            (window.vaq = window.vaq || []).push(arguments);
        };
        window.va('beforeSend', (event) => {
            const url = sanitizeUrl(event?.url || pageLocation);
            if (!url) return null;

            const sanitizedEvent = { ...event, url };
            if (sanitizedEvent.referrer) {
                sanitizedEvent.referrer = sanitizeUrl(sanitizedEvent.referrer);
            }
            return sanitizedEvent;
        });

        const vercelScript = document.createElement('script');
        vercelScript.defer = true;
        vercelScript.src = '/_vercel/insights/script.js';
        document.head.appendChild(vercelScript);

        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () {
            window.dataLayer.push(arguments);
        };

        const googleScript = document.createElement('script');
        googleScript.async = true;
        googleScript.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
        document.head.appendChild(googleScript);

        window.gtag('js', new Date());
        const config = { page_location: pageLocation };
        if (pageReferrer) config.page_referrer = pageReferrer;
        window.gtag('config', measurementId, config);
        window.dispatchEvent(new CustomEvent('ara:analytics-ready'));
    };

    const scheduleIdle = () => {
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(initialize, { timeout: 3000 });
        } else {
            window.setTimeout(initialize, 2000);
        }
    };

    if (loader?.dataset.analyticsLoad === 'idle') {
        if (document.readyState === 'complete') scheduleIdle();
        else window.addEventListener('load', scheduleIdle, { once: true });
    } else {
        initialize();
    }
})();

import { renderCommercialWorkspace } from './pa-commercial-admin.js';

const caseFixture = Object.freeze({ id: '123e4567-e89b-42d3-a456-426614174000', status: 'active' });
const context = {
    case: caseFixture,
    getAccessToken: async () => 'fixture-admin',
    getCurrentCase: () => caseFixture,
    openComposer: (mode) => {
        document.getElementById('gmail-reply-panel').classList.remove('hidden');
        document.getElementById('gmail-reply-title').textContent = `共通Composer：${mode}`;
        document.getElementById('gmail-reply-recipient').value = 'customer@example.invalid';
        document.getElementById('gmail-reply-cc').value ||= 'venue@example.invalid';
        document.getElementById('gmail-reply-subject').value = 'Re: PA-20260907-00001 / Event estimate';
        document.getElementById('gmail-reply-body').value ||= 'ローカルfixtureの本文。外部送信しません。';
        document.getElementById('communication-section').classList.remove('hidden');
        document.getElementById('gmail-reply-panel').scrollIntoView({ block: 'start' });
    },
    focusBilling: () => document.getElementById('pa-billing-summary').scrollIntoView({ block: 'center' }),
    focusNote: () => document.getElementById('internal-memo')?.scrollIntoView({ block: 'center' }),
    openFileSearch: () => document.getElementById('pa-related-files').scrollIntoView({ block: 'center' })
};

document.getElementById('detail-title').textContent = '龍姫湖まつり2026（検証用）';
document.getElementById('detail-number').textContent = 'PA-20260907-00001 / LOCAL fixture';
document.getElementById('overview-number').textContent = 'PA-20260907-00001';
document.getElementById('overview-date').textContent = '2026年10月18日';
document.getElementById('overview-contact').textContent = '管理下テスト担当者';
document.getElementById('overview-venue').textContent = 'ローカル検証会場';
document.getElementById('communication-section').classList.remove('hidden');
document.getElementById('email-history').innerHTML = '<div id="gmail-timeline" class="mail-history"><article class="mail-history__item mail-history__item--sent"><strong>ARA-TECH → お客様</strong><span>正式受注確認のご案内（fake送信）</span></article></div>';
renderCommercialWorkspace(context);

let composerMode = 'normal';
document.querySelectorAll('[data-gmail-composer-mode]').forEach((button) => button.addEventListener('click', () => {
    composerMode = button.dataset.gmailComposerMode;
    document.querySelectorAll('[data-gmail-composer-mode]').forEach((item) => item.setAttribute('aria-selected', String(item === button)));
    document.getElementById('gmail-reply-title').textContent = `共通Composer：${composerMode}`;
}));
document.getElementById('preview-gmail-reply').addEventListener('click', async () => {
    const body = document.getElementById('gmail-reply-body').value.trim();
    const cc = document.getElementById('gmail-reply-cc').value.split(/[;,\n]/u).map(item => item.trim()).filter(Boolean);
    const response = await fetch('/api/pa-mail?surface=commercial', { method: 'POST', headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'composer_preview', case_id: caseFixture.id, body, cc_addresses: cc, mode: composerMode }) });
    const payload = await response.json();
    if (!response.ok) throw Error(payload.code || 'preview_failed');
    document.getElementById('gmail-reply-preview-recipient').textContent = payload.result.recipient;
    document.getElementById('gmail-reply-preview-cc').textContent = payload.result.cc_addresses.join(', ') || 'なし';
    document.getElementById('gmail-reply-preview-subject').textContent = payload.result.subject;
    document.getElementById('gmail-reply-preview-body').textContent = payload.result.body;
    document.getElementById('gmail-reply-preview').classList.remove('hidden');
});

document.getElementById('real-scenario').addEventListener('change', async (event) => {
    const response = await fetch('/__fixture/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: event.target.value }) });
    if (!response.ok) throw Error('fixture_reset_failed');
    await context.refreshCommercial();
});

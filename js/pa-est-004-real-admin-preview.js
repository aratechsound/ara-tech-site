import { renderCommercialWorkspace } from './pa-commercial-admin.js';

let caseFixture = Object.freeze({ id: '123e4567-e89b-42d3-a456-426614174000', status: 'active' });
let composerFailure = false;
const hotfixEvidence = { openCount: 0, actions: [] };
const context = {
    case: caseFixture,
    getAccessToken: async () => 'fixture-admin',
    getCurrentCase: () => caseFixture,
    openComposer: (mode, options = {}) => {
        if (composerFailure) return false;
        hotfixEvidence.openCount += 1;
        hotfixEvidence.actions.push({ mode, intent: options.estimateIntent || null });
        document.getElementById('gmail-reply-panel').classList.remove('hidden');
        document.getElementById('gmail-reply-panel').dataset.estimateIntent = options.estimateIntent || '';
        document.getElementById('gmail-reply-title').textContent = `共通Composer：${mode}`;
        document.getElementById('gmail-reply-recipient').value = 'customer@example.invalid';
        document.getElementById('gmail-reply-cc').value ||= 'venue@example.invalid';
        document.getElementById('gmail-reply-subject').value = 'Re: PA-20260907-00001 / Event estimate';
        document.getElementById('gmail-reply-body').value ||= 'ローカルfixtureの本文。外部送信しません。';
        document.getElementById('communication-section').classList.remove('hidden');
        document.getElementById('gmail-reply-panel').scrollIntoView({ block: 'start' });
        return true;
    },
    focusBilling: () => document.getElementById('pa-billing-summary').scrollIntoView({ block: 'center' }),
    focusNote: () => document.getElementById('internal-memo')?.scrollIntoView({ block: 'center' }),
    openFileSearch: () => document.getElementById('pa-related-files').scrollIntoView({ block: 'center' })
};

window.__paR11a = {
    evidence: hotfixEvidence,
    setComposerFailure: (value) => { composerFailure = Boolean(value); },
    setCaseIdentity: (id) => {
        caseFixture = Object.freeze({ id, status: 'active' });
        context.case = caseFixture;
    },
    rerender: () => renderCommercialWorkspace(context),
    refresh: () => context.refreshCommercial()
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

const contractHistory = document.getElementById('formal-contract-panel');
contractHistory.hidden = false;
contractHistory.innerHTML = '<h3>正式受注・契約控え</h3><div class="action-panel pa-contract-history-latest"><p>直近：v5 / 失効 / 見積書 第1版</p></div><button type="button" class="button button--secondary button--small pa-contract-history-toggle" aria-expanded="false">過去の正式受注確認 4件を表示 ▸</button><div class="pa-contract-history-older" hidden><div class="action-panel"><p>v4 / 失効</p></div><div class="action-panel"><p>v3 / 失効</p></div><div class="action-panel"><p>v2 / 失効</p></div><div class="action-panel"><p>v1 / 失効</p></div></div>';
contractHistory.querySelector('.pa-contract-history-toggle').addEventListener('click', event => {
    const older = contractHistory.querySelector('.pa-contract-history-older');
    const expanded = older.hidden;
    older.hidden = !expanded;
    event.currentTarget.setAttribute('aria-expanded', String(expanded));
    event.currentTarget.textContent = expanded ? '履歴を閉じる ▴' : '過去の正式受注確認 4件を表示 ▸';
});

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

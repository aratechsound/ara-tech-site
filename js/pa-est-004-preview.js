import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });

const scenarios = {
  draft: { label: '01 見積前', estimate: 0, revision: 0, confirmation: 'none', billing: null, paid: 0, fulfilled: false, settlement: false, closed: false },
  pending: { label: '02 見積v1・確認待ち', estimate: 330000, revision: 1, confirmation: 'pending', billing: null, paid: 0, fulfilled: false, settlement: false, closed: false },
  unknown: { label: '03 メール同期不明', estimate: 330000, revision: 1, confirmation: 'pending', billing: null, paid: 0, fulfilled: false, settlement: false, closed: false, unknown: true },
  accepted: { label: '04 正式受注済み', estimate: 330000, revision: 1, confirmation: 'accepted', billing: null, paid: 0, fulfilled: false, settlement: false, closed: false },
  postevent: { label: '05 実施後・精算確認待ち', estimate: 330000, revision: 1, confirmation: 'accepted', billing: null, paid: 0, fulfilled: true, settlement: false, closed: false },
  invoiced: { label: '06 請求書発行済み', estimate: 330000, revision: 1, confirmation: 'accepted', billing: { mode: 'separate', amount: 330000, due: '2026-12-08' }, paid: 0, fulfilled: true, settlement: true, closed: false },
  noinvoice: { label: '07 既存書類で請求管理', estimate: 330000, revision: 1, confirmation: 'accepted', billing: { mode: 'existing', amount: 330000, due: '2026-12-08' }, paid: 0, fulfilled: true, settlement: true, closed: false },
  partial: { label: '08 一部入金', estimate: 330000, revision: 1, confirmation: 'accepted', billing: { mode: 'separate', amount: 330000, due: '2026-12-08' }, paid: 110000, fulfilled: true, settlement: true, closed: false },
  ready: { label: '09 全額入金・完了可能', estimate: 330000, revision: 1, confirmation: 'accepted', billing: { mode: 'separate', amount: 330000, due: '2026-12-08' }, paid: 330000, fulfilled: true, settlement: true, closed: false },
  completed: { label: '10 完了済み', estimate: 330000, revision: 1, confirmation: 'accepted', billing: { mode: 'separate', amount: 330000, due: '2026-12-08' }, paid: 330000, fulfilled: true, settlement: true, closed: true }
};

let state = structuredClone(scenarios.pending);
let mode = 'normal';
let pendingAction = null;
let dirty = false;
const draft = {
  to: 'demo-customer@example.invalid', cc: '', subject: 'Re: 秋空フェス 音響運営',
  thread: 'fixture-thread-004（ローカル）', body: 'デモ担当者様\n\nお問い合わせありがとうございます。', attachment: ''
};
const workflow = ['問い合わせ受付','初回返信','要件確認','日程確認','現地下見','見積作成','見積送付','正式受注確認','事前準備','搬入・設営','本番実施','撤収','請求・精算','入金確認・完了'];
const files = Array.from({ length: 20 }, (_, i) => ({
  name: i === 0 ? 'estimate-fixture-v1.pdf' : i === 1 ? 'venue-layout.xlsx' : `fixture-document-${String(i + 1).padStart(2,'0')}.${i % 3 === 0 ? 'pdf' : 'txt'}`,
  type: i === 0 ? '見積書・発行済み原本' : i === 1 ? '会場資料' : i % 2 ? '受信資料' : '内部資料',
  date: `2026/10/${String(28 - Math.min(i, 19)).padStart(2,'0')}`, pinned: i < 2
}));
const mails = [
  ['2026/10/28 16:42','受信・同期済み','電源容量について','200V電源の位置を確認中です。'],
  ['2026/10/27 11:04','送信・fake','正式受注確認のご案内','確認URLは版v1に固定されています。'],
  ['2026/10/26 09:18','送信・fake','見積書を送付します','estimate-fixture-v1.pdf を添付しました。']
];

const $ = (id) => document.getElementById(id);
const button = (label, action, primary = false) => `<button type="button" class="preview-button${primary ? ' preview-button--primary' : ''}" data-action="${action}">${label}</button>`;
function toast(text) { const el = $('toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2400); }
function statusText() {
  if (state.closed) return ['案件完了','入金・業務・精算の完了を確認済みです。'];
  if (state.billing && state.paid >= state.billing.amount && state.fulfilled && state.settlement) return ['完了確認へ','全額入金と業務・精算完了がそろいました。'];
  if (state.billing && state.paid > 0) return ['残額の入金確認',`残額 ${yen.format(state.billing.amount - state.paid)}。実入金を手動で確認してください。`];
  if (state.billing) return ['入金確認待ち','銀行連携は行いません。実入金後に記録します。'];
  if (state.fulfilled && !state.settlement) return ['実施・精算確認','イベント期日経過だけで請求は行いません。'];
  if (state.confirmation === 'accepted') return ['実施準備','正式受注済み内容は改訂で自動取消しません。'];
  if (state.confirmation === 'pending') return ['正式受注確認待ち','現在版に固定した確認URLを案内済みです。'];
  if (state.revision) return ['正式受注確認を発行','見積発行とは別の明示操作です。'];
  return ['見積を作成','条件を確認し、発行済み原本を上書きせず版管理します。'];
}
function render() {
  $('estimate-panel').innerHTML = state.revision ? `<p class="preview-subtle">現在版 v${state.revision} · 発行済み原本</p><p class="preview-amount">${yen.format(state.estimate)}</p><dl class="preview-summary"><dt>条件</dt><dd>音響運営一式／架空条件</dd><dt>発行日</dt><dd>2026/10/26</dd></dl><div class="card-actions">${button('原本を開く','open-estimate')}${button('条件変更を開始','revise')}</div>` : `<div class="preview-callout">まだ見積版は発行されていません。</div><div class="card-actions">${button('見積を作成','compose-estimate',true)}${button('送信済み見積を登録','recover-estimate')}</div>`;
  $('billing-panel').innerHTML = state.billing ? `<p class="preview-subtle">${state.billing.mode === 'separate' ? '請求書を別途発行' : '既存書類を使用・別途発行なし'}</p><p class="preview-amount">${yen.format(state.billing.amount)}</p><dl class="preview-summary"><dt>合意期限</dt><dd>${state.billing.due}</dd><dt>入金済み</dt><dd>${yen.format(state.paid)}</dd><dt>残額</dt><dd>${yen.format(Math.max(0,state.billing.amount-state.paid))}</dd></dl><div class="card-actions">${state.closed ? button('入金記録を見る','payment',true) : button('入金を確認','payment',true)}${state.paid && !state.closed ? button('誤登録を訂正','correct') : ''}</div>` : `<div class="preview-callout">請求条件は未登録です。実施日経過だけでは作成しません。</div><div class="card-actions">${button('請求書を発行','invoice',true)}${button('既存書類で管理','billing-existing')}</div>`;
  const conf = state.confirmation;
  $('confirmation-badge').textContent = conf === 'accepted' ? '正式受注済み' : conf === 'pending' ? 'お客様確認待ち' : conf === 'revoked' ? '失効済み' : '未発行';
  $('confirmation-badge').className = `preview-badge${conf === 'accepted' ? ' ok' : conf === 'revoked' ? ' error' : ''}`;
  $('confirmation-panel').innerHTML = `<dl class="preview-summary"><dt>対象見積</dt><dd>${state.revision ? `v${state.revision}（版固定）` : '未選択'}</dd><dt>状態</dt><dd>${$('confirmation-badge').textContent}</dd><dt>回答期限</dt><dd>${conf === 'pending' ? '2026/11/02' : '—'}</dd></dl>${conf === 'accepted' ? '<div class="preview-callout">承認済みスナップショットを保護します。通常の改訂では取消・上書きできません。</div>' : ''}<div class="card-actions">${state.revision && conf === 'none' ? button('正式受注確認を発行','confirmation',true) : ''}${conf === 'pending' ? `${button('案内内容を確認','open-confirmation')}${button('同じ確認を再案内','remind-confirmation')}${button('この確認だけ失効','revoke')}` : ''}</div>`;
  const [heading, detail] = statusText();
  $('next-panel').innerHTML = `<div class="preview-callout${state.unknown ? ' warn' : ''}"><strong>${state.unknown ? '同期状態は不明' : heading}</strong><p>${state.unknown ? '断定せず再同期・確認を案内します。' : detail}</p></div><div class="card-actions">${state.fulfilled && !state.settlement ? button('業務・精算完了を確認','settlement',true) : ''}${state.billing ? button('入金・完了画面','payment',true) : ''}${state.closed ? button('案件を再開','reopen') : ''}</div>`;
  $('sync-badge').textContent = state.unknown ? '同期状態不明' : 'ローカルfixture';
  renderFiles();
}

function pdfUrl() {
  if (pdfUrl.value) return pdfUrl.value;
  const stream = 'BT /F1 18 Tf 32 110 Td (ESTIMATE FIXTURE v1) Tj 0 -30 Td /F1 11 Tf (JPY 330,000) Tj ET';
  const objects = ['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R]/Count 1>>','<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',`<</Length ${stream.length}>>stream\n${stream}\nendstream`,'<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let pdf = '%PDF-1.4\n', offset = pdf.length;
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(offset); const block = `${index + 1} 0 obj\n${object}\nendobj\n`; pdf += block; offset += block.length; });
  const xref = offset;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  pdfUrl.value = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' })); return pdfUrl.value;
}
function renderFiles(list = files) {
  $('file-count').textContent = `${files.length}件`;
  $('file-strip').innerHTML = list.slice(0,8).map((f,i) => `<button type="button" class="preview-file" data-file="${f.name}"><span class="preview-file__image">${i === 0 ? '<canvas data-pdf-thumbnail aria-label="見積書の実PDF先頭ページ"></canvas>' : i === 1 ? '<img class="fixture-raster" alt="ローカル会場配置fixture" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAQWZVJ8AAAAASUVORK5CYII=">' : '<strong>ARA-TECH<br>LOCAL</strong>'}</span><span class="preview-file__meta"><strong>${f.pinned ? '★ ' : ''}${f.name}</strong><span>${f.type} · ${f.date}</span></span></button>`).join('');
  renderPdfThumbnail();
}
async function renderPdfThumbnail() {
  const canvas = document.querySelector('[data-pdf-thumbnail]');
  if (!canvas) return;
  const documentHandle = await pdfjs.getDocument({ url: pdfUrl() }).promise;
  const page = await documentHandle.getPage(1);
  const viewport = page.getViewport({ scale: .65 });
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  canvas.dataset.rendered = 'true';
}
function openComposer(nextMode) {
  mode = nextMode; writeDraft(); renderComposerMode(); $('composer-dialog').showModal();
}
function readDraft() { ['to','cc','subject','thread','body'].forEach(k => draft[k] = $(`composer-${k}`).value); draft.attachment = $('composer-attachment').value; dirty = true; }
function writeDraft() { ['to','cc','subject','thread','body'].forEach(k => $(`composer-${k}`).value = draft[k]); $('composer-attachment').value = draft.attachment; }
function renderComposerMode() {
  document.querySelectorAll('[data-composer-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.composerMode === mode)));
  const info = { normal: '通常返信。商取引状態は変更しません。', estimate: '見積は新しい不変版として発行します。', invoice: '請求書発行と請求条件登録を同じ確認操作で行います。', confirmation: '準備だけではトークンを作りません。最終確定で現在版に固定して発行します。' };
  $('composer-commercial-fields').innerHTML = `<strong>${{normal:'通常返信',estimate:'見積',invoice:'請求',confirmation:'正式受注確認案内'}[mode]}</strong><span>${info[mode]}</span>${mode === 'invoice' ? '<label>合意した支払期限 <input id="composer-due" type="date" value="2026-12-08"></label>' : ''}`;
}
function ask(title, html, action, label = '確定') { $('confirm-title').textContent = title; $('confirm-body').innerHTML = html; $('confirm-action').textContent = label; pendingAction = action; $('confirm-dialog').showModal(); }
function execute(action) {
  if (action === 'send') { if (mode === 'estimate') { state.revision += 1; state.estimate = 330000; state.confirmation = 'none'; } if (mode === 'confirmation') state.confirmation = 'pending'; if (mode === 'invoice') state.billing = { mode:'separate', amount: state.estimate || 330000, due:'2026-12-08' }; toast('fake adapterへ記録しました（外部送信なし）'); $('composer-dialog').close(); dirty = false; }
  if (action === 'revise') { if (state.confirmation === 'accepted') return toast('承認済み内容は保護されています'); state.confirmation = state.confirmation === 'pending' ? 'revoked' : state.confirmation; state.revision += 1; toast('旧pending失効とcurrent切替を一操作で反映'); }
  if (action === 'revoke') { state.confirmation = 'revoked'; toast('対象の確認だけを失効しました'); }
  if (action === 'settlement') { state.fulfilled = true; state.settlement = true; toast('業務・精算完了を確認しました'); }
  if (action === 'billing-existing') { state.billing = { mode:'existing', amount: state.estimate || 330000, due:'2026-12-08' }; toast('既存書類を根拠に請求条件を登録'); }
  if (action === 'recover-estimate') { state.revision = Math.max(1,state.revision); state.estimate = 330000; toast('再送せず、送信済み原本を登録しました'); }
  if (action === 'correct') { state.paid = Math.max(0, state.paid - 10000); toast('元記録を残し、反対調整を追記しました'); }
  if (action === 'reopen') { state.closed = false; toast('理由付き再開をローカルfixtureへ記録'); }
  if (action === 'remind-confirmation') toast('同一確認をfake再案内しました（新規発行なし）');
  render();
}

Object.entries(scenarios).forEach(([key,value]) => $('scenario-select').add(new Option(value.label,key)));
$('scenario-select').value = 'pending';
$('scenario-select').addEventListener('change', e => { state = structuredClone(scenarios[e.target.value]); render(); });
$('scenario-reset').addEventListener('click', () => { state = structuredClone(scenarios[$('scenario-select').value]); dirty = false; render(); toast('シナリオを初期状態へ戻しました'); });
document.querySelectorAll('[data-open-composer]').forEach(b => b.addEventListener('click', () => openComposer(b.dataset.openComposer)));
document.querySelectorAll('[data-composer-mode]').forEach(b => b.addEventListener('click', () => { readDraft(); mode = b.dataset.composerMode; renderComposerMode(); writeDraft(); }));
document.querySelectorAll('#composer-form input,#composer-form textarea').forEach(el => el.addEventListener('input', readDraft));
$('save-draft').addEventListener('click', () => { readDraft(); dirty = false; toast('下書きをローカル保存しました'); });
$('preview-send').addEventListener('click', () => { readDraft(); ask('送信内容の最終確認', `<p><strong>${mode}</strong> を fake adapter へ渡します。</p><p>To: ${draft.to}<br>添付: ${draft.attachment || 'なし'}<br>外部送信: なし</p>`, 'send', 'fake送信'); });
$('confirm-action').addEventListener('click', () => { $('confirm-dialog').close(); execute(pendingAction); pendingAction = null; });
$('estimate-tab').addEventListener('click', () => { $('estimate-panel').hidden=false; $('billing-panel').hidden=true; $('estimate-tab').setAttribute('aria-selected','true'); $('billing-tab').setAttribute('aria-selected','false'); });
$('billing-tab').addEventListener('click', () => { $('estimate-panel').hidden=true; $('billing-panel').hidden=false; $('estimate-tab').setAttribute('aria-selected','false'); $('billing-tab').setAttribute('aria-selected','true'); });
document.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'compose-estimate') return openComposer('estimate');
  if (action === 'confirmation') return openComposer('confirmation');
  if (action === 'invoice') return openComposer('invoice');
  if (action === 'payment') return openPayment();
  if (action === 'open-estimate') return window.open(pdfUrl(),'_blank','noopener');
  if (action === 'open-confirmation') return toast('版固定された案内内容を表示しました');
  if (action === 'remind-confirmation') return ask('同じ確認を再案内', '<p>新しい確認は発行せず、同一の有効な確認URLを再案内します。</p>', 'remind-confirmation', 'fake再案内');
  if (action === 'correct') return ask('誤登録訂正', '<p>元の入金記録は削除せず、反対調整を追記します。</p>', 'correct','訂正を記録');
  const descriptions = { revise:'旧pendingがあれば失効し、新しいcurrent版へ同時に切り替えます。', revoke:'この未承認確認だけを失効します。', settlement:'業務実施と精算完了を確認します。', 'billing-existing':'請求書PDFを別途発行せず、金額と合意期限を管理します。', 'recover-estimate':'通常返信で送信済みの見積原本を、再送せず登録します。', reopen:'完了済み案件を理由付きで再開します。', 'remind-confirmation':'同一の確認を再案内しました。新しい確認は発行していません。' };
  ask('操作の確認', `<p>${descriptions[action]}</p>`, action);
});
function openPayment() {
  const amount = state.billing?.amount || state.estimate || 330000, remaining = Math.max(0,amount-state.paid);
  $('payment-summary').innerHTML = `<dt>請求額</dt><dd>${yen.format(amount)}</dd><dt>入金済み</dt><dd>${yen.format(state.paid)}</dd><dt>残額</dt><dd>${yen.format(remaining)}</dd><dt>業務・精算</dt><dd>${state.fulfilled && state.settlement ? '完了' : '未完了'}</dd>`;
  $('payment-amount').value = remaining; $('payment-date').value = '2026-12-03'; $('payment-checked').checked = false;
  $('payment-warning').textContent = '全額入金と業務・精算完了がそろうまで案件完了はできません。'; $('payment-dialog').showModal();
}
$('record-payment-only').addEventListener('click', () => { if (!$('payment-checked').checked) return toast('実入金確認にチェックしてください'); state.paid += Number($('payment-amount').value || 0); $('payment-dialog').close(); toast('手動入金を追記しました'); render(); });
$('close-case').addEventListener('click', () => { if (!$('payment-checked').checked) return toast('実入金確認にチェックしてください'); const total = state.paid + Number($('payment-amount').value || 0); if (!state.billing || total < state.billing.amount || !state.fulfilled || !state.settlement) return toast('完了条件がそろっていません'); state.paid = total; state.closed = true; $('payment-dialog').close(); toast('入金記録と案件完了を同時に反映'); render(); });
$('open-library').addEventListener('click', () => { $('library-search').value=''; renderLibrary(files); $('library-dialog').showModal(); });
function renderLibrary(list) { $('library-results').innerHTML = list.map(f => `<div class="library-row"><strong>${f.name}</strong><span>${f.type} · ${f.date} · ${f.pinned ? '固定' : '通常'}</span></div>`).join('') || '<p>該当なし</p>'; }
$('library-search').addEventListener('input', e => { const q=e.target.value.toLowerCase(); renderLibrary(files.filter(f => `${f.name} ${f.type}`.toLowerCase().includes(q))); });
$('files-prev').addEventListener('click', () => $('file-strip').scrollBy({left:-340,behavior:'smooth'}));
$('files-next').addEventListener('click', () => $('file-strip').scrollBy({left:340,behavior:'smooth'}));
$('add-document').addEventListener('click', () => toast('ローカルfixtureではアップロードを模擬します'));
$('open-note').addEventListener('click', () => { $('legacy-details').open = true; $('case-note').focus(); });
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue=''; } });
document.querySelector('#composer-dialog [value=cancel]').addEventListener('click', e => { if (dirty && !confirm('未保存の編集があります。閉じますか？')) e.preventDefault(); });
$('workflow-list').innerHTML = workflow.map((x,i) => `<li>${String(i+1).padStart(2,'0')} ${x}</li>`).join('');
$('mail-list').innerHTML = mails.map(m => `<article class="mail-item"><time>${m[0]}</time><div><h3>${m[2]}</h3><p>${m[3]}</p><div class="mail-item__meta"><span>${m[1]}</span><span>thread固定</span></div></div></article>`).join('');
render();

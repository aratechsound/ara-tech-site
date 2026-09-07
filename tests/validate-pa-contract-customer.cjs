const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { terms, TERMS_VERSION } = require('../api/_pa-contract-terms.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const gmail = require('../api/_pa-gmail.cjs');
const mail = require('../api/_pa-mail.cjs');
global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

async function main() {
  const standard = terms('2026-10-18');
  assert.equal(TERMS_VERSION, 'PA-FORMAL-20260908-v2');
  assert.match(standard.payment_terms, /ボタンを押す前にARA-TECHへご相談/);
  assert.match(standard.payment_terms, /新しい確認URL/);
  assert.match(standard.cancellation_terms, /二重に加算するものではなく、いずれか高い方/);
  for (const date of ['2027-01-10', '2028-03-01', '2028-02-29', '2026-12-01']) {
    const text = terms(date).cancellation_terms;
    const epoch = Date.parse(date + 'T12:00:00Z');
    for (const offset of [31, 30, 8, 7, 2, 1, 0]) {
      const d = new Date(epoch - offset * 86400000);
      assert(text.includes(`${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`));
    }
  }
  for (const date of ['2026-02-29', '2026-13-01', '2026-10-18junk']) assert.throws(() => terms(date), /invalid_event_date/);
  for (const text of ['責任をもって実施', '同等以上の性能・用途', '見積金額や業務範囲に影響しない', '破損・盗難', '屋外テント', '発電機', '故意・重過失', '身体への損害', '強行法規', '最終確定契約金額', '間接的な損害', '逸失利益']) assert(standard.business_terms.includes(text));
  assert(!/version|軽微な運用変更|荒殿本人に固定|契約上の主要条件/.test(standard.terms_text));
  assert(!read('js/pa-contract.js').includes("['契約version'"));
  assert(read('pa-contract.html').includes('/img/ara-tech-logo-horizontal-white.png'));
  console.log('PASS customer wording, preserved responsibility and calendar boundaries');

  const f = await createFixture();
  try {
    const input = { action:'issue', case_id:f.inquiryId, gmail_message_id:'direct_sent_001', gmail_attachment_id:'attachment_1', quote_sha256:sha(f.quote), customer_name:'管理下テスト担当者', amount:170500, order_scope:{performance_time:'10:00〜15:00',venue:'検証用会場',services:'管理下テストPA'} };
    const first = (await f.call(input)).body.result;
    const firstToken = new URL(first.url).hash.slice(1);
    const firstView = await f.service.view(firstToken);
    const rejected = await f.call({...input, custom_payment:'イベント終了翌月末までに銀行振込', payment_approved:false});
    assert.equal(rejected.body.code, 'invalid_contract');
    assert.equal((await f.service.view(firstToken)).state, 'active');
    const replacement = (await f.call({...input, custom_payment:'イベント終了翌月末までに銀行振込', payment_approved:true, approved_payment_date:'2026-11-30'})).body.result;
    const secondToken = new URL(replacement.url).hash.slice(1);
    const updated = await f.service.view(secondToken);
    assert.match(updated.snapshot.payment_terms, /イベント終了翌月末までに銀行振込/);
    assert(!updated.snapshot.payment_terms.includes('14日以内'));
    assert(updated.snapshot.terms_text.includes(updated.snapshot.payment_terms));
    await assert.rejects(f.service.view(firstToken), /invalid_link/);
    const stale = await f.call({action:'accept', token:firstToken, offer_id:firstView.offer_id, snapshot_sha256:firstView.snapshot_sha256, confirmer_name:'検証用', agree:true}, {admin:false});
    assert.equal(stale.body.code, 'invalid_link');
    assert.equal(Number((await f.db.query('select count(*) n from pa_contracts')).rows[0].n), 0);
    const old = (await f.db.query('select snapshot from pa_contract_offers where id=$1', [first.id])).rows[0].snapshot;
    assert.equal(old.payment_terms, firstView.snapshot.payment_terms);
    assert.equal(old.terms_version, firstView.snapshot.terms_version);
    await assert.rejects(f.db.query("update pa_contract_tokens set state='active' where offer_id=$1", [first.id]), /token_terminal/);
    assert.equal(updated.snapshot.quote.sha256, firstView.snapshot.quote.sha256);
    assert.equal(f.state.sendCount, 0);
    console.log('PASS approved payment replaces standard, revokes old URL permanently, preserves snapshots and quote');

    const body = '竹林様\n\nお世話になっております。\nARA-TECHの荒殿です。\n\n2026年10月18日開催の\n「2026龍姫湖まつり」につきまして、\n正式受注確認の内容をご用意いたしました。\n\n下記URLより、\n最終見積書（税込170,500円）および\nご依頼条件をご確認ください。\n\n【正式受注確認URL】\nhttps://ara-tech.cc/pa-contract.html#' + 'a'.repeat(64) + '\n\n内容をご確認のうえ、\n確認ページ内の\n「この内容で正式に依頼する」\nボタンからお手続きをお願いいたします。\n\nご不明な点や、\n支払条件などについてご相談がある場合は、\n正式依頼のお手続き前にこのメールへご返信ください。\n\nどうぞよろしくお願いいたします。\n\nARA-TECH\n荒殿 竜一';
    const preview = await gmail.replyPreview({inquiryId:f.inquiryId, actorId:f.actorId, body}, f.fetchImpl);
    assert.equal(preview.html, mail.buildCustomerHtml(preview.body));
    const mime = Buffer.from(mail.buildRawMessage({to:preview.recipient, subject:preview.subject, body:preview.body, messageType:'customer_receipt', config:{senderAddress:'aratechsound@gmail.com',senderName:'ARA-TECH',replyTo:'aratechsound@gmail.com'}}), 'base64url').toString();
    assert(mime.includes(Buffer.from(preview.html).toString('base64').match(/.{1,76}/g).join('\r\n')));
    for (const text of ['ara-tech-logo-horizontal-white.png', 'background:#007bff', 'ara-tech-logo-horizontal-black.png', 'https://lin.ee/', '正式依頼のお手続き前に']) assert(preview.html.includes(text));
    assert(!/プレビュー作成時点|ご本人にて|契約はまだ成立/.test(preview.body));
    const unsafe = mail.buildCustomerHtml('<script>alert(1)</script>');
    assert(!unsafe.includes('<script>'));
    assert.equal(f.state.sendCount, 0);
    assert(read('pa-admin.html').includes('title="送信前のARA-TECHメール" sandbox="allow-same-origin" referrerpolicy="no-referrer"'));
    const csp = JSON.parse(read('vercel.json')).headers.find(h => h.source === '/pa-admin.html').headers.find(h => h.key === 'Content-Security-Policy').value;
    assert(csp.includes("style-src-attr 'unsafe-inline'"));
    assert(!/script-src[^;]*unsafe-inline/.test(csp));
    console.log('PASS Gmail canonical branded HTML and body, sandboxed preview, no transport');
  } finally { await f.db.close(); }
}
main().catch(e => {console.error(e); process.exitCode=1;});

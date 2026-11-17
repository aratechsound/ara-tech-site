export const followUpType = 'content_hearing_follow_up';

export function createIntakeComposer({inquiry, requestPreview, send, close, draft, embedded = false, readOnly = false, title = "お問い合わせへの返信"}) {
  const form = document.createElement('form');
  form.className = 'reply-composer';
  form.setAttribute('aria-label', title);
  form.innerHTML = `<div class="reply-heading"><h2>お問い合わせへの返信</h2>
    <button type="button" class="lightbtn" data-intake-close>閉じる</button></div>
    <label>宛先<input type="email" name="recipient" readonly></label>
    <label>件名<input name="subject" maxlength="240" required></label>
    <label>本文<textarea name="body" rows="8" maxlength="20000" required></textarea></label>
    <div class="inlinebtns"><button type="button" class="action blue" data-intake-preview>プレビュー</button></div>
    <section class="reply-preview" data-intake-review hidden>
      <h3>送信前プレビュー</h3><p data-intake-address></p>
      <iframe title="お問い合わせへの返信プレビュー" sandbox="" referrerpolicy="no-referrer"></iframe>
      <label class="reply-confirm"><input type="checkbox" name="confirmed">宛先・件名・本文を確認しました</label>
      <button type="submit" class="action blue" disabled>確認した内容で送信する</button>
    </section><p role="status" hidden></p>`;
  const {recipient, subject, body, confirmed} = form.elements;
  subject.readOnly = body.readOnly = readOnly;
  const preview = form.querySelector('[data-intake-preview]');
  const review = form.querySelector('[data-intake-review]');
  const submit = form.querySelector('[type=submit]');
  const status = form.querySelector('[role=status]');
  if (readOnly) submit.textContent = '確認した内容で再送する';

  recipient.value = inquiry.email.trim();
  subject.value = (draft?.subject || ('お問い合わせについて｜' + inquiry.inquiry_number)).slice(0, 240);
  const name = inquiry.contact_name || inquiry.customer_name;
  body.value = draft?.body ?? (name ? name + ' 様\n\n' : '');
  form.querySelector('h2').textContent = title;
  form.querySelector('.reply-heading').hidden = embedded;
  const frame = review.querySelector('iframe');
  frame.title = title + 'プレビュー';
  let snapshot;
  let revision = 0;
  const message = text => {
    status.textContent = text;
    status.hidden = !text;
  };
  const invalidate = () => {
    revision++;
    snapshot = null;
    frame.removeAttribute('srcdoc');
    review.hidden = true;
    confirmed.checked = false;
    submit.disabled = true;
    message('');
  };
  subject.oninput = body.oninput = invalidate;
  form.querySelector('[data-intake-close]').onclick = close;
  preview.onclick = async () => {
    invalidate();
    if (!form.reportValidity() || !subject.value.trim() || !body.value.trim()) {
      message('件名と本文を入力してください。');
      return;
    }
    const draft = {recipient:recipient.value, subject:subject.value.trim(), body:body.value.trim()};
    const requestRevision = revision;
    message('プレビューを取得しています…');
    try {
      const result = await requestPreview(draft);
      if (revision !== requestRevision || !form.isConnected) return;
      if (typeof result.html !== 'string' || !result.html) throw Error('preview_unavailable');
      if (readOnly && !/^[a-f0-9]{64}$/u.test(result.delivery_snapshot || '')) throw Error('preview_unavailable');
      frame.srcdoc = result.html;
      snapshot = {...draft, deliverySnapshot:result.delivery_snapshot};
    } catch {
      if (revision === requestRevision) message('プレビューを表示できません。宛先と内容を確認してください。');
      return;
    }
    message('');
    form.querySelector('[data-intake-address]').textContent = snapshot.recipient + ' ／ ' + snapshot.subject;
    review.hidden = false;
    confirmed.focus();
  };
  confirmed.onchange = () => { submit.disabled = !confirmed.checked; };
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled || !snapshot || !confirmed.checked) return;
    const payload = snapshot;
    invalidate();
    for (const control of form.elements) control.disabled = true;
    message('送信中です…');
    try {
      const result = await send(payload);
      if (result.delivery.status === 'failed') {
        message('送信に失敗しました。配送履歴を確認してください。');
        return;
      }
      message(result.delivery.status === 'sent' ? '送信しました。' : '送信結果を確認できません。配送記録を確認してください。');
    } catch (error) {
      if (['follow_up_recipient_changed','schedule_recipient_changed'].includes(error.message)) {
        message('登録済みの宛先が変わりました。画面を再読み込みして確認してください。');
      } else if (error.message === 'send_already_attempted') {
        message('この案件の送信は試行済みです。配送記録を確認してください。');
      } else {
        message('送信結果を確認できません。配送記録を確認してください。');
      }
    } finally {
      form.querySelector('[data-intake-close]').disabled = false;
    }
  };
  return form;
}

export const followUpType = 'content_hearing_follow_up';

export function createIntakeComposer({inquiry, send, close}) {
  const form = document.createElement('form');
  form.className = 'reply-composer';
  form.setAttribute('aria-label', 'お問い合わせへの返信');
  form.innerHTML = `<div class="reply-heading"><h2>お問い合わせへの返信</h2>
    <button type="button" class="lightbtn" data-intake-close>閉じる</button></div>
    <label>宛先<input type="email" name="recipient" readonly></label>
    <label>件名<input name="subject" maxlength="240" required></label>
    <label>本文<textarea name="body" rows="8" maxlength="20000" required></textarea></label>
    <div class="inlinebtns"><button type="button" class="action blue" data-intake-preview>プレビュー</button></div>
    <section class="reply-preview" data-intake-review hidden>
      <h3>送信前プレビュー</h3><p data-intake-address></p><pre class="intake-preview-text"></pre>
      <p class="hint">正式署名は送信時に付与されます。</p>
      <label class="reply-confirm"><input type="checkbox" name="confirmed">宛先・件名・本文を確認しました</label>
      <button type="submit" class="action blue" disabled>確認した内容で送信する</button>
    </section><p role="status" hidden></p>`;
  const {recipient, subject, body, confirmed} = form.elements;
  const preview = form.querySelector('[data-intake-preview]');
  const review = form.querySelector('[data-intake-review]');
  const submit = form.querySelector('[type=submit]');
  const status = form.querySelector('[role=status]');
  recipient.value = inquiry.email.trim();
  subject.value = ('お問い合わせについて｜' + inquiry.inquiry_number).slice(0, 240);
  const name = inquiry.contact_name || inquiry.customer_name;
  body.value = name ? name + ' 様\n\n' : '';
  let snapshot;
  const message = text => {
    status.textContent = text;
    status.hidden = !text;
  };
  const invalidate = () => {
    snapshot = null;
    review.hidden = true;
    confirmed.checked = false;
    submit.disabled = true;
    message('');
  };
  subject.oninput = body.oninput = invalidate;
  form.querySelector('[data-intake-close]').onclick = close;
  preview.onclick = () => {
    invalidate();
    if (!form.reportValidity() || !subject.value.trim() || !body.value.trim()) {
      message('件名と本文を入力してください。');
      return;
    }
    snapshot = {recipient:recipient.value, subject:subject.value.trim(), body:body.value.trim()};
    form.querySelector('[data-intake-address]').textContent = snapshot.recipient + ' ／ ' + snapshot.subject;
    form.querySelector('.intake-preview-text').textContent = snapshot.body;
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
      message(result.delivery.status === 'sent' ? '送信しました。' : '送信結果を確認できません。配送記録を確認してください。');
    } catch (error) {
      if (error.message === 'follow_up_recipient_changed') {
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

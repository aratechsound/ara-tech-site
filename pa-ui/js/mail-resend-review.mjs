export function reviewMailResend(preview, { signal } = {}) {
  if (signal?.aborted || !preview?.approval_token || !Array.isArray(preview.attachments)) return Promise.resolve(false);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    const heading = document.createElement('h2');
    heading.textContent = '手動再送の確認';
    dialog.setAttribute('aria-label', heading.textContent);
    const warning = document.createElement('p');
    warning.textContent = preview.previous?.state === 'sent'
      ? 'Gmailで前回の送信を確認しました。再送すると同じメールが届きます。'
      : '前回の送信結果は未確認です。再送すると同じメールが届く可能性があります。';
    const address = document.createElement('p');
    address.textContent = `宛先 ${preview.recipient} / CC ${preview.cc?.join(', ') || 'なし'}`;
    const subject = document.createElement('p');
    subject.textContent = '件名 ' + preview.subject;
    const body = document.createElement('pre');
    body.textContent = preview.body;
    body.style.whiteSpace = 'pre-wrap';
    body.style.overflowWrap = 'anywhere';
    body.style.maxHeight = '38vh';
    body.style.overflow = 'auto';
    const files = document.createElement('p');
    files.textContent = '添付 ' + (preview.attachments.map(file => `${file.filename}（${file.size} バイト）`).join('、') || 'なし');
    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    label.append(check, ' 宛先・件名・本文・添付と二重送信の可能性を確認しました');
    const controls = document.createElement('p');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '閉じる';
    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = '確認した内容で再送';
    send.disabled = true;
    check.addEventListener('change', () => { send.disabled = !check.checked; });
    cancel.addEventListener('click', () => dialog.close());
    send.addEventListener('click', () => { if (check.checked) dialog.close('confirmed'); });
    const abort = () => dialog.close();
    signal?.addEventListener('abort', abort, { once: true });
    dialog.addEventListener('close', () => {
      signal?.removeEventListener('abort', abort);
      dialog.remove();
      resolve(dialog.returnValue === 'confirmed' && !signal?.aborted);
    }, { once: true });
    controls.append(cancel, send);
    dialog.append(heading, warning, address, subject, body, files, label, controls);
    dialog.style.maxWidth = 'min(42rem, calc(100% - 2rem))';
    dialog.style.maxHeight = 'calc(100% - 2rem)';
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

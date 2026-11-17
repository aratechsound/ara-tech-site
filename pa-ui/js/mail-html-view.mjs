import {privateFrame, releasePrivateFrame} from './pa-workspace-privacy.mjs';

const tags = new Set('a b blockquote br code div em h1 h2 h3 h4 hr i img li ol p pre s small span strong table tbody td th thead tr u ul'.split(' '));
const discard = new Set('audio base embed form iframe link math meta object script style svg template title video'.split(' '));
const properties = 'background-color border border-bottom border-collapse border-left border-radius border-right border-top box-sizing color display font-family font-size font-style font-weight height line-height margin margin-bottom margin-left margin-right margin-top max-width overflow-wrap padding padding-bottom padding-left padding-right padding-top text-align text-decoration vertical-align white-space width word-break'.split(' ');
const imagePaths = new Set([
  '/img/ara-tech-logo-horizontal-white.png',
  '/img/ara-tech-logo-horizontal-black.png',
  '/img/ara-tech-line-official-qr.png'
]);

function safeBrandImage(value, origin) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://ara-tech.cc' && !url.username && !url.password &&
        !url.search && !url.hash && imagePaths.has(url.pathname)) return origin + url.pathname;
  } catch { /* Keep malformed source URLs outside the frame. */ }
  return '';
}

export function historyHtmlDocument(html, document = globalThis.document) {
  const origin = document.location.origin;
  const template = document.createElement('template');
  template.innerHTML = String(html || '').slice(0, 100000);
  const rendered = document.createElement('template');
  const inert = rendered.content.ownerDocument;
  function copy(node, parent, depth = 0) {
    if (depth > 80) return;
    if (node.nodeType === 3) {
      parent.append(document.createTextNode(node.data));
      return;
    }
    if (node.nodeType !== 1 || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    const tag = node.localName;
    if (discard.has(tag)) return;
    if (!tags.has(tag)) {
      for (const child of node.childNodes) copy(child, parent, depth + 1);
      return;
    }
    // Links remain readable without creating a browser navigation capability.
    const element = inert.createElement(tag === 'a' ? 'span' : tag);
    if (tag === 'img') {
      const src = safeBrandImage(node.getAttribute('src'), origin);
      if (!src) return;
      // Keep this image inert until the fragment is serialized into the sandbox.
      element.setAttribute('src', src);
      element.setAttribute('alt', (node.getAttribute('alt') || '').slice(0, 100));
    }
    for (const name of ['width', 'height', 'cellpadding', 'cellspacing', 'border', 'colspan', 'rowspan']) {
      const value = node.getAttribute(name);
      if (/^\d{1,3}%?$/u.test(value || '')) element.setAttribute(name, value);
    }
    const align = node.getAttribute('align');
    if (['left', 'center', 'right'].includes(align)) element.setAttribute('align', align);
    if (tag === 'table' && node.getAttribute('role') === 'presentation') element.setAttribute('role', 'presentation');
    for (const property of properties) {
      const value = node.style.getPropertyValue(property);
      if (value && !/[\\@]|\b(?:url|var|attr|expression)\s*\(/iu.test(value) &&
          (property !== 'display' || /^(?:inline|inline-block|block|table|table-row|table-cell)$/u.test(value))) {
        element.style.setProperty(property, value);
      }
    }
    for (const child of node.childNodes) copy(child, element, depth + 1);
    parent.append(element);
  }
  for (const node of template.content.childNodes) copy(node, rendered.content);
  if (!rendered.content.textContent.trim()) return '';
  const images = [...imagePaths].map(path => origin + path).join(' ');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src-attr 'unsafe-inline'; img-src ${images}; base-uri 'none'; form-action 'none'"></head><body style="margin:0;padding:0;background:#f3f6f9;color:#1f2933;font-family:system-ui,sans-serif;overflow-wrap:anywhere">${rendered.innerHTML}</body></html>`;
}

export function createMailHtmlView() {
  let active;
  function close() {
    if (!active) return;
    const {dialog, frame} = active;
    active = null;
    releasePrivateFrame(frame);
    frame.removeAttribute('srcdoc');
    dialog.close();
    dialog.remove();
  }
  return {
    close,
    async open({request, isCurrent}) {
      if (!isCurrent()) return;
      close();
      const dialog = document.createElement('dialog');
      const title = document.createElement('h3');
      const status = document.createElement('p');
      const frame = document.createElement('iframe');
      const reveal = document.createElement('button');
      const dismiss = document.createElement('button');
      dialog.className = 'mail-html-dialog';
      dialog.setAttribute('aria-label', '送信メールのHTML本文');
      title.textContent = '送信メールのHTML本文';
      status.setAttribute('role', 'status');
      status.textContent = '本文を読み込んでいます…';
      frame.setAttribute('sandbox', '');
      frame.hidden = true;
      reveal.type = dismiss.type = 'button';
      reveal.className = dismiss.className = 'lightbtn';
      reveal.dataset.moneyToggle = '';
      reveal.disabled = true;
      reveal.textContent = 'HTML本文・金額を表示';
      dismiss.textContent = '閉じる';
      dismiss.addEventListener('click', close);
      dialog.addEventListener('close', () => { if (active?.dialog === dialog) close(); });
      dialog.append(title, status, reveal, dismiss, frame);
      active = {dialog, frame};
      document.body.append(dialog);
      dialog.showModal();
      try {
        const result = await request();
        if (active?.dialog !== dialog || !isCurrent()) return;
        const srcdoc = historyHtmlDocument(result.body_html);
        if (!srcdoc) {
          status.textContent = 'HTML本文を取得できません。履歴のテキストをご確認ください。';
          return;
        }
        privateFrame(frame, 'srcdoc', srcdoc);
        frame.title = '送信メールのHTML本文';
        reveal.disabled = false;
        status.textContent = result.source === 'delivery_template'
          ? '保存済みの送信本文を共通テンプレートで再構成しています。'
          : 'Gmail原本の書式を表示します。外部画像とリンクは無効です。';
      } catch {
        if (active?.dialog === dialog && isCurrent()) status.textContent = '本文を取得できませんでした。';
      }
    }
  };
}

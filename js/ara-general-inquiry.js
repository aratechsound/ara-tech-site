const form = document.getElementById('contact-form'), message = document.querySelector('[data-fs-error]');
const button = form.querySelector('[type=submit]'), extra = document.getElementById('general-case-fields'), legacyAction = form.action;
let mode = 'UNAVAILABLE', initializing = false, sending = false, key = crypto.randomUUID();
let config, token = '', widgetId = null, legacyInitialized = false, legacyLoaded = false, widgetScript;
const status = document.createElement('p'); status.setAttribute('role', 'status');
const retryConfig = document.createElement('button'); retryConfig.type = 'button'; retryConfig.textContent = '受付方法を再確認'; retryConfig.hidden = true;
const retryCaptcha = document.createElement('button'); retryCaptcha.type = 'button'; retryCaptcha.textContent = '確認処理をやり直す'; retryCaptcha.hidden = true;
form.append(status, retryConfig, retryCaptcha);
extra.querySelectorAll('input,select').forEach(field => { field.disabled = true; });
function update() {
    button.disabled = initializing || sending || (mode !== 'LEGACY' && mode !== 'COMMON')
        || (mode === 'LEGACY' && !legacyLoaded)
        || (mode === 'COMMON' && config.spam_adapter === 'turnstile' && !token);
    retryConfig.disabled = initializing; retryCaptcha.disabled = sending; form.dataset.intakeMode = mode;
}
function unavailable() {
    mode = 'UNAVAILABLE'; token = '';
    status.textContent = '受付方法を確認できません。再確認してください。入力内容は保持しています。';
    retryConfig.hidden = false; update();
}
function validConfig(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.mode === 'LEGACY') return value.enabled === false;
    return value.mode === 'COMMON' && value.enabled === true
        && ((value.spam_adapter === 'turnstile' && typeof value.captcha_site_key === 'string' && value.captcha_site_key.trim())
            || (value.spam_adapter === 'fixture' && value.captcha_site_key === null));
}
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timeout = setTimeout(() => { script.remove(); reject(Error('script_unavailable')); }, 15000);
        script.src = src; script.async = true;
        script.onload = () => { clearTimeout(timeout); resolve(); };
        script.onerror = () => { clearTimeout(timeout); script.remove(); reject(Error('script_unavailable')); };
        document.head.append(script);
    });
}
function captchaPending(text = '確認処理を待っています。完了後に送信できます。') {
    token = ''; status.textContent = text; retryCaptcha.hidden = false; update();
}
function resetCaptcha(text) {
    captchaPending(text);
    try { if (widgetId !== null) window.turnstile.reset(widgetId); }
    catch { captchaPending('確認処理を更新できません。確認処理をやり直してください。'); }
}
async function prepareCaptcha() {
    captchaPending();
    try {
        if (!window.turnstile) {
            widgetScript ||= loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
                .catch(error => { widgetScript = null; throw error; });
            await widgetScript;
        }
        if (widgetId !== null) { resetCaptcha(); return; }
        const widget = document.createElement('div'); form.append(widget);
        widgetId = window.turnstile.render(widget, {
            sitekey: config.captcha_site_key, action: 'general-inquiry',
            callback: proof => { token = typeof proof === 'string' ? proof : ''; status.textContent = token ? '確認が完了しました。送信できます。' : '確認処理を待っています。'; retryCaptcha.hidden = !!token; update(); },
            'error-callback': () => { captchaPending('確認処理でエラーが発生しました。確認処理をやり直してください。'); return true; },
            'expired-callback': () => resetCaptcha('確認の有効期限が切れました。新しい確認処理を待っています。'),
            'timeout-callback': () => resetCaptcha('確認処理が時間切れになりました。新しい確認処理を待っています。')
        });
    } catch { captchaPending('確認処理を読み込めません。確認処理をやり直してください。'); }
}
retryCaptcha.addEventListener('click', () => { if (!sending) prepareCaptcha(); });
async function initialize() {
    if (initializing || mode === 'COMMON' || (mode === 'LEGACY' && legacyLoaded)) return;
    initializing = true; status.textContent = '受付方法を確認しています…'; update();
    try {
        const response = await fetch('/api/pa-inquiry?general_config=1');
        if (!response.ok) throw Error('config_unavailable');
        const next = await response.json(); if (!validConfig(next)) throw Error('config_unavailable'); config = next;
        if (next.mode === 'LEGACY') {
            if (!legacyInitialized) {
                window.formspree ||= function () { (window.formspree.q ||= []).push(arguments); };
                window.formspree('initForm', {formElement: '#contact-form', formId: 'mojqjwnr', onSuccess: () => location.assign('thanks.html?sent=1')});
                legacyInitialized = true;
            }
            await loadScript('https://unpkg.com/@formspree/ajax@1');
            legacyLoaded = true; form.action = legacyAction; mode = 'LEGACY'; status.textContent = '';
        } else {
            mode = 'COMMON'; form.action = '/api/pa-inquiry'; extra.hidden = false;
            extra.querySelectorAll('input,select').forEach(field => { field.disabled = false; });
            if (config.spam_adapter === 'turnstile') await prepareCaptcha(); else status.textContent = '';
        }
        retryConfig.hidden = true;
    } catch { unavailable(); }
    finally { initializing = false; update(); }
}
retryConfig.addEventListener('click', initialize);
// Guard Enter/requestSubmit and direct native submission while route/proof is unknown.
const nativeSubmit = form.submit.bind(form);
form.submit = () => { if (mode === 'LEGACY' && !button.disabled) nativeSubmit(); else form.requestSubmit(); };
form.addEventListener('submit', async event => {
    if (mode === 'LEGACY' && !button.disabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (button.disabled || mode !== 'COMMON') return;
    sending = true; update(); message.style.display = 'block'; message.textContent = '受付を保存しています…';
    const value = id => document.getElementById(id).value;
    const input = {form_kind: 'general', submission_key: key, case_type: value('case-type'), inquiry_category: value('inquiry-type'), customer_name: value('name'), email: value('email'), phone: value('tel'), subject: value('subject'), body: value('message'), organization_name: value('organization'), venue: value('location'), desired_period: value('desired-period'), website: value('website'), captcha_token: token};
    token = ''; // The provider may consume a proof even when the response is lost.
    try {
        const response = await fetch('/api/pa-inquiry', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(input)});
        const data = await response.json();
        if (!response.ok || data.ok !== true || typeof data.id !== 'string' || typeof data.inquiry_number !== 'string') throw Error('acceptance_unconfirmed');
        message.textContent = `受付を保存しました。受付番号：${data.inquiry_number}`; form.dataset.inquiryNumber = data.inquiry_number;
        key = crypto.randomUUID(); form.reset();
    } catch {
        message.textContent = '受付を確認できませんでした。入力を保持しています。再試行では同じ受付識別子を使用します。';
    } finally {
        if (config.spam_adapter === 'turnstile') resetCaptcha(); sending = false; update();
    }
}, true);
const preset = new URLSearchParams(location.search).get('case_type');
if (preset && document.querySelector(`#case-type option[value="${CSS.escape(preset)}"]`)) document.getElementById('case-type').value = preset;
update(); initialize();

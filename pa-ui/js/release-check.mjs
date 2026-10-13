import {workspaceAuth} from './integration.mjs';
import {diagnosticGet, diagnosticAnonymousGet} from './release-check-request.mjs';
const button = document.getElementById('check'), status = document.getElementById('status'), receipt = document.getElementById('receipt');
button.addEventListener('click', async () => {
  button.disabled = true; receipt.textContent = ''; status.textContent = '確認中';
  try { receipt.textContent = JSON.stringify(await diagnosticGet(workspaceAuth), null, 2); status.textContent = '認証・接続GET成功'; }
  catch (error) { status.textContent = /^(login_required|admin_required|receipt_identity_refused|diagnostic_denied_\d{3})$/.test(error?.message || '') ? error.message : 'read_unavailable'; }
  finally { button.disabled = false; }
});
document.getElementById('anonymous-check').addEventListener('click', async event => {
  event.target.disabled = true; receipt.textContent = ''; status.textContent = '匿名GET確認中';
  try { receipt.textContent = JSON.stringify(await diagnosticAnonymousGet(), null, 2); status.textContent = '匿名GET確認完了'; }
  catch { status.textContent = 'read_unavailable'; }
  finally { event.target.disabled = false; }
});

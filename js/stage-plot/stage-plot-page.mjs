import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from '../supabase-config.js';
import {
  StagePlotApiError,
  StagePlotPersistenceClient,
  normalizeCanonicalState,
  parseStagePlotRoute,
} from './stage-plot-persistence.mjs';

const ENGINE_URL = '/js/stage-plot/stage-plot-editor.js?v=3';
const PREVIEW_MESSAGE_TYPE = 'ara-stage-plot-preview';

function routeOptions(search = '') {
  const query = new URLSearchParams(search);
  return {
    embeddedPreview: query.get('preview') === '1' && query.get('embedded') === '1',
    printMode: query.get('print') === '1',
  };
}

function portalUrl(caseId) {
  return `/pa/cases/${encodeURIComponent(caseId)}/portal`;
}

function announcePreview(windowImpl, route, status, code = '') {
  if (!windowImpl.parent || windowImpl.parent === windowImpl) return;
  windowImpl.parent.postMessage({
    type: PREVIEW_MESSAGE_TYPE,
    status,
    caseId: route.caseId,
    plotId: route.plotId,
    code,
  }, windowImpl.location.origin);
}

function bootEmbeddedPreview({ route, editor, windowImpl, documentImpl }) {
  documentImpl.body.classList.add('stage-plot-preview-mode', 'stage-plot-preview-loading');
  const app = documentImpl.querySelector('.app');
  if (app) app.inert = true;
  const receiveState = event => {
    if (event.origin !== windowImpl.location.origin || event.source !== windowImpl.parent) return;
    const message = event.data;
    if (message?.type !== PREVIEW_MESSAGE_TYPE || message.status !== 'state') return;
    if (message.caseId !== route.caseId || message.plotId !== route.plotId) return;
    try {
      editor.loadSnapshot(normalizeCanonicalState(message.state), { rememberPrevious: false, source: 'portal-preview' });
      documentImpl.body.classList.remove('stage-plot-preview-loading');
      announcePreview(windowImpl, route, 'rendered');
    } catch (error) {
      announcePreview(windowImpl, route, 'error', String(error?.code || error?.message || 'invalid_stage_plot_state'));
    }
  };
  windowImpl.addEventListener('message', receiveState);
  announcePreview(windowImpl, route, 'ready');
  return { ok: true, preview: true, editor };
}

function configureRouteActions({ route, options, editor, windowImpl, documentImpl }) {
  const portalLink = documentImpl.getElementById('stagePlotPortalLink');
  if (portalLink) portalLink.href = portalUrl(route.caseId);
  if (!options.printMode) return;
  documentImpl.body.classList.add('stage-plot-print-mode');
  const runPrint = mode => {
    documentImpl.body.classList.remove('print-adaptive-document', 'print-stage-only', 'print-setlist-only');
    documentImpl.body.classList.add(mode);
    windowImpl.requestAnimationFrame(() => windowImpl.print());
  };
  documentImpl.getElementById('stagePlotPrintDocumentBtn')?.addEventListener('click', () => runPrint('print-adaptive-document'));
  documentImpl.getElementById('stagePlotPrintStageBtn')?.addEventListener('click', () => runPrint('print-stage-only'));
  documentImpl.getElementById('stagePlotPrintSetlistBtn')?.addEventListener('click', () => runPrint('print-setlist-only'));
  windowImpl.addEventListener('afterprint', () => documentImpl.body.classList.remove('print-adaptive-document', 'print-stage-only', 'print-setlist-only'));
  editor.loadSnapshot(editor.snapshot(), { rememberPrevious: false, source: 'print-ready' });
}

function stableState(value) {
  return JSON.stringify(normalizeCanonicalState(value));
}

function recordFromResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new StagePlotApiError('invalid_stage_plot_response');
  return result;
}

async function readCaseMetadata(authClient, caseId) {
  if (typeof authClient?.from !== 'function') return null;
  const [inquiryResult, progressResult] = await Promise.all([
    authClient.from('pa_inquiries').select('event_date').eq('id', caseId).is('deleted_at', null).maybeSingle(),
    authClient.from('pa_case_progress').select('confirmed_event_date').eq('inquiry_id', caseId).maybeSingle(),
  ]);
  if (inquiryResult?.error || progressResult?.error) throw new StagePlotApiError('service_unavailable');
  return { eventDate: String(progressResult?.data?.confirmed_event_date || inquiryResult?.data?.event_date || '') };
}

export class StagePlotPage {
  constructor({ route, editor, persistence, historyImpl, locationImpl, saveButton, saveStatus }) {
    this.caseId = route.caseId;
    this.plotId = route.plotId || '';
    this.mode = this.plotId ? 'edit' : 'new';
    this.editor = editor;
    this.persistence = persistence;
    this.history = historyImpl;
    this.location = locationImpl;
    this.saveButton = saveButton;
    this.saveStatus = saveStatus;
    this.revision = null;
    this.dirty = this.mode === 'new';
    this.saving = false;
    this.savePromise = null;
    this.baseline = null;
  }

  setStatus(text, state = 'idle') {
    if (this.saveStatus) {
      this.saveStatus.textContent = text;
      this.saveStatus.dataset.state = state;
    }
    if (this.saveButton) this.saveButton.disabled = this.saving;
  }

  initialize(prefetched = null, caseMetadata = null) {
    if (this.mode === 'edit') {
      const record = recordFromResult(prefetched);
      const canonical = normalizeCanonicalState(record.state);
      if (!canonical.metadata.eventDate) canonical.metadata.eventDate = String(caseMetadata?.eventDate || '');
      this.editor.loadSnapshot(canonical, { rememberPrevious: false, source: 'initial' });
      this.revision = Number(record.current_revision || record.currentRevision || 0) || null;
      this.baseline = stableState(canonical);
      this.dirty = false;
      this.setStatus(`保存済み${this.revision ? ` / Revision ${this.revision}` : ''}`, 'saved');
      return;
    }
    const canonical = normalizeCanonicalState(this.editor.snapshot());
    canonical.metadata.eventDate = String(caseMetadata?.eventDate || canonical.metadata.eventDate || '');
    this.editor.loadSnapshot(canonical, { rememberPrevious: false, source: 'initial' });
    this.baseline = null;
    this.dirty = true;
    this.setStatus('未保存', 'dirty');
  }

  handleEditorChange(detail = {}) {
    if (['initial', 'save-readback'].includes(detail.source)) return;
    const current = stableState(detail.state || this.editor.snapshot());
    this.dirty = this.baseline === null || current !== this.baseline;
    this.setStatus(this.dirty ? '未保存' : `保存済み${this.revision ? ` / Revision ${this.revision}` : ''}`, this.dirty ? 'dirty' : 'saved');
  }

  async save() {
    if (this.savePromise) return this.savePromise;
    if (!this.dirty && this.plotId) return null;
    this.savePromise = this.performSave();
    try { return await this.savePromise; } finally { this.savePromise = null; }
  }

  async performSave() {
    this.saving = true;
    this.setStatus('保存中…', 'saving');
    try {
      const canonical = normalizeCanonicalState(this.editor.snapshot());
      const result = recordFromResult(this.plotId
        ? await this.persistence.save(this.caseId, this.plotId, canonical)
        : await this.persistence.create(this.caseId, canonical));
      if (!this.plotId) {
        const createdId = String(result.id || result.stage_plot_id || '');
        const parsed = parseStagePlotRoute(`?caseId=${encodeURIComponent(this.caseId)}&plotId=${encodeURIComponent(createdId)}`);
        if (!parsed.ok) throw new StagePlotApiError('invalid_stage_plot_response');
        this.plotId = createdId;
        this.mode = 'edit';
        const nextUrl = `${this.location.pathname}?caseId=${encodeURIComponent(this.caseId)}&plotId=${encodeURIComponent(this.plotId)}`;
        this.history.replaceState({}, '', nextUrl);
      }
      this.revision = Number(result.current_revision || result.currentRevision || this.revision || 1);
      const readback = normalizeCanonicalState(result.state || canonical);
      this.editor.loadSnapshot(readback, { rememberPrevious: false, source: 'save-readback' });
      this.baseline = stableState(readback);
      this.dirty = false;
      this.setStatus(`保存済み / Revision ${this.revision}`, 'saved');
      return result;
    } catch (error) {
      this.dirty = true;
      const code = String(error?.code || error?.message || 'service_unavailable');
      this.setStatus(code === 'not_authorized' ? '認証が必要です' : '保存失敗', 'error');
      throw error;
    } finally {
      this.saving = false;
      if (this.saveButton) this.saveButton.disabled = false;
    }
  }

  beforeUnload(event) {
    if (!this.dirty) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  }
}

function showAccess(kind, message) {
  document.body.classList.remove('stage-plot-auth-pending', 'stage-plot-auth-ready', 'stage-plot-auth-denied', 'stage-plot-auth-error');
  document.body.classList.add(kind);
  const messageNode = document.getElementById('stagePlotAccessMessage');
  if (messageNode) messageNode.textContent = message;
}

function revealEditor() {
  document.body.classList.remove('stage-plot-auth-pending', 'stage-plot-auth-denied', 'stage-plot-auth-error');
  document.body.classList.add('stage-plot-auth-ready');
}

function loadEditorEngine() {
  if (window.StagePlotEditor) return Promise.resolve(window.StagePlotEditor);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ENGINE_URL;
    script.onload = () => window.StagePlotEditor ? resolve(window.StagePlotEditor) : reject(new Error('stage_plot_editor_unavailable'));
    script.onerror = () => reject(new Error('stage_plot_editor_unavailable'));
    document.head.append(script);
  });
}

async function createAuthClient() {
  const dependencies = /^(?:127\.0\.0\.1|localhost)$/i.test(window.location.hostname)
    ? window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__
    : null;
  if (dependencies?.createClient) return dependencies.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export async function bootStagePlotPage({
  authClient: suppliedAuthClient,
  persistence: suppliedPersistence,
  loadEngine = loadEditorEngine,
  windowImpl = window,
  documentImpl = document,
} = {}) {
  const route = parseStagePlotRoute(windowImpl.location.search);
  const options = routeOptions(windowImpl.location.search);
  if (!route.ok) {
    showAccess('stage-plot-auth-error', route.code === 'invalid_plot_id' ? 'Stage Plot IDが正しくありません。' : '案件IDが必要です。');
    return { ok: false, code: route.code };
  }
  if (options.embeddedPreview && !route.plotId) {
    showAccess('stage-plot-auth-error', 'Stage Plot IDが必要です。');
    announcePreview(windowImpl, route, 'error', 'invalid_plot_id');
    return { ok: false, code: 'invalid_plot_id' };
  }
  if (!isSupabaseConfigured && !suppliedAuthClient) {
    showAccess('stage-plot-auth-error', '管理者認証を初期化できません。');
    return { ok: false, code: 'auth_not_configured' };
  }

  const authClient = suppliedAuthClient || await createAuthClient();
  const sessionResult = await authClient.auth.getSession();
  const session = sessionResult?.data?.session;
  if (!session?.access_token) {
    showAccess('stage-plot-auth-denied', 'PA管理者としてログインしてください。');
    if (options.embeddedPreview) announcePreview(windowImpl, route, 'error', 'not_authorized');
    return { ok: false, code: 'not_authorized' };
  }

  if (options.embeddedPreview) {
    revealEditor();
    const editor = await loadEngine();
    return bootEmbeddedPreview({ route, editor, windowImpl, documentImpl });
  }

  const localDependencies = /^(?:127\.0\.0\.1|localhost)$/i.test(String(windowImpl.location.hostname || ''))
    ? windowImpl.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__
    : null;
  const persistence = suppliedPersistence || localDependencies?.persistence || new StagePlotPersistenceClient({
    getAccessToken: async () => (await authClient.auth.getSession())?.data?.session?.access_token || '',
  });
  let prefetched = null;
  let caseMetadata = null;
  try {
    [prefetched, caseMetadata] = await Promise.all([
      route.mode === 'edit' ? persistence.get(route.caseId, route.plotId) : persistence.list(route.caseId),
      readCaseMetadata(authClient, route.caseId),
    ]);
  } catch (error) {
    const code = String(error?.code || error?.message || 'service_unavailable');
    showAccess(code === 'not_authorized' ? 'stage-plot-auth-denied' : 'stage-plot-auth-error', code === 'not_authorized' ? 'PA管理者としてログインしてください。' : '案件またはStage Plotを確認できませんでした。');
    return { ok: false, code };
  }

  revealEditor();
  const editor = await loadEngine();
  const page = new StagePlotPage({
    route,
    editor,
    persistence,
    historyImpl: windowImpl.history,
    locationImpl: windowImpl.location,
    saveButton: documentImpl.getElementById('stagePlotSaveBtn'),
    saveStatus: documentImpl.getElementById('stagePlotSaveStatus'),
  });
  page.initialize(route.mode === 'edit' ? prefetched : null, caseMetadata);
  configureRouteActions({ route, options, editor, windowImpl, documentImpl });
  windowImpl.addEventListener('ara:stage-plot-change', event => page.handleEditorChange(event.detail));
  windowImpl.addEventListener('beforeunload', event => page.beforeUnload(event));
  page.saveButton?.addEventListener('click', () => page.save().catch(() => {}));
  windowImpl.StagePlotPage = page;
  return { ok: true, page };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__ARA_STAGE_PLOT_NO_AUTO_BOOT__) {
  bootStagePlotPage().catch(() => showAccess('stage-plot-auth-error', 'Stage Plot Editorを起動できませんでした。'));
}

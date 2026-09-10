const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STATE_BYTES = 3 * 1024 * 1024;
const OUTPUT_MODES = new Set(['normal', 'single_mix', 'none']);
const PLAYBACK_CUES = new Set(['none', 'show_start', 'on_stage', 'title_call', 'mc_end', 'signal', 'blackout', 'continuous', 'custom']);
const PROVISION_STATES = new Set(['unspecified', 'brought', 'venue_borrow', 'rental']);

function normalizeProvision(value) {
  const raw = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (raw === 'brought' || raw === '持込' || raw === '出演者持込') return 'brought';
  if (raw === 'venue_borrow' || raw === '会場借用' || raw === '会場常設機材') return 'venue_borrow';
  if (raw === 'rental' || raw === 'レンタル') return 'rental';
  return 'unspecified';
}

export class StagePlotApiError extends Error {
  constructor(code, status = 0) {
    super(code || 'service_unavailable');
    this.name = 'StagePlotApiError';
    this.code = code || 'service_unavailable';
    this.status = status;
  }
}

export function isUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim());
}

export function parseStagePlotRoute(search = '') {
  const query = new URLSearchParams(search);
  const caseId = String(query.get('caseId') || '').trim();
  const plotId = String(query.get('plotId') || '').trim();
  if (!isUuid(caseId)) return { ok: false, code: 'invalid_case_id', caseId: '', plotId: '' };
  if (plotId && !isUuid(plotId)) return { ok: false, code: 'invalid_plot_id', caseId, plotId: '' };
  return { ok: true, caseId, plotId, mode: plotId ? 'edit' : 'new' };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeCanonicalState(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new StagePlotApiError('invalid_stage_plot_state');
  const state = clone(input);
  state.schemaVersion = 2;
  state.metadata = state.metadata && typeof state.metadata === 'object' && !Array.isArray(state.metadata) ? state.metadata : {};
  state.metadata.eventDate = String(state.metadata.eventDate || state.metadata.event_date || '');
  state.metadata.performanceOrder = String(state.metadata.performanceOrder || '').match(/[1-6]/u)?.[0] || '';
  delete state.metadata.event_date;
  state.objects = Array.isArray(state.objects) ? state.objects.map(item => ({ ...item, category: normalizeProvision(item?.category) })) : [];
  const equipment = state.equipment && typeof state.equipment === 'object' ? state.equipment : {};
  const normalizeRows = rows => Array.isArray(rows) ? rows : [];
  const ambiguous = [...normalizeRows(equipment.requested), ...normalizeRows(equipment.borrowed)].map(item => ({ ...item, legacyProvision: String(item?.legacyProvision || item?.category || 'requested') }));
  state.equipment = {
    brought: normalizeRows(equipment.brought),
    venue_borrow: normalizeRows(equipment.venue_borrow),
    rental: normalizeRows(equipment.rental),
    unspecified: [...normalizeRows(equipment.unspecified), ...ambiguous],
    order: Object.fromEntries([...PROVISION_STATES].map(kind => [kind, Array.isArray(equipment.order?.[kind]) ? equipment.order[kind] : []])),
  };
  state.setlistOutputMode = OUTPUT_MODES.has(state.setlistOutputMode) ? state.setlistOutputMode : 'normal';
  state.otherRequests = String(state.otherRequests ?? state.otherRequest ?? '');
  delete state.otherRequest;
  state.audio = Array.isArray(state.audio) ? state.audio.map((item = {}) => {
    const audioId = String(item.audioId || item.id || '');
    return {
      id: String(item.id || audioId),
      audioId,
      fileName: String(item.fileName || item.name || ''),
      name: String(item.name || item.fileName || ''),
      mimeType: String(item.mimeType || item.type || ''),
      type: String(item.type || item.mimeType || ''),
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
    };
  }) : [];
  state.setlist = Array.isArray(state.setlist) ? state.setlist.map((item = {}) => {
    const id = String(item.id || item.setlistRowId || '');
    const audioRef = String(item.audioRef || item.playbackMode || '音源なし');
    const audioId = String(item.audioId || (audioRef.startsWith('audio:') ? audioRef.slice(6) : ''));
    return {
      ...item,
      id,
      setlistRowId: String(item.setlistRowId || id),
      audioRef,
      audioId,
      playbackMode: String(item.playbackMode || (audioId ? 'file' : audioRef)),
      soundRequest: String(item.soundRequest ?? item.sound ?? ''),
      lightRequest: String(item.lightRequest ?? item.lighting ?? ''),
      playbackCue: PLAYBACK_CUES.has(item.playbackCue) ? item.playbackCue : 'none',
      playbackCueCustom: String(item.playbackCueCustom || ''),
      playbackCueDetail: String(item.playbackCueDetail || ''),
    };
  }) : [];
  const singleMix = state.singleMix && typeof state.singleMix === 'object' && !Array.isArray(state.singleMix) ? state.singleMix : {};
  const singleMixAudioRef = String(singleMix.audioRef || singleMix.playbackMode || '音源なし');
  const singleMixAudioId = String(singleMix.audioId || (singleMixAudioRef.startsWith('audio:') ? singleMixAudioRef.slice(6) : ''));
  state.singleMix = {
    audioRef: singleMixAudioRef,
    audioId: singleMixAudioId,
    playbackMode: String(singleMix.playbackMode || (singleMixAudioId ? 'file' : singleMixAudioRef)),
    duration: String(singleMix.duration || ''),
    playbackCue: PLAYBACK_CUES.has(singleMix.playbackCue) ? singleMix.playbackCue : 'none',
    playbackCueCustom: String(singleMix.playbackCueCustom || ''),
    playbackCueDetail: String(singleMix.playbackCueDetail || ''),
    note: String(singleMix.note || ''),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > MAX_STATE_BYTES) throw new StagePlotApiError('invalid_stage_plot_state');
  return state;
}

function unwrapResult(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export class StagePlotPersistenceClient {
  constructor({ endpoint = '/api/pa-portal', fetchImpl = globalThis.fetch, getAccessToken }) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
  }

  async request(action, fields = {}) {
    const token = await this.getAccessToken();
    if (!token) throw new StagePlotApiError('not_authorized', 401);
    const response = await this.fetchImpl.call(globalThis, this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...fields }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok || payload?.ok !== true) {
      throw new StagePlotApiError(payload?.code || (response.status === 401 ? 'not_authorized' : 'service_unavailable'), response.status);
    }
    return unwrapResult(payload.result);
  }

  list(caseId) {
    return this.request('stage_plot_list', { inquiry_id: caseId });
  }

  get(caseId, plotId) {
    return this.request('stage_plot_get', { inquiry_id: caseId, stage_plot_id: plotId });
  }

  create(caseId, state) {
    return this.request('stage_plot_create', { inquiry_id: caseId, state: normalizeCanonicalState(state) });
  }

  save(caseId, plotId, state) {
    return this.request('stage_plot_save', { inquiry_id: caseId, stage_plot_id: plotId, state: normalizeCanonicalState(state) });
  }
}

export { MAX_STATE_BYTES };

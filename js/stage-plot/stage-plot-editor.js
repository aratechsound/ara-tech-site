(() => {
  'use strict';

  const PAGE_W = 1200;
  const PAGE_H = 1390;
  const STAGE_W = 830;
  const STAGE_H = 500;
  const GRID_SPACING = 20;
  const CENTER_X = STAGE_W / 2;
  const GRID_ORIGIN_X = CENTER_X % GRID_SPACING;
  const GRID_ORIGIN_Y = GRID_SPACING;
  const SNAP_THRESHOLD = 6;
  const HISTORY_LIMIT = 500;
  const STORE = 'ara-tech-stage-plot-canonical-v25';
  const EDITOR_UI_STORE = 'ara-tech-stage-plot-editor-ui:v1';
  const LIBRARY_UI_STORE = 'ara-tech-stage-plot-library-ui:v1';
  const {
    BUILT_IN_PRESETS = [], createPresetStorage, instantiatePreset, presetFromSelection,
  } = window.__ARA_STAGE_PLOT_PRESETS__ || {};
  const TYPES = ['曲', 'SE', 'MC', 'BGM', 'End SE', 'その他'];
  const OUTPUT_MODES = ['normal', 'single_mix', 'none'];
  const OUTPUT_MODE_LABELS = { normal: '通常セットリスト', single_mix: '完成ミックス1本', none: 'セットリストなし' };
  const CUES = ['none', 'show_start', 'on_stage', 'title_call', 'mc_end', 'signal', 'blackout', 'continuous', 'custom'];
  const CUE_LABELS = { none: '未指定', show_start: '開演GO', on_stage: '板付き後GO', title_call: 'タイトルコールでGO', mc_end: 'MC終わりGO', signal: '合図でGO', blackout: '暗転後GO', continuous: '前曲から連続', custom: '任意入力' };
  const TOOLS = ['rect', 'circle', 'line', 'arrow', 'text', 'microphone', 'monitor', 'power'];
  const TYPE_LABELS = { rect: '四角形', circle: '円', line: '線', arrow: '矢印', text: 'テキスト', microphone: 'マイク', monitor: 'モニター', power: '100V' };
  const CATEGORY_LABELS = { unspecified: '未指定・要確認', brought: '出演者持込', venue_borrow: '会場借用', rental: 'レンタル' };
  const EQUIPMENT_KINDS = ['brought', 'venue_borrow', 'rental', 'unspecified'];
  const EQUIPMENT_LIST_IDS = { brought: 'carryList', venue_borrow: 'venueBorrowList', rental: 'rentalList', unspecified: 'unspecifiedList' };
  const EQUIPMENT_OBJECT_TYPES = new Set(['rect', 'circle', 'line', 'arrow', 'microphone', 'monitor', 'power']);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const deep = value => JSON.parse(JSON.stringify(value));
  const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const audioUrls = new Map();

  let state;
  let initialState;
  let selected = null;
  let selectedIds = new Set();
  let showHandles = false;
  let undoStack = [];
  let redoStack = [];
  let pointerAction = null;
  let stageClipboard = [];
  let nudgeAction = null;
  let contextMenuOpen = false;
  let magnetEnabled = false;
  let keyObjectId = '';
  let openSelectionMenu = '';
  let presetEditMode = false;
  let libraryUi = { favorites: [], recent: [] };
  let draggedEquipment = null;
  let equipmentPointerAction = null;
  let draggedSetId = null;
  let audioPlayer = null;
  let audioPlaybackStarted = false;
  let equipmentLayout = { mode: 'normal', overflow: 0, carryVisible: 0, requestVisible: 0 };
  const presetStorage = createPresetStorage?.();
  let presetLibraryState = presetStorage?.loadLibrary?.() || { custom: presetStorage?.load?.() || [], overrides: {}, tombstones: [] };
  let userPresets = presetLibraryState.custom || [];
  let activeCustomPresetId = '';

  try {
    const editorUi = JSON.parse(localStorage.getItem(EDITOR_UI_STORE) || 'null');
    magnetEnabled = Boolean(editorUi?.magnetEnabled);
    const storedLibraryUi = JSON.parse(localStorage.getItem(LIBRARY_UI_STORE) || 'null');
    if (Array.isArray(storedLibraryUi?.favorites)) libraryUi.favorites = storedLibraryUi.favorites.map(String);
    if (Array.isArray(storedLibraryUi?.recent)) libraryUi.recent = storedLibraryUi.recent.map(String).slice(0, 8);
  } catch (_) {}

  function rotationFromTransform(transform) {
    if (!transform || transform === 'none') return 0;
    const values = transform.match(/^matrix\(([^)]+)\)$/)?.[1]?.split(',').map(Number);
    if (!values || values.length < 2) return 0;
    return Math.round(Math.atan2(values[1], values[0]) * 180 / Math.PI * 10) / 10;
  }

  function objectType(node) {
    if ($('.mic-svg', node)) return 'microphone';
    if ($('.mon-svg', node)) return 'monitor';
    if ($('.power-mark', node)) return 'power';
    if ($('.circle', node)) return 'circle';
    if ($('.rect', node)) return 'rect';
    if ($('.engine-line', node)) return 'line';
    if ($('.engine-arrow', node)) return 'arrow';
    return 'text';
  }

  function objectLabel(node, type) {
    const target = $('.rect,.circle,.power-mark,.engine-text', node);
    if (target) return target.textContent.trim();
    return TYPE_LABELS[type];
  }

  function defaultFontSize(type) {
    return ({ rect: 11, circle: 10.5, text: 12, power: 8.5 })[type] || 11;
  }

  function objectCategory(node) {
    if ($('.borrow', node)) return 'brought';
    const stroke = $('.mic-svg line', node)?.getAttribute('stroke')?.toLowerCase();
    if (stroke === '#d71920') return 'brought';
    return 'unspecified';
  }

  function normalizeCategory(value) {
    const raw = String(value || '').normalize('NFKC').trim().toLowerCase();
    if (raw === 'brought' || raw === '持込' || raw === '出演者持込') return 'brought';
    if (raw === 'venue_borrow' || raw === '会場借用' || raw === '会場常設機材') return 'venue_borrow';
    if (raw === 'rental' || raw === 'レンタル') return 'rental';
    return 'unspecified';
  }

  function normalizePerformanceOrder(value) {
    const match = String(value || '').normalize('NFKC').trim().match(/^(?:[^1-6]*)([1-6])(?:番目)?(?:[^1-6]*)$/u);
    return match ? match[1] : '';
  }

  function normalizedEquipmentLabel(value) {
    return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ja-JP');
  }

  function autoEquipmentKey(kind, label) {
    return `auto:${kind}:${encodeURIComponent(normalizedEquipmentLabel(label))}`;
  }

  function manualEquipmentKey(item) {
    return `manual:${item.id}`;
  }

  function projectedEquipment(objects, kind) {
    const groups = new Map();
    objects.forEach(object => {
      if (object.category !== kind || !EQUIPMENT_OBJECT_TYPES.has(object.type)) return;
      const normalized = normalizedEquipmentLabel(object.label);
      if (!normalized) return;
      const key = autoEquipmentKey(kind, normalized);
      const current = groups.get(key);
      if (current) {
        current.qty = String(Number(current.qty) + 1);
        current.objectIds.push(object.id);
      } else {
        groups.set(key, {
          id: key,
          key,
          source: 'auto',
          name: String(object.label || '').normalize('NFKC').trim().replace(/\s+/gu, ' '),
          qty: '1',
          detail: '',
          objectIds: [object.id],
        });
      }
    });
    return [...groups.values()];
  }

  function equipmentOrderFor(existing, manualRows, objects, kind) {
    const active = [
      ...manualRows.map(manualEquipmentKey),
      ...projectedEquipment(objects, kind).map(item => item.key),
    ];
    const activeSet = new Set(active);
    const ordered = [];
    (Array.isArray(existing) ? existing : []).forEach(key => {
      const value = String(key || '');
      if (activeSet.has(value) && !ordered.includes(value)) ordered.push(value);
    });
    active.forEach(key => { if (!ordered.includes(key)) ordered.push(key); });
    return ordered;
  }

  function equipmentItems(kind, source = state) {
    const manual = (source.equipment?.[kind] || []).map(item => ({ ...item, key: manualEquipmentKey(item), source: 'manual' }));
    const automatic = projectedEquipment(source.objects || [], kind);
    const byKey = new Map([...manual, ...automatic].map(item => [item.key, item]));
    return equipmentOrderFor(source.equipment?.order?.[kind], manual, source.objects || [], kind).map(key => byKey.get(key)).filter(Boolean);
  }

  function parseInitialState() {
    const metadataInputs = $$('.meta-field input,.meta-field select');
    const objects = $$('.stage > .obj').map(node => {
      const computed = getComputedStyle(node);
      const child = node.firstElementChild;
      const type = objectType(node);
      const labelNode = $('.rect,.circle,.power-mark,.engine-text', node);
      return {
        id: uid(),
        type,
        x: parseFloat(computed.left) || 0,
        y: parseFloat(computed.top) || 0,
        width: child?.offsetWidth || 76,
        height: child?.offsetHeight || 40,
        rotation: rotationFromTransform(computed.transform),
        scale: 100,
        label: objectLabel(node, type),
        fontSize: parseFloat(getComputedStyle(labelNode || node).fontSize) || defaultFontSize(type),
        category: objectCategory(node),
        labelEdited: false,
        className: node.className.replace(/\bobj\b|\bengine-object\b|\bselected\b|\bcategory-\S+/g, '').trim(),
        html: node.innerHTML,
      };
    });
    const audio = $$('#audioFiles .audio-chip').map(chip => {
      const clone = chip.cloneNode(true);
      clone.querySelector('button')?.remove();
      const fileName = clone.textContent.trim();
      const id = uid();
      return { id, audioId: id, fileName, name: fileName, mimeType: '', type: '', size: 0 };
    });
    const audioByName = new Map(audio.map(item => [item.fileName, item.audioId]));
    return {
      schemaVersion: 2,
      version: 25,
      canvas: { width: STAGE_W, height: STAGE_H },
      metadata: {
        eventName: metadataInputs[0]?.value || '',
        performerName: metadataInputs[1]?.value || '',
        performanceOrder: metadataInputs[2]?.value || '',
        performanceTime: metadataInputs[3]?.value || '',
        allottedTime: metadataInputs[4]?.value || '',
        eventDate: metadataInputs[5]?.value || '',
      },
      objects,
      equipment: {
        brought: $$('#carryList .equip-row').map(row => ({ id: uid(), source: 'manual', name: $('input', row)?.value || '', qty: $('.qty', row)?.value || '', detail: '' })),
        venue_borrow: $$('#venueBorrowList .request-row').map(row => ({ id: uid(), source: 'manual', name: $('input', row)?.value || '', qty: $('.qty', row)?.value || '', detail: '' })),
        rental: $$('#rentalList .request-row').map(row => ({ id: uid(), source: 'manual', name: $('input', row)?.value || '', qty: $('.qty', row)?.value || '', detail: '' })),
        unspecified: $$('#unspecifiedList .request-row').map(row => ({ id: uid(), source: 'manual', name: $('input', row)?.value || '', qty: $('.qty', row)?.value || '', detail: '' })),
        order: { brought: [], venue_borrow: [], rental: [], unspecified: [] },
      },
      notes: $('.notes textarea')?.value || '',
      otherRequests: $('.other-request textarea')?.value || '',
      audio,
      setlist: $$('#setlistBody .setlist-row').map(row => {
        const inputs = $$('input:not([type="file"])', row);
        const method = $('.audio-method', row)?.value || '音源なし';
        const audioId = audioByName.get(method) || '';
        const id = uid();
        return {
          id,
          setlistRowId: id,
          type: $('.type-select', row)?.value || '曲',
          title: inputs[0]?.value || '',
          duration: inputs[1]?.value || '',
          audioRef: audioId ? `audio:${audioId}` : method,
          audioId,
          playbackMode: audioId ? 'file' : method,
          soundRequest: inputs[2]?.value || '',
          lightRequest: inputs[3]?.value || '',
          playbackCue: 'none',
          playbackCueCustom: '',
          playbackCueDetail: '',
        };
      }),
      setlistOutputMode: 'normal',
      singleMix: { audioRef: '音源なし', audioId: '', playbackMode: '音源なし', duration: '', playbackCue: 'none', playbackCueCustom: '', playbackCueDetail: '', note: '' },
    };
  }

  function sanitise(raw) {
    const fallback = initialState || parseInitialState();
    const source = raw && typeof raw === 'object' ? raw : fallback;
    const metadata = { ...fallback.metadata, ...(source.metadata || {}) };
    metadata.eventDate = String(metadata.eventDate || metadata.event_date || '');
    metadata.performanceOrder = normalizePerformanceOrder(metadata.performanceOrder);
    delete metadata.event_date;
    const number = (value, fallbackValue, min, max) => Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallbackValue;
    const objects = Array.isArray(source.objects) ? source.objects.map(item => {
      const object = {
        id: String(item.id || uid()),
        type: TOOLS.includes(item.type) ? item.type : 'rect',
        x: number(item.x, 350, 0, STAGE_W),
        y: number(item.y, 220, 0, STAGE_H),
        width: number(item.width, 76, 6, 420),
        height: number(item.height, 40, 6, 260),
        rotation: number(item.rotation, 0, -3600, 3600),
        scale: number(item.scale, 100, 30, 300),
        label: String(item.label ?? TYPE_LABELS[item.type] ?? ''),
        fontSize: number(item.fontSize, defaultFontSize(item.type), 8, 72),
        category: normalizeCategory(item.category),
        labelEdited: Boolean(item.labelEdited || !item.html),
        className: String(item.className || ''),
        html: String(item.html || ''),
        labelOffsetX: number(item.labelOffsetX, 0, -STAGE_W, STAGE_W),
        labelOffsetY: number(item.labelOffsetY, 0, -STAGE_H, STAGE_H),
        ratioLocked: typeof item.ratioLocked === 'boolean' ? item.ratioLocked : ['line', 'arrow', 'text', 'microphone', 'monitor', 'power'].includes(item.type),
        geometrySized: Boolean(item.geometrySized || item.symbolKind),
        groupId: String(item.groupId || ''),
        locked: Boolean(item.locked),
      };
      if (Number.isFinite(Number(item.strokeWidth))) object.strokeWidth = number(item.strokeWidth, 2, .5, 8);
      for (const key of ['physicalWidthMm', 'physicalDepthMm']) if (Number.isFinite(Number(item[key]))) object[key] = Number(item[key]);
      for (const key of ['physicalDimensionSource', 'dimensionStatus', 'fillStyle', 'symbolKind', 'splitLabel', 'equipmentKey', 'equipmentModel', 'equipmentFamily']) if (item[key] != null) object[key] = String(item[key]);
      if (typeof item.physicalDimensionVerified === 'boolean') object.physicalDimensionVerified = item.physicalDimensionVerified;
      if (!object.html) object.html = objectMarkup(object);
      return object;
    }) : deep(fallback.objects);
    const row = item => ({ id: String(item.id || uid()), source: 'manual', name: String(item.name || ''), qty: String(item.qty || ''), detail: String(item.detail || '') });
    const brought = Array.isArray(source.equipment?.brought) ? source.equipment.brought.map(row) : [];
    const venueBorrow = Array.isArray(source.equipment?.venue_borrow) ? source.equipment.venue_borrow.map(row) : [];
    const rental = Array.isArray(source.equipment?.rental) ? source.equipment.rental.map(row) : [];
    const ambiguous = [
      ...(Array.isArray(source.equipment?.requested) ? source.equipment.requested : []),
      ...(Array.isArray(source.equipment?.borrowed) ? source.equipment.borrowed : []),
    ].map(item => ({ ...row(item), legacyProvision: String(item?.legacyProvision || item?.category || 'requested') }));
    const unspecified = [...(Array.isArray(source.equipment?.unspecified) ? source.equipment.unspecified.map(row) : []), ...ambiguous];
    const audio = item => {
      const id = String(item.audioId || item.id || uid());
      return { id, audioId: id, fileName: String(item.fileName || item.name || '音源'), name: String(item.name || item.fileName || '音源'), mimeType: String(item.mimeType || item.type || ''), type: String(item.type || item.mimeType || ''), size: Number(item.size || 0) };
    };
    const setRow = item => {
      const id = String(item.id || item.setlistRowId || uid());
      const audioRef = String(item.audioRef || item.playbackMode || '音源なし');
      const audioId = String(item.audioId || (audioRef.startsWith('audio:') ? audioRef.slice(6) : ''));
      return { id, setlistRowId: id, type: TYPES.includes(item.type) ? item.type : '曲', title: String(item.title || ''), duration: String(item.duration || ''), audioRef, audioId, playbackMode: String(item.playbackMode || (audioId ? 'file' : audioRef)), soundRequest: String(item.soundRequest ?? item.sound ?? ''), lightRequest: String(item.lightRequest ?? item.lighting ?? ''), playbackCue: CUES.includes(item.playbackCue) ? item.playbackCue : 'none', playbackCueCustom: String(item.playbackCueCustom || ''), playbackCueDetail: String(item.playbackCueDetail || '') };
    };
    const sourceSingleMix = source.singleMix && typeof source.singleMix === 'object' ? source.singleMix : {};
    const singleMixAudioRef = String(sourceSingleMix.audioRef || sourceSingleMix.playbackMode || '音源なし');
    const singleMixAudioId = String(sourceSingleMix.audioId || (singleMixAudioRef.startsWith('audio:') ? singleMixAudioRef.slice(6) : ''));
    return {
      schemaVersion: 2,
      version: 25,
      canvas: { width: STAGE_W, height: STAGE_H },
      metadata,
      objects,
      equipment: {
        brought,
        venue_borrow: venueBorrow,
        rental,
        unspecified,
        order: {
          brought: equipmentOrderFor(source.equipment?.order?.brought, brought, objects, 'brought'),
          venue_borrow: equipmentOrderFor(source.equipment?.order?.venue_borrow, venueBorrow, objects, 'venue_borrow'),
          rental: equipmentOrderFor(source.equipment?.order?.rental, rental, objects, 'rental'),
          unspecified: equipmentOrderFor(source.equipment?.order?.unspecified, unspecified, objects, 'unspecified'),
        },
      },
      notes: String(source.notes || ''),
      otherRequests: String(source.otherRequests ?? source.otherRequest ?? ''),
      audio: Array.isArray(source.audio) ? source.audio.map(audio) : [],
      setlist: Array.isArray(source.setlist) ? source.setlist.map(setRow) : [],
      setlistOutputMode: OUTPUT_MODES.includes(source.setlistOutputMode) ? source.setlistOutputMode : 'normal',
      singleMix: {
        audioRef: singleMixAudioRef,
        audioId: singleMixAudioId,
        playbackMode: String(sourceSingleMix.playbackMode || (singleMixAudioId ? 'file' : singleMixAudioRef)),
        duration: String(sourceSingleMix.duration || ''),
        playbackCue: CUES.includes(sourceSingleMix.playbackCue) ? sourceSingleMix.playbackCue : 'none',
        playbackCueCustom: String(sourceSingleMix.playbackCueCustom || ''),
        playbackCueDetail: String(sourceSingleMix.playbackCueDetail || ''),
        note: String(sourceSingleMix.note || ''),
      },
    };
  }

  function saveLocal() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {}
  }

  function remember(before) {
    undoStack.push(before);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateHistory();
  }

  function notifyChange(source = 'edit') {
    window.dispatchEvent(new CustomEvent('ara:stage-plot-change', {
      detail: { source, state: deep(state) },
    }));
  }

  function commit(mutator, options = {}) {
    const before = deep(state);
    mutator();
    state = sanitise(state);
    if (JSON.stringify(before) === JSON.stringify(state)) return;
    remember(before);
    saveLocal();
    render(options);
    notifyChange(options.source || 'edit');
  }

  function replaceState(next, rememberPrevious = true, source = 'replace') {
    const before = state ? deep(state) : null;
    state = sanitise(next);
    if (rememberPrevious && before) remember(before);
    saveLocal();
    selected = null;
    selectedIds.clear();
    showHandles = false;
    render();
    notifyChange(source);
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(deep(state));
    state = sanitise(undoStack.pop());
    selected = null;
    selectedIds.clear();
    showHandles = false;
    saveLocal();
    render();
    notifyChange('undo');
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(deep(state));
    state = sanitise(redoStack.pop());
    selected = null;
    selectedIds.clear();
    showHandles = false;
    saveLocal();
    render();
    notifyChange('redo');
  }

  function objectHtml(type, label = TYPE_LABELS[type]) {
    if (type === 'rect') return `<div class="rect">${escapeHtml(label)}</div>`;
    if (type === 'circle') return `<div class="circle">${escapeHtml(label)}</div>`;
    if (type === 'line') return '<div class="engine-line"></div>';
    if (type === 'arrow') return '<div class="engine-arrow"></div>';
    if (type === 'text') return `<div class="engine-text">${escapeHtml(label)}</div>`;
    if (type === 'power') return `<div class="power-mark">${escapeHtml(label || '100V')}</div>`;
    if (type === 'microphone') return '<svg class="mic-svg" viewBox="0 0 160 180" aria-label="mic"><line x1="80" y1="28" x2="80" y2="148" stroke="#000" stroke-width="8"/><circle cx="80" cy="92" r="29" fill="#fff" stroke="#000" stroke-width="7"/><line x1="80" y1="54" x2="80" y2="130" stroke="#000" stroke-width="8"/><polygon points="80,8 56,38 104,38" fill="#000"/></svg>';
    if (type === 'monitor') return '<svg class="mon-svg" viewBox="0 0 220 180" aria-label="monitor"><rect x="30" y="34" width="160" height="112" fill="#fff" stroke="#000" stroke-width="9"/><polygon points="38,38 182,38 110,112" fill="#000"/></svg>';
    return `<div class="engine-text">${escapeHtml(label)}</div>`;
  }

  function objectMarkup(object) {
    const label = escapeHtml(object.label);
    if (object.symbolKind === 'topview-equipment-split') return `<div class="rect topview-symbol is-split"><span class="object-label">${label}</span><span class="object-label">${escapeHtml(object.splitLabel)}</span></div>`;
    if (object.symbolKind === 'topview-equipment') return `<div class="rect topview-symbol"><span class="object-label">${label}</span></div>`;
    if (object.symbolKind === 'drum-kick') return `<div class="rect topview-symbol is-kick"><span class="object-label">${label}</span></div>`;
    if (object.symbolKind === 'drum-pedal') return `<div class="rect topview-symbol is-pedal"><span class="object-label">${label}</span></div>`;
    if (object.symbolKind === 'cymbal') return `<div class="circle topview-symbol is-cymbal"><span class="object-label">${label}</span></div>`;
    if (object.symbolKind === 'drum-shell') return `<div class="circle topview-symbol is-drum-shell"><span class="object-label">${label}</span></div>`;
    return objectHtml(object.type, object.label);
  }

  function syncObjectContent(object) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = object.symbolKind ? objectMarkup(object) : (object.html || objectHtml(object.type, object.label));
    const labelNode = $('.rect,.circle,.power-mark,.engine-text', wrapper);
    if (labelNode && object.labelEdited && !object.symbolKind) labelNode.textContent = object.label;
    if (labelNode && !object.symbolKind && !$('.object-label', labelNode)) {
      const label = document.createElement('span');
      label.className = 'object-label';
      while (labelNode.firstChild) label.appendChild(labelNode.firstChild);
      labelNode.appendChild(label);
    }
    if (object.category === 'brought') $('.rect,.circle', wrapper)?.classList.add('borrow');
    else $('.rect,.circle', wrapper)?.classList.remove('borrow');
    return wrapper.innerHTML;
  }

  function objectNode(object) {
    const node = document.createElement('div');
    const isSelected = selectedIds.has(object.id);
    node.className = `obj engine-object ${object.className || ''} category-${object.category}${isSelected ? ' selected' : ''}${keyObjectId === object.id ? ' key-object' : ''}${Number.isFinite(object.strokeWidth) ? ' has-custom-stroke' : ''}${object.geometrySized ? ' geometry-sized' : ''}${object.locked ? ' locked' : ''}`.replace(/\s+/g, ' ').trim();
    node.dataset.id = object.id;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', object.label || TYPE_LABELS[object.type]);
    node.setAttribute('aria-disabled', String(object.locked));
    node.innerHTML = syncObjectContent(object);
    updateObjectNode(node, object);
    if (selectedIds.size === 1 && selected === object.id && showHandles && !object.locked) {
      node.insertAdjacentHTML('beforeend', '<button class="transform-handle rotate-handle" data-transform="rotate" type="button" aria-label="自由回転"></button><button class="transform-handle resize-handle nw" data-transform="resize-nw" type="button" aria-label="左上からサイズ変更"></button><button class="transform-handle resize-handle ne" data-transform="resize-ne" type="button" aria-label="右上からサイズ変更"></button><button class="transform-handle resize-handle se" data-transform="resize-se" type="button" aria-label="右下からサイズ変更"></button><button class="transform-handle resize-handle sw" data-transform="resize-sw" type="button" aria-label="左下からサイズ変更"></button><button class="transform-handle resize-handle n" data-transform="resize-n" type="button" aria-label="上辺から高さ変更"></button><button class="transform-handle resize-handle e" data-transform="resize-e" type="button" aria-label="右辺から幅変更"></button><button class="transform-handle resize-handle s" data-transform="resize-s" type="button" aria-label="下辺から高さ変更"></button><button class="transform-handle resize-handle w" data-transform="resize-w" type="button" aria-label="左辺から幅変更"></button>');
    }
    return node;
  }

  function updateObjectNode(node, object) {
    node.style.left = `${object.x}px`;
    node.style.top = `${object.y}px`;
    if (object.symbolKind || object.geometrySized) {
      node.style.width = `${object.width}px`;
      node.style.height = `${object.height}px`;
      node.style.setProperty('--object-width', `${object.width}px`);
      node.style.setProperty('--object-height', `${object.height}px`);
    }
    node.style.transform = `rotate(${object.rotation}deg) scale(${object.scale / 100})`;
    node.style.transformOrigin = 'center';
    const colors = {
      unspecified: { fill: '#fff', stroke: '#c9d1d8', text: '#263442' },
      brought: { fill: '#f9dfe1', stroke: '#c83b45', text: '#6f151a' },
      venue_borrow: { fill: '#fff', stroke: '#111', text: '#111' },
      rental: { fill: '#dff4fb', stroke: '#2382b8', text: '#07577f' },
    }[object.category] || { fill: '#fff', stroke: '#c9d1d8', text: '#263442' };
    node.style.setProperty('--object-fill', colors.fill);
    node.style.setProperty('--object-stroke', colors.stroke);
    node.style.setProperty('--object-text', colors.text);
    if (Number.isFinite(object.strokeWidth)) {
      const effectiveScale = Math.max(.01, object.scale / 100);
      node.style.setProperty('--object-stroke-width', `${object.strokeWidth / effectiveScale}px`);
      node.style.setProperty('--mic-stroke-width', `${object.geometrySized ? object.strokeWidth : object.strokeWidth * 160 / 38 / effectiveScale}px`);
      node.style.setProperty('--monitor-stroke-width', `${object.geometrySized ? object.strokeWidth : object.strokeWidth * 220 / 56 / effectiveScale}px`);
    } else node.style.removeProperty('--object-stroke-width');
    const labelNode = $('.rect,.circle,.power-mark,.engine-text', node);
    if (labelNode) labelNode.style.fontSize = `${object.fontSize / (object.scale / 100)}px`;
    $$('.object-label', node).forEach(label => {
      label.style.position = 'relative';
      label.style.left = `${object.labelOffsetX / Math.max(.01, object.scale / 100)}px`;
      label.style.top = `${object.labelOffsetY / Math.max(.01, object.scale / 100)}px`;
    });
  }

  function renderStage() {
    const stage = $('.stage');
    $$('.stage > .obj,.stage > .editor-overlay').forEach(node => node.remove());
    const fragment = document.createDocumentFragment();
    state.objects.forEach(object => fragment.appendChild(objectNode(object)));
    stage.appendChild(fragment);
    renderEditorOverlays();
  }

  function selectedObject() {
    return state.objects.find(object => object.id === selected);
  }

  function selectedObjects() {
    return state.objects.filter(object => selectedIds.has(object.id));
  }

  function effectiveBounds(object) {
    const scale = object.scale / 100;
    const baseWidth = object.width * scale;
    const baseHeight = object.height * scale;
    const radians = Number(object.rotation || 0) * Math.PI / 180;
    const width = Math.abs(baseWidth * Math.cos(radians)) + Math.abs(baseHeight * Math.sin(radians));
    const height = Math.abs(baseWidth * Math.sin(radians)) + Math.abs(baseHeight * Math.cos(radians));
    const centerX = object.x + object.width / 2;
    const centerY = object.y + object.height / 2;
    return {
      left: centerX - width / 2,
      top: centerY - height / 2,
      right: centerX + width / 2,
      bottom: centerY + height / 2,
      width,
      height,
      centerX,
      centerY,
    };
  }

  function boundsFor(objects) {
    if (!objects.length) return null;
    const boxes = objects.map(effectiveBounds);
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
  }

  function groupIdsFor(object) {
    if (!object?.groupId) return [object?.id].filter(Boolean);
    return state.objects.filter(item => item.groupId === object.groupId).map(item => item.id);
  }

  function expandSelectionGroups(ids) {
    const expanded = new Set(ids);
    state.objects.forEach(object => {
      if (expanded.has(object.id) && object.groupId) state.objects.forEach(member => { if (member.groupId === object.groupId) expanded.add(member.id); });
    });
    return expanded;
  }

  function renderEditorOverlays() {
    const stage = $('.stage');
    $$('.editor-overlay', stage).forEach(node => node.remove());
    const magnet = document.createElement('button');
    magnet.type = 'button';
    magnet.className = 'magnet-toggle editor-overlay';
    magnet.dataset.editorAction = 'magnet';
    magnet.setAttribute('aria-pressed', String(magnetEnabled));
    magnet.textContent = `Magnet ${magnetEnabled ? 'ON' : 'OFF'}`;
    stage.append(magnet);
    const objects = selectedObjects();
    if (!objects.length) return;
    const box = boundsFor(objects);
    if (objects.length > 1) {
      const overlay = document.createElement('div');
      overlay.className = 'selection-box editor-overlay';
      overlay.dataset.selectionOverlay = 'true';
      overlay.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
      if (!objects.every(object => object.locked)) overlay.innerHTML = '<button class="transform-handle rotate-handle" data-transform="multi-rotate" type="button" aria-label="選択範囲を回転"></button><button class="transform-handle resize-handle nw" data-transform="multi-resize-nw" type="button" aria-label="選択範囲をサイズ変更"></button><button class="transform-handle resize-handle ne" data-transform="multi-resize-ne" type="button" aria-label="選択範囲をサイズ変更"></button><button class="transform-handle resize-handle se" data-transform="multi-resize-se" type="button" aria-label="選択範囲をサイズ変更"></button><button class="transform-handle resize-handle sw" data-transform="multi-resize-sw" type="button" aria-label="選択範囲をサイズ変更"></button>';
      stage.append(overlay);
    }
    if (objects.some(object => object.locked)) {
      const indicator = document.createElement('span');
      indicator.className = 'selection-lock-indicator editor-overlay';
      indicator.textContent = '🔒';
      indicator.style.cssText = `left:${clamp(box.right - 8, 2, STAGE_W - 20)}px;top:${clamp(box.top - 17, 2, STAGE_H - 20)}px`;
      stage.append(indicator);
    }
    const entities = selectionEntities(objects);
    const entityCount = entities.length;
    const singleGroup = entityCount === 1 && entities[0].some(object => object.groupId);
    const toolbar = document.createElement('div');
    toolbar.className = 'selection-toolbar editor-overlay';
    toolbar.dataset.selectionToolbar = 'true';
    toolbar.style.left = `${clamp(box.left, 4, STAGE_W - 385)}px`;
    toolbar.style.top = `${clamp(box.top - 70, 4, STAGE_H - 34)}px`;
    const group = entityCount >= 2 || singleGroup ? `<button class="group-toggle${singleGroup ? ' is-active' : ''}" aria-pressed="${singleGroup}" data-editor-action="group-toggle" type="button">Group</button>` : '';
    const locked = objects.every(object => object.locked);
    const lock = `<button class="lock-toggle${locked ? ' is-active' : ''}" aria-pressed="${locked}" data-editor-action="lock" type="button">Lock</button>`;
    const align = entityCount >= 2 ? '<span class="selection-menu-wrap"><button data-editor-action="align-menu" type="button" aria-expanded="false">整列</button><span class="selection-submenu align-menu" hidden><button data-editor-action="align-left" title="左揃え" aria-label="左揃え">↤</button><button data-editor-action="align-center" title="横中央揃え" aria-label="横中央揃え">↔</button><button data-editor-action="align-right" title="右揃え" aria-label="右揃え">↦</button><button data-editor-action="align-top" title="上揃え" aria-label="上揃え">↥</button><button data-editor-action="align-middle" title="縦中央揃え" aria-label="縦中央揃え">↕</button><button data-editor-action="align-bottom" title="下揃え" aria-label="下揃え">↧</button></span></span>' : '';
    const distribute = entityCount >= 3 ? '<span class="selection-menu-wrap"><button data-editor-action="distribute-menu" type="button" aria-expanded="false">等間隔配置</button><span class="selection-submenu distribute-menu" hidden><button data-editor-action="distribute-horizontal" title="横方向に等間隔" aria-label="横方向に等間隔">↔</button><button data-editor-action="distribute-vertical" title="縦方向に等間隔" aria-label="縦方向に等間隔">↕</button></span></span>' : '';
    const center = entityCount === 2 ? '<button data-editor-action="center-equidistance" type="button">Center</button>' : '';
    toolbar.innerHTML = `${group}${lock}${align}${distribute}${center}<button data-editor-action="mirror" type="button">Mirror</button><button data-editor-action="mirror-duplicate" type="button">Mirror＋</button>`;
    const submenu = $(`.${openSelectionMenu}-menu`, toolbar);
    if (submenu) { submenu.hidden = false; submenu.previousElementSibling?.setAttribute('aria-expanded', 'true'); }
    stage.append(toolbar);
  }

  function selectOnly(id) {
    selected = id || null;
    selectedIds = id ? new Set([id]) : new Set();
    keyObjectId = '';
    openSelectionMenu = '';
    showHandles = Boolean(id);
  }

  function inspectorParts() {
    return {
      title: $('#selectedTitle'),
      label: $('#objectLabelInput'),
      x: $('#objectXInput'), y: $('#objectYInput'), width: $('#objectWidthInput'), height: $('#objectHeightInput'),
      rotation: $('#objectRotationInput'), minus: $('#rotationMinusBtn'), zero: $('#rotationZeroBtn'), plus: $('#rotationPlusBtn'),
      scale: $('#objectScaleInput'), scaleReset: $('#scaleResetBtn'), ratioLock: $('#ratioLockInput'),
      fontSize: $('#objectFontSizeInput'), fontMinus: $('#fontMinusBtn'), fontDefault: $('#fontDefaultBtn'), fontPlus: $('#fontPlusBtn'),
      category: $('#objectCategorySelect'),
      strokeWidth: $('#strokeWidthInput'), strokeMinus: $('#strokeMinusBtn'), strokePlus: $('#strokePlusBtn'),
      labelOffsetX: $('#labelOffsetXInput'), labelOffsetY: $('#labelOffsetYInput'), labelOffsetReset: $('#labelOffsetResetBtn'),
      swatches: $$('[data-object-category]', $('.left .props')),
      actions: $$('[data-editor-action]', $('.left .props')),
    };
  }

  function renderInspector({ hydrateSelection = false } = {}) {
    const parts = inspectorParts();
    const object = selectedObject();
    const objects = selectedObjects();
    if (parts.title) parts.title.textContent = objects.length > 1 ? `選択中：${objects.length}個` : `選択中：${object?.label || '未選択'}`;
    const controls = [parts.label, parts.x, parts.y, parts.width, parts.height, parts.rotation, parts.scale, parts.ratioLock, parts.fontSize, parts.category, parts.labelOffsetX, parts.labelOffsetY, parts.labelOffsetReset, ...parts.swatches, parts.minus, parts.zero, parts.plus, parts.scaleReset, parts.fontMinus, parts.fontDefault, parts.fontPlus, ...parts.actions];
    controls.forEach(control => { if (control) control.disabled = !object; });
    const strokeObjects = objects.filter(item => item.type !== 'text');
    [parts.strokeWidth, parts.strokeMinus, parts.strokePlus].forEach(control => { if (control) control.disabled = !strokeObjects.length; });
    if (parts.strokeWidth) {
      const values = [...new Set(strokeObjects.map(item => Number.isFinite(item.strokeWidth) ? item.strokeWidth : (item.type === 'power' ? 1.5 : 2)))];
      parts.strokeWidth.placeholder = values.length > 1 ? '—' : '';
      parts.strokeWidth.value = values.length === 1 ? String(values[0]) : '';
    }
    if (!object) {
      [parts.label, parts.x, parts.y, parts.width, parts.height, parts.rotation, parts.scale, parts.fontSize, parts.category, parts.labelOffsetX, parts.labelOffsetY].forEach(control => { if (control && document.activeElement !== control) control.value = ''; });
      return;
    }
    // A selection is a read-only projection boundary.  The browser does not
    // move focus away from the prior inspector input until after pointerdown,
    // so preserving that focused value here would leak it onto the new object.
    if (hydrateSelection || document.activeElement !== parts.label) parts.label.value = object.label;
    if (hydrateSelection || document.activeElement !== parts.rotation) parts.rotation.value = `${object.rotation}°`;
    if (hydrateSelection || document.activeElement !== parts.scale) parts.scale.value = `${Math.round(object.scale * 10) / 10}%`;
    if (hydrateSelection || document.activeElement !== parts.fontSize) parts.fontSize.value = `${object.fontSize}`;
    const box = boundsFor(objects);
    const setValue = (control, value) => { if (control && (hydrateSelection || document.activeElement !== control)) control.value = Number.isFinite(value) ? String(Math.round(value * 10) / 10) : ''; };
    setValue(parts.x, objects.length > 1 ? box.left : object.x);
    setValue(parts.y, objects.length > 1 ? box.top : object.y);
    setValue(parts.width, objects.length > 1 ? box.width : object.width * object.scale / 100);
    setValue(parts.height, objects.length > 1 ? box.height : object.height * object.scale / 100);
    setValue(parts.labelOffsetX, object.labelOffsetX);
    setValue(parts.labelOffsetY, object.labelOffsetY);
    if (parts.ratioLock) {
      const ratioValues = new Set(objects.map(item => Boolean(item.ratioLocked)));
      parts.ratioLock.indeterminate = ratioValues.size > 1;
      parts.ratioLock.checked = ratioValues.size === 1 && Boolean(object.ratioLocked);
    }
    if (parts.fontDefault) parts.fontDefault.textContent = '16px';
    if (parts.category) parts.category.value = object.category;
    parts.swatches.forEach(swatch => swatch.setAttribute('aria-pressed', String(swatch.dataset.objectCategory === object.category)));
    const lockButton = parts.actions.find(button => button.dataset.editorAction === 'lock');
    if (lockButton) lockButton.textContent = objects.every(item => item.locked) ? 'Unlock' : 'Lock / Unlock';
  }

  function renderMetadata() {
    const orderLabel = state.metadata.performanceOrder ? `${state.metadata.performanceOrder}番目` : '';
    const values = [state.metadata.eventName, state.metadata.performerName, orderLabel, state.metadata.performanceTime, state.metadata.allottedTime];
    const editorValues = [state.metadata.eventName, state.metadata.performerName, state.metadata.performanceOrder, state.metadata.performanceTime, state.metadata.allottedTime, state.metadata.eventDate];
    $$('.meta-field input,.meta-field select').forEach((input, index) => { if (document.activeElement !== input) input.value = editorValues[index] || ''; });
    const artist = $('.page-title .artist');
    if (artist) artist.textContent = state.metadata.performerName || '出演者名';
    const center = $('.page-title .center');
    if (center) {
      center.textContent = '';
      center.append(document.createTextNode(state.metadata.eventName || 'イベント名'), document.createElement('br'));
      const detail = document.createElement('span');
      detail.style.cssText = 'font-size:16px;font-weight:700;letter-spacing:.03em';
      detail.textContent = `STAGE PLOT / 出演順 ${orderLabel || '—'} / ${state.metadata.performanceTime || '—'}`;
      center.append(detail);
    }
    $$('.sheet-meta-item strong').forEach((node, index) => {
      node.textContent = values[index] || ['イベント名', '出演者名', '—', '—', '—'][index];
    });
    const eventDate = $('.sheet-event-date');
    if (eventDate) eventDate.textContent = `開催日 ${formatEventDate(state.metadata.eventDate) || '未設定'}`;
  }

  function formatEventDate(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u);
    return match ? `${match[1]}/${String(match[2]).padStart(2, '0')}/${String(match[3]).padStart(2, '0')}` : text;
  }

  function printBrandMarkup() {
    return `<header class="print-brand"><span>開催日 ${escapeHtml(formatEventDate(state.metadata.eventDate) || '未設定')}</span><img src="/img/ara-tech-logo-horizontal-black.png" alt="ARA-TECH"></header>`;
  }

  function printMetadataMarkup() {
    const fields = [
      ['イベント名', state.metadata.eventName || 'イベント名'],
      ['出演者名 / バンド名', state.metadata.performerName || '出演者名'],
      ['出演順', state.metadata.performanceOrder ? `${state.metadata.performanceOrder}番目` : '—'],
      ['出演時間', state.metadata.performanceTime || '—'],
      ['持ち時間', state.metadata.allottedTime || '—'],
    ];
    return `<section class="print-document-meta" aria-label="出演情報">${fields.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</section>`;
  }

  function audioLabel(row) {
    const linked = row.audioId && state.audio.find(item => (item.audioId || item.id) === row.audioId);
    if (linked) return String(linked.fileName || linked.name || '');
    const value = String(row.audioRef || '');
    return ['', '音源なし', '未割当'].includes(value) ? '' : value;
  }

  function cuePresentation(row) {
    const cue = CUES.includes(row.playbackCue) ? row.playbackCue : 'none';
    const cueText = cue === 'custom' ? String(row.playbackCueCustom || '').trim() : cue === 'none' ? '' : CUE_LABELS[cue];
    const audio = audioLabel(row);
    const detail = String(row.playbackCueDetail || '').trim();
    if (!cueText && !audio && !detail) return null;
    const kind = cue === 'continuous' ? 'continuous' : cue === 'none' ? 'audio-only' : 'trigger';
    const tag = kind === 'continuous' ? '連続' : kind === 'trigger' ? 'きっかけ' : '音源';
    return { kind, tag, cueText, audio, detail };
  }

  function setlistUnitMarkup(row, index) {
    const cue = cuePresentation(row);
    const cueParts = cue ? [
      cue.cueText ? `<span class="cue-label">再生キュー：</span><span class="cue-action ${cue.kind}">${escapeHtml(cue.cueText)}</span>` : '',
      cue.audio ? `<span class="cue-label">音源：</span><span class="cue-audio">${escapeHtml(cue.audio)}</span>` : '',
      cue.detail ? `<span class="cue-label">補足：</span><span class="cue-note">${escapeHtml(cue.detail)}</span>` : '',
    ].filter(Boolean) : [];
    const cueRow = cue ? `<tr class="print-cue-row cue-${cue.kind}"><td colspan="6"><span class="cue-kind ${cue.kind}">${cue.tag}</span>${cueParts.join('<span class="cue-divider">｜</span>')}</td></tr>` : '';
    return `<tbody class="print-setlist-unit ${row.type === '曲' ? 'song' : 'non-song'}">${cueRow}<tr class="print-main-row"><td>${index + 1}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.title)}</td><td>${escapeHtml(row.duration)}</td><td>${escapeHtml(row.soundRequest)}</td><td>${escapeHtml(row.lightRequest)}</td></tr></tbody>`;
  }

  function paginateSetlist(rows) {
    const pages = [];
    let page = [];
    let weight = 0;
    rows.forEach((row, index) => {
      const longest = Math.max(String(row.title || '').length, String(row.soundRequest || '').length, String(row.lightRequest || '').length);
      const unitWeight = 1 + (cuePresentation(row) ? .62 : 0) + Math.min(1.4, Math.max(0, longest - 42) / 75);
      if (page.length && weight + unitWeight > 10.4) { pages.push(page); page = []; weight = 0; }
      page.push({ row, index });
      weight += unitWeight;
    });
    if (page.length) pages.push(page);
    return pages;
  }

  function renderPrintSetlistPages() {
    let root = $('.print-setlist-pages');
    if (!root) {
      root = document.createElement('section');
      root.className = 'print-setlist-pages';
      $('.setlist')?.insertAdjacentElement('afterend', root);
    }
    if (state.setlistOutputMode !== 'normal' || !state.setlist.length) {
      root.replaceChildren();
      return;
    }
    const pages = paginateSetlist(state.setlist);
    const total = formatDuration(state.setlist.reduce((sum, row) => sum + parseDuration(row.duration), 0));
    root.replaceChildren(...pages.map((pageRows, pageIndex) => {
      const article = document.createElement('article');
      article.className = 'print-setlist-page';
      article.innerHTML = `${printBrandMarkup()}${printMetadataMarkup()}<div class="print-page-title"><div class="print-page-title-main"><strong>SET LIST / 進行${pageIndex ? ' 続き' : ''}</strong>${pages.length > 1 ? `<small>${pageIndex + 1} of ${pages.length}</small>` : ''}</div><span class="print-total-badge">合計時間 <b>${escapeHtml(total)}</b></span></div><table class="print-setlist-table"><colgroup><col class="col-no"><col class="col-type"><col class="col-title"><col class="col-duration"><col class="col-sound"><col class="col-light"></colgroup><thead><tr><th>No.</th><th>種別</th><th>曲名・内容</th><th>時間</th><th>音響要望</th><th>照明要望</th></tr></thead>${pageRows.map(({ row, index }) => setlistUnitMarkup(row, index)).join('')}</table>${pageIndex === pages.length - 1 ? '<p class="print-setlist-foot">基本は事前データ提出。CD・本人再生等は例外指定。</p>' : ''}`;
      return article;
    }));
  }

  function equipmentRow(item, kind) {
    const row = document.createElement('div');
    row.className = `equip-row provision-${kind}${kind === 'brought' ? ' borrowed' : ''}`;
    row.draggable = true;
    row.dataset.equipmentKind = kind;
    row.dataset.equipmentKey = item.key;
    row.dataset.source = item.source;
    const manual = item.source === 'manual';
    row.innerHTML = `<div class="equipment-dragcell"><button class="draghandle equipment-drag-handle" type="button" title="ドラッグして並び替え" aria-label="ドラッグして並び替え">⠿</button></div><input ${manual ? `data-eq="${kind}" data-manual-id="${escapeHtml(item.id)}" data-key="name"` : 'readonly aria-readonly="true"'} value="${escapeHtml(item.name)}" placeholder="${CATEGORY_LABELS[kind]}"><input class="qty" ${manual ? `data-eq="${kind}" data-manual-id="${escapeHtml(item.id)}" data-key="qty"` : 'readonly aria-readonly="true"'} value="${escapeHtml(item.qty)}"><button type="button" class="remove-equip" ${manual ? `data-remove-eq="${kind}" data-manual-id="${escapeHtml(item.id)}"` : 'disabled aria-hidden="true"'}>×</button>`;
    return row;
  }

  function renderEquipment() {
    for (const kind of EQUIPMENT_KINDS) {
      const root = $(`#${EQUIPMENT_LIST_IDS[kind]}`);
      root?.replaceChildren(...equipmentItems(kind).map(item => equipmentRow(item, kind)));
      root?.closest('.equip-section')?.classList.toggle('is-empty', equipmentItems(kind).length === 0);
    }
    const notes = $('.notes textarea');
    const requests = $('.other-request textarea');
    if (document.activeElement !== notes) notes.value = state.notes;
    if (document.activeElement !== requests) requests.value = state.otherRequests;
    requestAnimationFrame(layoutEquipment);
  }

  function continuationNode() {
    let node = $('.equipment-continuation');
    if (!node) {
      node = document.createElement('section');
      node.className = 'equipment-continuation print-equipment-pages';
      $('.print-stage-page')?.insertAdjacentElement('afterend', node);
    }
    return node;
  }

  function renderEquipmentContinuation(hasOverflow) {
    const node = continuationNode();
    node.classList.toggle('has-overflow', hasOverflow);
    if (!hasOverflow) { node.replaceChildren(); return; }
    const byKind = Object.fromEntries(EQUIPMENT_KINDS.map(kind => [kind, equipmentItems(kind)]));
    const perColumn = 12;
    const other = String(state.otherRequests || '').trim();
    const otherChunks = [];
    let otherChunk = '';
    other.split(/\r?\n/u).forEach(line => {
      const candidate = otherChunk ? `${otherChunk}\n${line}` : line;
      if (otherChunk && candidate.length > 650) { otherChunks.push(otherChunk); otherChunk = line; }
      else otherChunk = candidate;
    });
    if (otherChunk) otherChunks.push(otherChunk);
    if (!otherChunks.length) otherChunks.push('なし');
    const itemPageCount = Math.max(1, ...EQUIPMENT_KINDS.map(kind => Math.ceil(byKind[kind].length / perColumn)));
    const pageCount = itemPageCount + Math.max(0, otherChunks.length - 1);
    const rows = items => `<table><tbody>${items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.qty)}</td></tr>`).join('')}</tbody></table>`;
    node.innerHTML = Array.from({ length: pageCount }, (_, pageIndex) => {
      const otherIndex = pageIndex - itemPageCount + 1;
      const otherChunk = otherIndex >= 0 ? otherChunks[otherIndex] : '';
      const equipmentSections = EQUIPMENT_KINDS.map(kind => {
        const items = byKind[kind].slice(pageIndex * perColumn, (pageIndex + 1) * perColumn);
        return items.length ? `<section class="equipment-panel provision-${kind}"><h3>${escapeHtml(CATEGORY_LABELS[kind])}</h3>${rows(items)}</section>` : '';
      }).filter(Boolean);
      const onlyOther = !equipmentSections.length && Boolean(otherChunk);
      return `<article class="print-equipment-page${onlyOther ? ' other-only' : ''}">${printBrandMarkup()}${printMetadataMarkup()}<div class="print-page-title"><div class="print-page-title-main"><strong>機材・手配リスト${pageIndex ? ' 続き' : ''}</strong><small>${pageIndex + 1} of ${pageCount}</small></div></div>${equipmentSections.length ? `<div class="equipment-columns${equipmentSections.length === 1 ? ' single-section' : ''}">${equipmentSections.join('')}</div>` : ''}${otherChunk ? `<section class="equipment-other"><h3>その他要望${otherChunks.length > 1 ? ` ${otherIndex + 1} / ${otherChunks.length}` : ''}</h3><p>${escapeHtml(otherChunk)}</p></section>` : ''}</article>`;
    }).join('');
  }

  function layoutEquipment() {
    // Printing must consume the screen-layout decision that already built the
    // continuation pages. Re-measuring the panel after print CSS is applied can
    // incorrectly make an overflowing list appear to fit and remove those pages.
    if (window.matchMedia?.('print').matches) return;
    const panel = $('.carry');
    const lists = EQUIPMENT_KINDS.map(kind => $(`#${EQUIPMENT_LIST_IDS[kind]}`)).filter(Boolean);
    if (!panel || lists.length !== EQUIPMENT_KINDS.length) return;
    const sections = $$('.carry > .equip-section');
    if (sections.length < 5) return;
    panel.classList.add('adaptive-equipment');
    ['density-normal', 'density-compact', 'density-dense'].forEach(name => panel.classList.remove(name));
    $$('.equipment-overflow-note', panel).forEach(node => node.remove());
    const rows = lists.flatMap(list => $$('.equip-row', list));
    rows.forEach(row => { row.hidden = false; });
    const fixed = $('.carry-main-title', panel).offsetHeight
      + (panel.children[1]?.offsetHeight || 0)
      + $$('.equip-title', panel).reduce((sum, node) => sum + node.offsetHeight, 0);
    const otherText = String(state.otherRequests || '');
    const otherLines = Math.max(1, otherText.split(/\r?\n/u).length, Math.ceil(otherText.length / 38));
    const minimumOther = clamp(58 + otherLines * 13, 108, 250);
    const capacity = Math.max(0, Math.floor(panel.clientHeight - fixed - minimumOther - 4));
    const total = rows.length;
    let mode = 'normal';
    let rowHeight = 38;
    if (total * rowHeight > capacity) { mode = 'compact'; rowHeight = 27; }
    if (total * rowHeight > capacity) { mode = 'dense'; rowHeight = 22; }
    const needsOverflow = total * rowHeight > capacity;
    const carryVisible = needsOverflow ? 0 : $$('.equip-row', $('#carryList')).length;
    const requestVisible = needsOverflow ? 0 : rows.length - carryVisible;
    const overflow = needsOverflow ? total : 0;
    rows.forEach(row => { row.hidden = needsOverflow; });
    panel.classList.toggle('equipment-deferred', needsOverflow);
    if (needsOverflow) {
      const note = document.createElement('div');
      note.className = 'equipment-overflow-note';
      note.textContent = '機材・手配リストは次ページに全件掲載';
      panel.append(note);
    }
    lists.forEach(list => list.style.setProperty('--equipment-list-height', `${(needsOverflow ? 0 : $$('.equip-row', list).length) * rowHeight}px`));
    panel.classList.add(`density-${mode}`);
    equipmentLayout = { mode, rowHeight, capacity, overflow, carryVisible, requestVisible, otherHeight: sections.at(-1).offsetHeight };
    renderEquipmentContinuation(needsOverflow);
  }

  function renderAudio() {
    const root = $('#audioFiles');
    if (!state.audio.length) {
      root.innerHTML = '<span class="audio-empty">音源は未追加です。</span>';
      return;
    }
    root.innerHTML = state.audio.map(item => {
      const id = item.audioId || item.id;
      const playable = audioUrls.has(id);
      return `<span class="audio-chip"><button class="play" data-play-audio="${escapeHtml(id)}" type="button" ${playable ? '' : 'disabled'}>${playable ? '▶' : '—'}</button>${escapeHtml(item.fileName || item.name)}${playable ? '' : '<small>（ファイル未接続）</small>'}</span>`;
    }).join('');
  }

  function parseDuration(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const minuteMatch = text.match(/^(\d+)\s*分$/);
    if (minuteMatch) return Number(minuteMatch[1]) * 60;
    const parts = text.split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 1 && Number.isFinite(parts[0])) return parts[0] * 60;
    return 0;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function audioOptions(row) {
    const values = [
      ...state.audio.map(item => ({ value: `audio:${item.audioId || item.id}`, label: item.fileName || item.name })),
      { value: '未割当', label: '未割当' }, { value: 'CD', label: 'CD' }, { value: '本人再生', label: '本人再生' }, { value: '音源なし', label: '音源なし' }, { value: 'その他', label: 'その他' },
    ];
    return values.map(option => `<option value="${escapeHtml(option.value)}" ${row.audioRef === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  }

  function cueOptions(selectedCue) {
    return CUES.map(cue => `<option value="${cue}" ${selectedCue === cue ? 'selected' : ''}>${CUE_LABELS[cue]}</option>`).join('');
  }

  function setlistRow(row, index) {
    const linked = row.audioId && state.audio.find(item => (item.audioId || item.id) === row.audioId);
    const playable = linked && audioUrls.has(linked.audioId || linked.id);
    return `<div class="setlist-editor-unit" draggable="true" data-set-id="${escapeHtml(row.id)}"><div class="setlist-row ${row.type === '曲' ? 'song' : 'non-song'}">
      <div class="dragcell"><button class="draghandle" type="button" title="ドラッグして並び替え">⠿</button></div>
      <div class="no">${index + 1}</div>
      <div><select class="type-select" data-set-index="${index}" data-set-key="type">${TYPES.map(type => `<option ${row.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></div>
      <div><input data-set-index="${index}" data-set-key="title" value="${escapeHtml(row.title)}" placeholder="曲名・進行内容"></div>
      <div><input data-set-index="${index}" data-set-key="duration" value="${escapeHtml(row.duration)}" placeholder="0:00"></div>
      <div class="audio-cell"><select class="audio-method" data-set-index="${index}" data-set-key="audioRef">${audioOptions(row)}</select><div class="audio-file">${linked && playable ? `<button type="button" data-play-audio="${escapeHtml(linked.audioId || linked.id)}">▶</button><span class="filename done">ローカル再生可</span>` : linked ? '<span class="filename">ファイル未接続</span>' : `<span class="filename">${row.audioRef === '音源なし' ? '—' : escapeHtml(row.audioRef || '—')}</span>`}</div></div>
      <div><input data-set-index="${index}" data-set-key="soundRequest" value="${escapeHtml(row.soundRequest)}" placeholder="音響への要望"></div>
      <div><input data-set-index="${index}" data-set-key="lightRequest" value="${escapeHtml(row.lightRequest)}" placeholder="照明への要望"></div>
      <div class="rowops"><button class="up" data-move-set="${index}" data-direction="-1" type="button">↑</button><button class="down" data-move-set="${index}" data-direction="1" type="button">↓</button><button class="delete" data-delete-set="${index}" type="button">×</button></div>
    </div><div class="setlist-cue-editor"><span>再生キュー</span><select data-set-index="${index}" data-set-key="playbackCue">${cueOptions(row.playbackCue)}</select><label class="cue-custom-field" ${row.playbackCue === 'custom' ? '' : 'hidden'}>任意入力<input data-set-index="${index}" data-set-key="playbackCueCustom" value="${escapeHtml(row.playbackCueCustom)}" placeholder="例：ギターが手を上げたらFADE OUT"></label><label>補足<input data-set-index="${index}" data-set-key="playbackCueDetail" value="${escapeHtml(row.playbackCueDetail)}" placeholder="固定キューにも補足できます"></label></div></div>`;
  }

  function renderOutputMode() {
    const mode = state.setlistOutputMode;
    const modeSelect = $('#setlistOutputMode');
    if (modeSelect && document.activeElement !== modeSelect) modeSelect.value = mode;
    const help = $('#setlistOutputHelp');
    if (help) help.textContent = mode === 'normal' ? 'SET LISTページを生成します。' : mode === 'single_mix' ? 'Stage Plot 1ページ目へ音源・進行を統合します。' : 'SET LISTページと音源・進行blockを生成しません。';
    const setlist = $('.setlist');
    if (setlist) setlist.hidden = mode !== 'normal';
    const editor = $('#singleMixEditor');
    if (editor) editor.hidden = mode !== 'single_mix';
    const mix = state.singleMix;
    const audio = $('#singleMixAudio');
    if (audio) { audio.innerHTML = audioOptions(mix); audio.value = mix.audioRef; }
    const cue = $('#singleMixCue');
    if (cue) { cue.innerHTML = cueOptions(mix.playbackCue); cue.value = mix.playbackCue; }
    const values = { singleMixDuration: mix.duration, singleMixCueCustom: mix.playbackCueCustom, singleMixCueDetail: mix.playbackCueDetail, singleMixNote: mix.note };
    Object.entries(values).forEach(([id, value]) => { const input = $(`#${id}`); if (input && document.activeElement !== input) input.value = value; });
    $('.single-mix-custom')?.toggleAttribute('hidden', mix.playbackCue !== 'custom');
    const stagePage = $('.print-stage-page');
    stagePage?.classList.toggle('output-single-mix', mode === 'single_mix');
    stagePage?.classList.toggle('output-no-setlist', mode === 'none');
    const printBlock = $('.single-mix-print-block');
    if (printBlock) {
      if (mode !== 'single_mix') printBlock.replaceChildren();
      else {
        const presentation = cuePresentation(mix);
        const audioName = audioLabel(mix) || '音源未指定';
        const cueName = mix.playbackCue === 'custom' ? mix.playbackCueCustom : CUE_LABELS[mix.playbackCue] || CUE_LABELS.none;
        printBlock.innerHTML = `<strong>音源・進行</strong><span class="single-mix-cue">${escapeHtml(cueName || CUE_LABELS.none)}</span><span class="single-mix-audio">${escapeHtml(audioName)}</span><span class="single-mix-duration">${escapeHtml(mix.duration || '時間未設定')}</span><span class="single-mix-detail">${escapeHtml(mix.playbackCueDetail || mix.note || '')}</span>${presentation?.kind === 'continuous' ? '<span class="single-mix-kind">連続</span>' : ''}`;
      }
    }
  }

  function renderSetlist() {
    $('#setlistBody').innerHTML = state.setlist.map(setlistRow).join('');
    const total = state.setlist.reduce((sum, row) => sum + parseDuration(row.duration), 0);
    const allotted = parseDuration(state.metadata.allottedTime);
    $('#totalTime').textContent = formatDuration(total);
    $('#setlistTotalBox').classList.toggle('over', Boolean(allotted && total > allotted));
    $('#setlistTotalBox').setAttribute('aria-label', allotted && total > allotted ? `合計時間 ${formatDuration(total)}。持ち時間を超えています` : `合計時間 ${formatDuration(total)}`);
  }

  function allPresets() {
    const deleted = new Set(presetLibraryState.tombstones || []);
    const builtins = BUILT_IN_PRESETS.filter(preset => !deleted.has(preset.id)).map(preset => ({ ...deep(preset), ...(presetLibraryState.overrides?.[preset.id] || {}), id: preset.id, kind: 'built-in', origin: 'builtin', readOnly: false }));
    return [...builtins, ...userPresets.map(preset => ({ ...preset, origin: 'custom', readOnly: false }))];
  }

  function savePresetLibrary() {
    presetLibraryState.custom = userPresets;
    presetLibraryState = presetStorage?.saveLibrary?.(presetLibraryState) || presetLibraryState;
    userPresets = presetLibraryState.custom || userPresets;
  }

  function activePreset() {
    return allPresets().find(preset => preset.id === activeCustomPresetId) || null;
  }

  function presetCategory(preset) {
    if (preset.kind === 'user') return 'Custom';
    const id = String(preset.id || '');
    if (/jc-120|jcm900/u.test(id)) return 'Guitar';
    if (/svt-810/u.test(id)) return 'Bass';
    if (/rd-300/u.test(id)) return 'Keyboard';
    if (/drum/u.test(id)) return 'Drum';
    return 'Other';
  }

  function saveLibraryUi() {
    try { localStorage.setItem(LIBRARY_UI_STORE, JSON.stringify(libraryUi)); } catch (_) {}
  }

  function recordRecentPreset(id) {
    libraryUi.recent = [id, ...libraryUi.recent.filter(value => value !== id)].slice(0, 8);
    saveLibraryUi();
  }

  function toggleFavoritePreset(id) {
    libraryUi.favorites = libraryUi.favorites.includes(id) ? libraryUi.favorites.filter(value => value !== id) : [...libraryUi.favorites, id];
    saveLibraryUi();
    renderPresetLibrary();
  }

  function presetRow(preset) {
    const favorite = libraryUi.favorites.includes(preset.id);
    const description = String(preset.description || '').trim();
    const action = presetEditMode ? `<button type="button" data-edit-preset="${escapeHtml(preset.id)}">編集</button>` : `<button type="button" data-place-preset="${escapeHtml(preset.id)}">配置</button>`;
    return `<div class="library-preset" data-preset-kind="${preset.kind}" data-preset-origin="${preset.origin || (preset.kind === 'built-in' ? 'builtin' : 'custom')}" data-preset-id="${escapeHtml(preset.id)}"><button class="library-favorite" type="button" data-favorite-preset="${escapeHtml(preset.id)}" aria-pressed="${favorite}" aria-label="${favorite ? 'お気に入りから外す' : 'お気に入りに追加'}">${favorite ? '★' : '☆'}</button><div><strong>${escapeHtml(preset.name)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ''}</div>${action}</div>`;
  }

  function renderPresetLibrary() {
    const root = $('#equipmentLibraryItems');
    const select = $('#customPresetSelect');
    if (!root || !select) return;
    const query = normalizedEquipmentLabel($('#equipmentLibrarySearch')?.value);
    const presets = allPresets().filter(preset => !query || normalizedEquipmentLabel([preset.name, presetCategory(preset), ...(preset.searchAliases || [])].join(' ')).includes(query));
    const byId = new Map(presets.map(preset => [preset.id, preset]));
    const sections = [];
    const addSection = (label, items) => { if (items.length) sections.push(`<section class="library-section"><h4>${label}</h4>${items.map(presetRow).join('')}</section>`); };
    addSection('Favorites', libraryUi.favorites.map(id => byId.get(id)).filter(Boolean));
    addSection('Recent', libraryUi.recent.map(id => byId.get(id)).filter(Boolean));
    ['Guitar', 'Bass', 'Keyboard', 'Drum', 'Custom', 'Other'].forEach(category => addSection(category, presets.filter(preset => presetCategory(preset) === category)));
    root.innerHTML = sections.join('') || '<small>一致する機材はありません。</small>';
    select.innerHTML = `<option value="">選択してください</option>${allPresets().map(preset => `<option value="${escapeHtml(preset.id)}" ${preset.id === activeCustomPresetId ? 'selected' : ''}>${escapeHtml(preset.name)} (${preset.origin === 'builtin' ? '内蔵' : 'カスタム'})</option>`).join('')}`;
    const current = activePreset();
    const hasActive = Boolean(current);
    $('#presetEditPanel').hidden = !presetEditMode;
    $('#presetEditToggle').setAttribute('aria-pressed', String(presetEditMode));
    if (document.activeElement !== $('#presetNameInput')) $('#presetNameInput').value = current?.name || '';
    if (document.activeElement !== $('#presetDescriptionInput')) $('#presetDescriptionInput').value = current?.description || '';
    $('#renamePreset').disabled = !hasActive;
    $('#updateCustomPreset').disabled = !hasActive;
    $('#deleteCustomPreset').disabled = !hasActive;
  }

  function setFlyoutOpen(open) {
    const flyout = $('#equipmentLibraryFlyout');
    const launcher = $('#equipmentLibraryLauncher');
    if (!flyout || !launcher) return;
    flyout.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
  }

  function placePreset(id) {
    const preset = allPresets().find(item => item.id === id);
    if (!preset || !instantiatePreset) return;
    const components = instantiatePreset(preset, { x: 280, y: 145 }, uid);
    if (!components.length) return;
    commit(() => state.objects.push(...components), { source: 'preset-placement' });
    recordRecentPreset(id);
    selectedIds = new Set(components.map(object => object.id));
    selected = components.at(-1).id;
    showHandles = true;
    render();
    setFlyoutOpen(false);
  }

  function createCustomPreset() {
    const objects = selectedObjects();
    if (!objects.length) { alert('プリセットに保存する図形を1個以上選択してください。'); return; }
    const name = presetEditMode ? $('#presetNameInput')?.value : prompt('新しいプリセット名');
    if (!String(name || '').trim() || !presetFromSelection) return;
    const preset = presetFromSelection(name, objects, $('#presetDescriptionInput')?.value || '');
    userPresets.push(preset);
    activeCustomPresetId = preset.id;
    savePresetLibrary();
    renderPresetLibrary();
  }

  function savePresetMetadata() {
    const preset = activePreset();
    const name = String($('#presetNameInput')?.value || '').trim();
    if (!preset || !name) return;
    const changes = { name, description: String($('#presetDescriptionInput')?.value || '') };
    if (preset.origin === 'builtin') presetLibraryState.overrides[preset.id] = { ...(presetLibraryState.overrides[preset.id] || {}), ...changes };
    else {
      const index = userPresets.findIndex(item => item.id === preset.id);
      if (index >= 0) userPresets[index] = { ...userPresets[index], ...changes, id: preset.id, updatedAt: new Date().toISOString() };
    }
    savePresetLibrary();
    renderPresetLibrary();
  }

  function updateCustomPreset() {
    const preset = activePreset();
    const objects = selectedObjects();
    if (!preset || !objects.length || !presetFromSelection) return;
    if (!confirm(`「${preset.name}」を現在の選択内容で上書きしますか？`)) return;
    const replacement = presetFromSelection(preset.name, objects, preset.description);
    replacement.id = preset.id;
    if (preset.origin === 'builtin') presetLibraryState.overrides[preset.id] = { ...(presetLibraryState.overrides[preset.id] || {}), components: replacement.components, updatedAt: replacement.updatedAt };
    else {
      const index = userPresets.findIndex(item => item.id === preset.id);
      if (index >= 0) userPresets[index] = replacement;
    }
    savePresetLibrary();
    renderPresetLibrary();
  }

  function deleteCustomPreset() {
    const preset = activePreset();
    if (!preset || !confirm(`「${preset.name}」を削除しますか？`)) return;
    if (preset.origin === 'builtin') presetLibraryState.tombstones = [...new Set([...(presetLibraryState.tombstones || []), preset.id])];
    else userPresets = userPresets.filter(item => item.id !== activeCustomPresetId);
    libraryUi.favorites = libraryUi.favorites.filter(id => id !== preset.id);
    libraryUi.recent = libraryUi.recent.filter(id => id !== preset.id);
    activeCustomPresetId = '';
    savePresetLibrary();
    saveLibraryUi();
    renderPresetLibrary();
  }

  function render(options = {}) {
    renderMetadata();
    renderStage();
    renderInspector();
    renderEquipment();
    renderAudio();
    renderOutputMode();
    renderSetlist();
    renderPrintSetlistPages();
    renderPresetLibrary();
    updateHistory();
    if (!options.skipFit) requestAnimationFrame(fitPage);
  }

  function updateHistory() {
    const count = $('#historyCount');
    if (count) count.textContent = undoStack.length;
    $('#undoBtn').disabled = !undoStack.length;
    $('#redoBtn').disabled = !redoStack.length;
  }

  function fitPage() {
    const viewport = $('#viewport');
    const page = $('#page');
    if (!viewport || !page) return;
    const mobileEditing = document.body.classList.contains('mobile-stage-edit');
    const scale = mobileEditing ? 0.72 : viewport.clientWidth / PAGE_W;
    page.style.transform = `scale(${scale})`;
    viewport.style.height = mobileEditing ? '100vh' : `${PAGE_H * scale}px`;
    if (mobileEditing) {
      page.style.width = `${PAGE_W}px`;
      page.style.height = '690px';
    } else {
      page.style.width = `${PAGE_W}px`;
      page.style.height = `${PAGE_H}px`;
    }
  }

  function logicalPoint(event) {
    const stage = $('.stage');
    const bounds = stage.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) * STAGE_W / bounds.width, 0, STAGE_W),
      y: clamp((event.clientY - bounds.top) * STAGE_H / bounds.height, 0, STAGE_H),
    };
  }

  function addObject(type) {
    const dimensions = { rect: [76, 40], circle: [64, 64], line: [110, 12], arrow: [110, 12], text: [88, 28], microphone: [38, 43], monitor: [56, 46], power: [46, 20] };
    const [width, height] = dimensions[type];
    const sequence = state.objects.length;
    const object = {
      id: uid(), type, x: 365 + (sequence % 4) * 24, y: 225 + (sequence % 3) * 20,
      width, height, rotation: 0, scale: 100, label: TYPE_LABELS[type], fontSize: defaultFontSize(type), category: 'unspecified', strokeWidth: 2,
      labelOffsetX: 0, labelOffsetY: 0, ratioLocked: ['line', 'arrow', 'text', 'microphone', 'monitor', 'power'].includes(type), geometrySized: false,
      groupId: '', locked: false, labelEdited: true, className: '', html: objectHtml(type),
    };
    commit(() => state.objects.push(object));
    selectOnly(object.id);
    render();
  }

  function unlockedSelection() {
    return selectedObjects().filter(object => !object.locked);
  }

  function clampMoveDelta(objects, dx, dy) {
    const box = boundsFor(objects);
    if (!box) return { dx: 0, dy: 0 };
    return {
      dx: clamp(dx, -box.left, STAGE_W - box.right),
      dy: clamp(dy, -box.top, STAGE_H - box.bottom),
    };
  }

  function moveObjects(objects, dx, dy, snap = false) {
    if (!objects.length) return;
    let next = clampMoveDelta(objects, dx, dy);
    if (snap && magnetEnabled) {
      const box = boundsFor(objects);
      const targetX = box.centerX + next.dx;
      const targetY = box.centerY + next.dy;
      const snapX = GRID_ORIGIN_X + Math.round((targetX - GRID_ORIGIN_X) / GRID_SPACING) * GRID_SPACING;
      const snapY = GRID_ORIGIN_Y + Math.round((targetY - GRID_ORIGIN_Y) / GRID_SPACING) * GRID_SPACING;
      if (Math.abs(snapX - targetX) <= SNAP_THRESHOLD) next.dx += snapX - targetX;
      if (Math.abs(snapY - targetY) <= SNAP_THRESHOLD) next.dy += snapY - targetY;
      next = clampMoveDelta(objects, next.dx, next.dy);
    }
    objects.forEach(object => { object.x += next.dx; object.y += next.dy; });
  }

  function rotateObjects(objects, degrees, absolute = false) {
    if (!objects.length) return;
    if (objects.length === 1) {
      objects[0].rotation = Math.round((absolute ? degrees : objects[0].rotation + degrees) * 10) / 10;
      return;
    }
    const box = boundsFor(objects);
    const delta = absolute ? degrees - (selectedObject()?.rotation || 0) : degrees;
    const radians = delta * Math.PI / 180;
    objects.forEach(object => {
      const centerX = object.x + object.width / 2;
      const centerY = object.y + object.height / 2;
      const x = centerX - box.centerX;
      const y = centerY - box.centerY;
      const nextX = x * Math.cos(radians) - y * Math.sin(radians);
      const nextY = x * Math.sin(radians) + y * Math.cos(radians);
      object.x = box.centerX + nextX - object.width / 2;
      object.y = box.centerY + nextY - object.height / 2;
      object.rotation = Math.round((object.rotation + delta) * 10) / 10;
    });
    const moved = clampMoveDelta(objects, 0, 0);
    objects.forEach(object => { object.x += moved.dx; object.y += moved.dy; });
  }

  function resizeObjectsTo(objects, targetWidth, targetHeight, ratioLocked = false) {
    if (!objects.length) return;
    const box = boundsFor(objects);
    let width = clamp(Number(targetWidth) || box.width, 6, STAGE_W);
    let height = clamp(Number(targetHeight) || box.height, 6, STAGE_H);
    if (ratioLocked) {
      const factor = Math.abs(width / box.width - 1) >= Math.abs(height / box.height - 1) ? width / box.width : height / box.height;
      width = clamp(box.width * factor, 6, STAGE_W);
      height = clamp(box.height * factor, 6, STAGE_H);
    }
    const sx = width / Math.max(1, box.width);
    const sy = height / Math.max(1, box.height);
    objects.forEach(object => {
      const centerX = object.x + object.width / 2;
      const centerY = object.y + object.height / 2;
      object.x = box.left + (centerX - box.left) * sx - object.width * sx / 2;
      object.y = box.top + (centerY - box.top) * sy - object.height * sy / 2;
      object.width = clamp(object.width * sx, 6, STAGE_W);
      object.height = clamp(object.height * sy, 6, STAGE_H);
      object.geometrySized = true;
    });
    const moved = clampMoveDelta(objects, 0, 0);
    objects.forEach(object => { object.x += moved.dx; object.y += moved.dy; });
  }

  function setSelectedGeometry(key, rawValue) {
    const objects = unlockedSelection();
    if (!objects.length) return;
    const value = Number(String(rawValue).replace(/[°%]/g, '').trim());
    if (!Number.isFinite(value)) return;
    commit(() => {
      const box = boundsFor(objects);
      if (key === 'x') moveObjects(objects, value - (objects.length > 1 ? box.left : objects[0].x), 0);
      else if (key === 'y') moveObjects(objects, 0, value - (objects.length > 1 ? box.top : objects[0].y));
      else if (key === 'width') resizeObjectsTo(objects, value, objects.length === 1 && objects[0].ratioLocked ? value / Math.max(1, box.width) * box.height : box.height, objects.length === 1 && objects[0].ratioLocked);
      else if (key === 'height') resizeObjectsTo(objects, objects.length === 1 && objects[0].ratioLocked ? value / Math.max(1, box.height) * box.width : box.width, value, objects.length === 1 && objects[0].ratioLocked);
    }, { source: `geometry-${key}` });
  }

  function setObjectField(key, rawValue) {
    const object = selectedObject();
    const objects = selectedObjects();
    if (!object) return;
    commit(() => {
      if (key === 'rotation') rotateObjects(unlockedSelection(), Number(String(rawValue).replace('°', '').trim()) || 0, true);
      else if (key === 'scale') {
        const editable = unlockedSelection();
        editable.forEach(item => { item.scale = clamp(Number(String(rawValue).replace('%', '').trim()) || 100, 30, 300); });
        const adjustment = clampMoveDelta(editable, 0, 0);
        editable.forEach(item => { item.x += adjustment.dx; item.y += adjustment.dy; });
      }
      else if (key === 'fontSize') unlockedSelection().forEach(item => { item.fontSize = clamp(Number(rawValue) || defaultFontSize(item.type), 8, 72); });
      else if (key === 'strokeWidth') unlockedSelection().filter(item => item.type !== 'text').forEach(item => { item.strokeWidth = Math.round(clamp(Number(rawValue) || 2, .5, 8) * 2) / 2; });
      else if (key === 'category') {
        const category = CATEGORY_LABELS[rawValue] ? rawValue : Object.entries(CATEGORY_LABELS).find(([, label]) => label === rawValue)?.[0] || 'unspecified';
        unlockedSelection().forEach(item => { item.category = category; item.html = syncObjectContent(item); });
      } else if (key === 'ratioLocked') unlockedSelection().forEach(item => { item.ratioLocked = Boolean(rawValue); });
      else if (key === 'labelOffsetX' || key === 'labelOffsetY') object[key] = clamp(Number(rawValue) || 0, key.endsWith('X') ? -STAGE_W : -STAGE_H, key.endsWith('X') ? STAGE_W : STAGE_H);
      else {
        object[key] = String(rawValue);
        object.labelEdited = true;
        object.html = syncObjectContent(object);
      }
    });
  }

  function selectionEntities(objects = selectedObjects()) {
    const seen = new Set();
    const entities = [];
    objects.forEach(object => {
      const key = object.groupId ? `group:${object.groupId}` : `object:${object.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      entities.push(object.groupId ? objects.filter(item => item.groupId === object.groupId) : [object]);
    });
    return entities;
  }

  function cloneSelection(offset = GRID_SPACING) {
    const objects = selectedObjects();
    if (!objects.length) return [];
    const groupMap = new Map();
    const clones = objects.map(object => {
      const copy = deep(object);
      copy.id = uid();
      copy.x += offset;
      copy.y += offset;
      if (copy.groupId) {
        if (!groupMap.has(copy.groupId)) groupMap.set(copy.groupId, uid());
        copy.groupId = groupMap.get(copy.groupId);
      }
      return copy;
    });
    const delta = clampMoveDelta(clones, 0, 0);
    clones.forEach(object => { object.x += delta.dx; object.y += delta.dy; });
    return clones;
  }

  function duplicateSelection(offset = GRID_SPACING) {
    const clones = cloneSelection(offset);
    if (!clones.length) return;
    commit(() => state.objects.push(...clones), { source: 'duplicate' });
    selectedIds = new Set(clones.map(object => object.id));
    selected = clones.at(-1).id;
    showHandles = true;
    render();
  }

  function deleteSelection() {
    const ids = new Set(unlockedSelection().map(object => object.id));
    if (!ids.size) return;
    commit(() => { state.objects = state.objects.filter(object => !ids.has(object.id)); }, { source: 'delete' });
    selectedIds = new Set([...selectedIds].filter(id => !ids.has(id)));
    selected = [...selectedIds].at(-1) || null;
    showHandles = Boolean(selected);
    render();
  }

  function groupSelection() {
    const objects = unlockedSelection();
    if (objects.length < 2) return;
    const groupId = uid();
    commit(() => objects.forEach(object => { object.groupId = groupId; }), { source: 'group' });
  }

  function toggleGroupSelection() {
    const entities = selectionEntities();
    if (entities.length === 1 && entities[0].some(object => object.groupId)) ungroupSelection();
    else groupSelection();
  }

  function ungroupSelection() {
    const objects = unlockedSelection().filter(object => object.groupId);
    if (!objects.length) return;
    const groups = new Set(objects.map(object => object.groupId));
    commit(() => state.objects.forEach(object => { if (groups.has(object.groupId)) object.groupId = ''; }), { source: 'ungroup' });
  }

  function toggleSelectionLock() {
    const objects = selectedObjects();
    if (!objects.length) return;
    const next = !objects.every(object => object.locked);
    commit(() => objects.forEach(object => { object.locked = next; }), { source: next ? 'lock' : 'unlock' });
  }

  function changeLayer(mode) {
    const ids = new Set(selectedIds);
    if (!ids.size) return;
    commit(() => {
      const selectedBlock = state.objects.filter(object => ids.has(object.id));
      const others = state.objects.filter(object => !ids.has(object.id));
      if (mode === 'front') state.objects = [...others, ...selectedBlock];
      else if (mode === 'back') state.objects = [...selectedBlock, ...others];
      else if (mode === 'forward') {
        for (let index = state.objects.length - 2; index >= 0; index -= 1) if (ids.has(state.objects[index].id) && !ids.has(state.objects[index + 1].id)) [state.objects[index], state.objects[index + 1]] = [state.objects[index + 1], state.objects[index]];
      } else if (mode === 'backward') {
        for (let index = 1; index < state.objects.length; index += 1) if (ids.has(state.objects[index].id) && !ids.has(state.objects[index - 1].id)) [state.objects[index], state.objects[index - 1]] = [state.objects[index - 1], state.objects[index]];
      }
    }, { source: `layer-${mode}` });
  }

  function alignSelection(mode) {
    const entities = selectionEntities();
    if (entities.length < 2) return;
    const boxes = entities.map(boundsFor);
    const keyIndex = entities.findIndex(entity => entity.some(object => object.id === keyObjectId));
    const anchor = keyIndex >= 0 ? boxes[keyIndex] : boundsFor(entities.flat());
    commit(() => entities.forEach((entity, index) => {
      if (index === keyIndex) return;
      const box = boxes[index];
      let dx = 0; let dy = 0;
      if (mode === 'left') dx = anchor.left - box.left;
      if (mode === 'center') dx = anchor.centerX - box.centerX;
      if (mode === 'right') dx = anchor.right - box.right;
      if (mode === 'top') dy = anchor.top - box.top;
      if (mode === 'middle') dy = anchor.centerY - box.centerY;
      if (mode === 'bottom') dy = anchor.bottom - box.bottom;
      moveObjects(entity.filter(object => !object.locked), dx, dy);
    }), { source: `align-${mode}` });
  }

  function distributeSelection(axis) {
    const entities = selectionEntities();
    if (entities.length < 3) return;
    const records = entities.map(entity => ({ entity, box: boundsFor(entity) })).sort((a, b) => axis === 'horizontal' ? a.box.centerX - b.box.centerX : a.box.centerY - b.box.centerY);
    const first = records[0].box;
    const last = records.at(-1).box;
    commit(() => records.slice(1, -1).forEach((record, index) => {
      const ratio = (index + 1) / (records.length - 1);
      const target = axis === 'horizontal' ? first.centerX + (last.centerX - first.centerX) * ratio : first.centerY + (last.centerY - first.centerY) * ratio;
      moveObjects(record.entity.filter(object => !object.locked), axis === 'horizontal' ? target - record.box.centerX : 0, axis === 'vertical' ? target - record.box.centerY : 0);
    }), { source: `distribute-${axis}` });
  }

  function centerEquidistance() {
    const entities = selectionEntities();
    if (entities.length !== 2) return;
    const keyIndex = Math.max(0, entities.findIndex(entity => entity.some(object => object.id === keyObjectId || object.id === selected)));
    const otherIndex = keyIndex === 0 ? 1 : 0;
    const keyBox = boundsFor(entities[keyIndex]);
    const otherBox = boundsFor(entities[otherIndex]);
    const keySide = Math.sign(keyBox.centerX - CENTER_X);
    const otherSide = Math.sign(otherBox.centerX - CENTER_X);
    if (!keySide || !otherSide || keySide === otherSide) {
      showEditorToast('中央線を挟んで左右に1つずつ選択してください');
      return;
    }
    const targetCenter = CENTER_X - (keyBox.centerX - CENTER_X);
    commit(() => moveObjects(entities[otherIndex].filter(object => !object.locked), targetCenter - otherBox.centerX, 0), { source: 'center-equidistance' });
  }

  function showEditorToast(message) {
    $('.editor-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'editor-toast editor-overlay';
    toast.textContent = message;
    $('.stage')?.append(toast);
    setTimeout(() => toast.remove(), 2400);
  }

  function mirrorObjects(objects) {
    objects.forEach(object => {
      const center = object.x + object.width / 2;
      object.x += 2 * (CENTER_X - center);
      object.rotation = -object.rotation;
      object.labelOffsetX = -object.labelOffsetX;
    });
  }

  function mirrorSelection(duplicate = false) {
    const objects = unlockedSelection();
    if (!objects.length) return;
    if (duplicate) {
      const clones = cloneSelection(0);
      mirrorObjects(clones);
      commit(() => state.objects.push(...clones), { source: 'mirror-duplicate' });
      selectedIds = new Set(clones.map(object => object.id));
      selected = clones.at(-1).id;
      render();
    } else commit(() => mirrorObjects(objects), { source: 'mirror' });
  }

  function runEditorAction(action) {
    if (action === 'duplicate') duplicateSelection();
    else if (action === 'delete') deleteSelection();
    else if (action === 'group' || action === 'group-toggle') toggleGroupSelection();
    else if (action === 'ungroup') ungroupSelection();
    else if (action === 'lock') toggleSelectionLock();
    else if (['front', 'forward', 'backward', 'back'].includes(action)) changeLayer(action);
    else if (action === 'align-menu' || action === 'distribute-menu') {
      const menu = action === 'align-menu' ? 'align' : 'distribute';
      openSelectionMenu = openSelectionMenu === menu ? '' : menu;
      renderStage();
      return;
    }
    else if (action.startsWith('align-')) alignSelection(action.slice(6));
    else if (action.startsWith('distribute-')) distributeSelection(action.slice(11));
    else if (action === 'center-equidistance') centerEquidistance();
    else if (action === 'mirror') mirrorSelection(false);
    else if (action === 'mirror-duplicate') mirrorSelection(true);
    else if (action === 'magnet') {
      magnetEnabled = !magnetEnabled;
      try { localStorage.setItem(EDITOR_UI_STORE, JSON.stringify({ magnetEnabled })); } catch (_) {}
      renderStage();
    }
    if (!action.endsWith('-menu')) openSelectionMenu = '';
    closeContextMenu();
  }

  function setSelectedStrokeWidth(rawValue) {
    const value = clamp(Number(rawValue), .5, 8);
    if (!Number.isFinite(value)) return;
    const ids = new Set(selectedObjects().filter(object => object.type !== 'text').map(object => object.id));
    if (!ids.size) return;
    commit(() => state.objects.forEach(object => { if (ids.has(object.id)) object.strokeWidth = Math.round(value * 2) / 2; }), { source: 'stroke-width' });
  }

  function pointerObjects() {
    const ids = new Set(pointerAction?.ids || []);
    return state.objects.filter(object => ids.has(object.id));
  }

  function restorePointerBase() {
    const byId = new Map((pointerAction?.baseObjects || []).map(object => [object.id, object]));
    state.objects.forEach(object => {
      const base = byId.get(object.id);
      if (base) Object.assign(object, deep(base));
    });
  }

  function snappedPointer(point) {
    if (!magnetEnabled) return point;
    const x = GRID_ORIGIN_X + Math.round((point.x - GRID_ORIGIN_X) / GRID_SPACING) * GRID_SPACING;
    const y = GRID_ORIGIN_Y + Math.round((point.y - GRID_ORIGIN_Y) / GRID_SPACING) * GRID_SPACING;
    return {
      x: Math.abs(x - point.x) <= SNAP_THRESHOLD ? x : point.x,
      y: Math.abs(y - point.y) <= SNAP_THRESHOLD ? y : point.y,
    };
  }

  function startPointerAction(event, object, mode) {
    const point = logicalPoint(event);
    let objects = selectedIds.has(object.id) ? unlockedSelection() : [object].filter(item => !item.locked);
    if (!objects.length) return;
    const box = boundsFor(objects);
    pointerAction = {
      mode,
      ids: objects.map(item => item.id),
      before: deep(state),
      baseObjects: deep(objects),
      start: point,
      box,
      center: { x: box.centerX, y: box.centerY },
      startAngle: Math.atan2(point.y - box.centerY, point.x - box.centerX) * 180 / Math.PI,
      moved: false,
      altPending: mode === 'move' && event.altKey,
      altCreated: false,
      clickToggleIds: event.shiftKey && mode === 'move' ? groupIdsFor(object) : null,
      keyOnClick: !event.shiftKey && !event.ctrlKey && !event.metaKey && mode === 'move' && selectionEntities().length > 1 && selectedIds.has(object.id) ? object.id : null,
    };
    $('.stage').setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function startMarquee(event) {
    pointerAction = {
      mode: 'marquee', before: null, start: logicalPoint(event), end: logicalPoint(event),
      selectionBefore: new Set(selectedIds), toggle: event.ctrlKey || event.metaKey, add: event.shiftKey, moved: false,
    };
    $('.stage').setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function renderMarquee() {
    const stage = $('.stage');
    $('.selection-marquee', stage)?.remove();
    if (pointerAction?.mode !== 'marquee' || !pointerAction.moved) return;
    const left = Math.min(pointerAction.start.x, pointerAction.end.x);
    const top = Math.min(pointerAction.start.y, pointerAction.end.y);
    const width = Math.abs(pointerAction.start.x - pointerAction.end.x);
    const height = Math.abs(pointerAction.start.y - pointerAction.end.y);
    const node = document.createElement('div');
    node.className = 'selection-marquee editor-overlay';
    node.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
    stage.append(node);
  }

  function materializeAltDuplicate() {
    const originals = pointerObjects();
    const groupMap = new Map();
    const clones = originals.map(object => {
      const copy = deep(object);
      copy.id = uid();
      if (copy.groupId) {
        if (!groupMap.has(copy.groupId)) groupMap.set(copy.groupId, uid());
        copy.groupId = groupMap.get(copy.groupId);
      }
      return copy;
    });
    state.objects.push(...clones);
    pointerAction.ids = clones.map(object => object.id);
    pointerAction.baseObjects = deep(clones);
    pointerAction.altCreated = true;
    selectedIds = new Set(pointerAction.ids);
    selected = pointerAction.ids.at(-1) || null;
  }

  function resizeSingleFromPointer(object, base, point, mode, keepRatio) {
    const direction = mode.replace('resize-', '');
    let dx = point.x - pointerAction.start.x;
    let dy = point.y - pointerAction.start.y;
    const east = direction.includes('e'); const west = direction.includes('w');
    const north = direction.includes('n'); const south = direction.includes('s');
    let width = clamp(base.width + (east ? dx : west ? -dx : 0), 6, STAGE_W);
    let height = clamp(base.height + (south ? dy : north ? -dy : 0), 6, STAGE_H);
    if (keepRatio && (east || west) && (north || south)) {
      const ratio = base.width / Math.max(1, base.height);
      if (Math.abs(width - base.width) >= Math.abs(height - base.height)) height = width / ratio;
      else width = height * ratio;
    }
    object.width = clamp(width, 6, STAGE_W);
    object.height = clamp(height, 6, STAGE_H);
    object.x = west ? base.x + base.width - object.width : base.x;
    object.y = north ? base.y + base.height - object.height : base.y;
    object.geometrySized = true;
    const adjustment = clampMoveDelta([object], 0, 0);
    object.x += adjustment.dx; object.y += adjustment.dy;
  }

  function updatePointerAction(event) {
    if (!pointerAction) return;
    let point = logicalPoint(event);
    if (pointerAction.mode === 'marquee') {
      pointerAction.end = point;
      pointerAction.moved ||= Math.hypot(point.x - pointerAction.start.x, point.y - pointerAction.start.y) > 2;
      renderMarquee();
      return;
    }
    const distance = Math.hypot(point.x - pointerAction.start.x, point.y - pointerAction.start.y);
    pointerAction.moved ||= distance > 2;
    if (pointerAction.altPending && pointerAction.moved && !pointerAction.altCreated) materializeAltDuplicate();
    restorePointerBase();
    let objects = pointerObjects();
    if (!objects.length) return;
    const mode = pointerAction.mode;
    if (mode === 'move') {
      let dx = point.x - pointerAction.start.x;
      let dy = point.y - pointerAction.start.y;
      if (event.shiftKey) Math.abs(dx) >= Math.abs(dy) ? dy = 0 : dx = 0;
      moveObjects(objects, dx, dy, true);
    } else if (mode === 'rotate' || mode === 'multi-rotate') {
      const angle = Math.atan2(point.y - pointerAction.center.y, point.x - pointerAction.center.x) * 180 / Math.PI;
      let delta = angle - pointerAction.startAngle;
      if (event.shiftKey) delta = Math.round(delta / 45) * 45;
      rotateObjects(objects, delta);
    } else if (mode.startsWith('multi-resize-')) {
      point = snappedPointer(point);
      const direction = mode.replace('multi-resize-', '');
      let width = pointerAction.box.width + (direction.includes('e') ? point.x - pointerAction.start.x : pointerAction.start.x - point.x);
      let height = pointerAction.box.height + (direction.includes('s') ? point.y - pointerAction.start.y : pointerAction.start.y - point.y);
      const keepRatio = event.shiftKey || objects.every(object => object.ratioLocked);
      resizeObjectsTo(objects, width, height, keepRatio);
    } else if (mode.startsWith('resize-')) {
      point = snappedPointer(point);
      resizeSingleFromPointer(objects[0], pointerAction.baseObjects[0], point, mode, event.shiftKey || objects[0].ratioLocked);
    }
    renderStage();
    renderInspector();
  }

  function finishMarquee() {
    const left = Math.min(pointerAction.start.x, pointerAction.end.x);
    const top = Math.min(pointerAction.start.y, pointerAction.end.y);
    const right = Math.max(pointerAction.start.x, pointerAction.end.x);
    const bottom = Math.max(pointerAction.start.y, pointerAction.end.y);
    if (!pointerAction.moved) {
      if (!pointerAction.add && !pointerAction.toggle) selectOnly(null);
      return;
    }
    const hits = state.objects.filter(object => {
      const box = effectiveBounds(object);
      return box.left >= left && box.right <= right && box.top >= top && box.bottom <= bottom;
    }).map(object => object.id);
    let next = pointerAction.add || pointerAction.toggle ? new Set(pointerAction.selectionBefore) : new Set();
    hits.forEach(id => {
      if (pointerAction.toggle && next.has(id)) next.delete(id);
      else next.add(id);
    });
    selectedIds = expandSelectionGroups(next);
    selected = [...selectedIds].at(-1) || null;
    keyObjectId = '';
    openSelectionMenu = '';
    showHandles = Boolean(selected);
  }

  function cancelPointerAction() {
    if (!pointerAction) return false;
    if (pointerAction.before) state = sanitise(pointerAction.before);
    pointerAction = null;
    render();
    return true;
  }

  function endPointerAction() {
    if (!pointerAction) return;
    if (pointerAction.mode === 'marquee') {
      finishMarquee();
      pointerAction = null;
      renderStage(); renderInspector({ hydrateSelection: true });
      return;
    }
    const action = pointerAction;
    const before = action.before;
    pointerAction = null;
    if (!action.moved && action.clickToggleIds?.length) {
      state = sanitise(before);
      const remove = action.clickToggleIds.every(id => selectedIds.has(id));
      action.clickToggleIds.forEach(id => remove ? selectedIds.delete(id) : selectedIds.add(id));
      selected = [...selectedIds].at(-1) || null;
      showHandles = Boolean(selected);
      renderStage(); renderInspector({ hydrateSelection: true });
      return;
    }
    if (!action.moved && action.keyOnClick) {
      state = sanitise(before);
      keyObjectId = action.keyOnClick;
      selected = action.keyOnClick;
      renderStage(); renderInspector({ hydrateSelection: true });
      return;
    }
    if (action.altPending && !action.altCreated) state = sanitise(before);
    else state = sanitise(state);
    if (JSON.stringify(before) !== JSON.stringify(state)) {
      remember(before);
      saveLocal();
      notifyChange(action.altCreated ? 'alt-drag-duplicate' : 'pointer');
    }
    render();
  }

  function enterMobileEdit() {
    if (innerWidth > 620 || document.body.classList.contains('mobile-stage-edit')) return false;
    document.body.classList.add('mobile-stage-edit');
    requestAnimationFrame(() => {
      fitPage();
      const viewport = $('#viewport');
      viewport.scrollLeft = 8;
      viewport.scrollTop = 32;
    });
    return true;
  }

  function exitMobileEdit() {
    document.body.classList.remove('mobile-stage-edit');
    fitPage();
  }

  function addEquipment(kind) {
    commit(() => state.equipment[kind].push({ id: uid(), source: 'manual', name: '', qty: '1', detail: '' }));
  }

  function reorderEquipment(kind, fromKey, toKey) {
    if (!EQUIPMENT_KINDS.includes(kind) || !fromKey || !toKey || fromKey === toKey) return;
    commit(() => {
      const order = equipmentOrderFor(state.equipment.order?.[kind], state.equipment[kind], state.objects, kind);
      const from = order.indexOf(fromKey);
      const to = order.indexOf(toKey);
      if (from < 0 || to < 0) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      state.equipment.order[kind] = order;
    }, { source: 'equipment-reorder' });
  }

  function bindEquipmentReorder(root, kind) {
    root.addEventListener('dragstart', event => {
      const row = event.target.closest('[data-equipment-key]');
      if (!row) return;
      draggedEquipment = { kind, key: row.dataset.equipmentKey };
      event.dataTransfer?.setData('text/plain', row.dataset.equipmentKey);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    root.addEventListener('dragover', event => event.preventDefault());
    root.addEventListener('drop', event => {
      event.preventDefault();
      const row = event.target.closest('[data-equipment-key]');
      if (draggedEquipment?.kind === kind && row) reorderEquipment(kind, draggedEquipment.key, row.dataset.equipmentKey);
      draggedEquipment = null;
    });
    root.addEventListener('dragend', () => { draggedEquipment = null; });
    root.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse') return;
      const handle = event.target.closest('.equipment-drag-handle');
      const row = handle?.closest('[data-equipment-key]');
      if (!handle || !row) return;
      equipmentPointerAction = { pointerId: event.pointerId, kind, fromKey: row.dataset.equipmentKey, toKey: row.dataset.equipmentKey, handle };
      try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
      event.preventDefault();
    });
    root.addEventListener('pointermove', event => {
      if (!equipmentPointerAction || equipmentPointerAction.pointerId !== event.pointerId) return;
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-equipment-key]');
      if (row?.dataset.equipmentKind === kind) equipmentPointerAction.toKey = row.dataset.equipmentKey;
      event.preventDefault();
    });
    const finishPointer = event => {
      if (!equipmentPointerAction || equipmentPointerAction.pointerId !== event.pointerId) return;
      const action = equipmentPointerAction;
      equipmentPointerAction = null;
      try { action.handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
      reorderEquipment(action.kind, action.fromKey, action.toKey);
    };
    root.addEventListener('pointerup', finishPointer);
    root.addEventListener('pointercancel', () => { equipmentPointerAction = null; });
  }

  function addSetlistRow() {
    const id = uid();
    commit(() => state.setlist.push({ id, setlistRowId: id, type: '曲', title: '', duration: '', audioRef: '音源なし', audioId: '', playbackMode: '音源なし', soundRequest: '', lightRequest: '', playbackCue: 'none', playbackCueCustom: '', playbackCueDetail: '' }));
  }

  function reorderSetlist(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    commit(() => {
      const from = state.setlist.findIndex(row => row.id === fromId);
      const to = state.setlist.findIndex(row => row.id === toId);
      if (from >= 0 && to >= 0) state.setlist.splice(to, 0, state.setlist.splice(from, 1)[0]);
    });
  }

  function releaseAudio(id) {
    const url = audioUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    audioUrls.delete(id);
  }

  async function playAudio(id) {
    const url = audioUrls.get(id);
    if (!url) return;
    if (!audioPlayer) {
      audioPlayer = new Audio();
      audioPlayer.hidden = true;
      audioPlayer.id = 'audio-preview';
      audioPlayer.addEventListener('playing', () => { audioPlaybackStarted = true; });
      document.body.append(audioPlayer);
    }
    audioPlaybackStarted = false;
    audioPlayer.dataset.audioId = id;
    audioPlayer.src = url;
    await audioPlayer.play();
  }

  function download(blob, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function saveJson() {
    download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), 'ara-tech-stage-plot.json');
  }

  function drawStageObject(context, object) {
    const scale = object.scale / 100;
    const width = object.width;
    const height = object.height;
    context.save();
    context.translate(object.x + width / 2, object.y + height / 2);
    context.rotate(object.rotation * Math.PI / 180);
    context.scale(scale, scale);
    const colors = {
      unspecified: { fill: '#fff', stroke: '#c9d1d8', text: '#263442' },
      brought: { fill: '#f9dfe1', stroke: '#c83b45', text: '#6f151a' },
      venue_borrow: { fill: '#fff', stroke: '#111', text: '#111' },
      rental: { fill: '#dff4fb', stroke: '#2382b8', text: '#07577f' },
    }[object.category] || { fill: '#fff', stroke: '#c9d1d8', text: '#263442' };
    const legacyStroke = object.type === 'microphone' ? 3 : 2;
    context.lineWidth = (Number.isFinite(object.strokeWidth) ? object.strokeWidth : legacyStroke) / Math.max(.01, scale);
    context.strokeStyle = colors.stroke;
    context.fillStyle = colors.fill;
    if (object.type === 'circle') { context.beginPath(); context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2); context.fill(); context.stroke(); }
    else if (object.type === 'line' || object.type === 'arrow') { context.beginPath(); context.moveTo(-width / 2, 0); context.lineTo(width / 2 - (object.type === 'arrow' ? 12 : 0), 0); context.stroke(); if (object.type === 'arrow') { context.fillStyle = colors.stroke; context.beginPath(); context.moveTo(width / 2, 0); context.lineTo(width / 2 - 14, -7); context.lineTo(width / 2 - 14, 7); context.closePath(); context.fill(); } }
    else if (object.type === 'microphone') { context.strokeStyle = colors.stroke; context.beginPath(); context.moveTo(0, -20); context.lineTo(0, 20); context.stroke(); context.fillStyle = '#fff'; context.beginPath(); context.arc(0, 1, 8, 0, Math.PI * 2); context.fill(); context.stroke(); context.beginPath(); context.moveTo(0, -12); context.lineTo(0, 13); context.stroke(); context.fillStyle = colors.stroke; context.beginPath(); context.moveTo(0, -27); context.lineTo(-7, -18); context.lineTo(7, -18); context.closePath(); context.fill(); }
    else if (object.type === 'monitor') { context.fillStyle = colors.fill; context.strokeStyle = colors.stroke; context.fillRect(-width / 2, -height / 2, width, height); context.strokeRect(-width / 2, -height / 2, width, height); context.fillStyle = colors.stroke; context.beginPath(); context.moveTo(-width / 2 + 3, -height / 2 + 3); context.lineTo(width / 2 - 3, -height / 2 + 3); context.lineTo(0, height / 4); context.closePath(); context.fill(); }
    else if (object.type !== 'text') { context.fillRect(-width / 2, -height / 2, width, height); context.strokeRect(-width / 2, -height / 2, width, height); }
    if (object.symbolKind === 'topview-equipment-split') {
      context.beginPath(); context.moveTo(-width / 2 + 4, 0); context.lineTo(width / 2 - 4, 0); context.stroke();
      context.fillStyle = colors.text;
      context.font = `900 ${object.fontSize}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(object.label, object.labelOffsetX / Math.max(.01, scale), -height / 4 + object.labelOffsetY / Math.max(.01, scale), Math.max(20, width - 6));
      context.fillText(object.splitLabel || '', object.labelOffsetX / Math.max(.01, scale), height / 4 + object.labelOffsetY / Math.max(.01, scale), Math.max(20, width - 6));
    } else if (!['line', 'arrow', 'microphone', 'monitor'].includes(object.type)) {
      context.fillStyle = colors.text;
      context.font = `900 ${object.fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(object.label, object.labelOffsetX / Math.max(.01, scale), object.labelOffsetY / Math.max(.01, scale), Math.max(30, width - 6));
    }
    context.restore();
  }

  function stageCanvas() {
    const ratio = 2;
    const canvas = document.createElement('canvas');
    canvas.width = STAGE_W * ratio;
    canvas.height = STAGE_H * ratio;
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, STAGE_W, STAGE_H);
    context.fillStyle = '#dbe7f0';
    for (let x = GRID_ORIGIN_X; x < STAGE_W; x += GRID_SPACING) for (let y = GRID_ORIGIN_Y; y < STAGE_H; y += GRID_SPACING) { context.beginPath(); context.arc(x, y, 1, 0, Math.PI * 2); context.fill(); }
    context.strokeStyle = '#111';
    context.lineWidth = 2;
    context.strokeRect(1, 1, STAGE_W - 2, STAGE_H - 2);
    context.setLineDash([2, 4]);
    context.strokeStyle = '#bbb';
    context.beginPath(); context.moveTo(CENTER_X, 0); context.lineTo(CENTER_X, STAGE_H); context.stroke();
    context.setLineDash([]);
    context.fillStyle = '#777';
    context.font = '800 9px sans-serif';
    context.textAlign = 'center'; context.fillText('ステージ奥 / UPSTAGE', CENTER_X, 13); context.fillText('▼ 客席 / AUDIENCE ▼', CENTER_X, STAGE_H - 6);
    context.textAlign = 'left'; context.fillText('下手', 5, STAGE_H / 2); context.textAlign = 'right'; context.fillText('上手', STAGE_W - 5, STAGE_H / 2);
    state.objects.forEach(object => drawStageObject(context, object));
    return canvas;
  }

  function exportPng() {
    stageCanvas().toBlob(blob => download(blob, 'ara-tech-stage-plot.png'), 'image/png');
  }

  function closeContextMenu() {
    const menu = $('#stageContextMenu');
    if (menu) menu.hidden = true;
    contextMenuOpen = false;
  }

  function openContextMenu(event) {
    const menu = $('#stageContextMenu');
    if (!menu) return;
    const objects = selectedObjects();
    const lock = $('[data-editor-action="lock"]', menu);
    if (lock) lock.textContent = objects.every(object => object.locked) ? 'Unlock' : 'Lock';
    menu.hidden = false;
    menu.style.left = `${clamp(event.clientX, 4, innerWidth - 180)}px`;
    menu.style.top = `${clamp(event.clientY, 4, innerHeight - 260)}px`;
    contextMenuOpen = true;
  }

  function isTextEditingTarget(target) {
    return Boolean(target?.closest?.('input,textarea,select,[contenteditable="true"]'));
  }

  function pasteClipboard() {
    if (!stageClipboard.length) return;
    const groupMap = new Map();
    const clones = stageClipboard.map(object => {
      const copy = deep(object);
      copy.id = uid(); copy.x += GRID_SPACING; copy.y += GRID_SPACING;
      if (copy.groupId) {
        if (!groupMap.has(copy.groupId)) groupMap.set(copy.groupId, uid());
        copy.groupId = groupMap.get(copy.groupId);
      }
      return copy;
    });
    const delta = clampMoveDelta(clones, 0, 0);
    clones.forEach(object => { object.x += delta.dx; object.y += delta.dy; });
    commit(() => state.objects.push(...clones), { source: 'paste' });
    selectedIds = new Set(clones.map(object => object.id)); selected = clones.at(-1).id; showHandles = true;
    stageClipboard = deep(clones);
    render();
  }

  function finishNudge() {
    if (!nudgeAction) return;
    const before = nudgeAction.before;
    nudgeAction = null;
    state = sanitise(state);
    if (JSON.stringify(before) !== JSON.stringify(state)) {
      remember(before); saveLocal(); notifyChange('nudge');
    }
    render();
  }

  function handleEditorKeydown(event) {
    if (event.key === 'Escape') {
      if (pointerAction) cancelPointerAction();
      else if (contextMenuOpen) closeContextMenu();
      else if ($('#equipmentLibraryFlyout')?.hidden === false) setFlyoutOpen(false);
      else if (selectedIds.size) { selectOnly(null); renderStage(); renderInspector({ hydrateSelection: true }); }
      return;
    }
    if (isTextEditingTarget(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (modifier && key === 'c') { if (selectedIds.size) { event.preventDefault(); stageClipboard = deep(selectedObjects()); } return; }
    if (modifier && key === 'v') { event.preventDefault(); pasteClipboard(); return; }
    if (modifier && key === 'd') { event.preventDefault(); duplicateSelection(); return; }
    if (modifier && key === 'g') { event.preventDefault(); event.shiftKey ? ungroupSelection() : groupSelection(); return; }
    if (modifier && (event.key === '[' || event.key === ']')) { event.preventDefault(); changeLayer(event.key === ']' ? (event.shiftKey ? 'front' : 'forward') : (event.shiftKey ? 'back' : 'backward')); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectedIds.size) {
      event.preventDefault();
      if (!nudgeAction) nudgeAction = { before: deep(state) };
      const distance = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
      const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
      moveObjects(unlockedSelection(), dx, dy);
      renderStage(); renderInspector();
    }
  }

  function handleEditorKeyup(event) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) finishNudge();
  }

  function createMenus() {
    const output = document.createElement('div');
    output.className = 'output-menu';
    output.innerHTML = '<div class="action-dialog"><strong>出力方法</strong><div class="btnrow"><button data-output="png" type="button">PNG出力</button><button class="primary" data-output="pdf" type="button">PDF印刷</button></div></div>';
    document.body.append(output);
    const json = document.createElement('div');
    json.className = 'json-menu';
    json.innerHTML = '<div class="action-dialog"><strong>JSON</strong><div class="btnrow"><button data-json="load" type="button">JSON読込</button><button class="primary" data-json="save" type="button">JSON保存</button></div><input id="jsonLoadInput" type="file" accept="application/json,.json" hidden></div>';
    document.body.append(json);
    const close = document.createElement('button');
    close.className = 'mobile-edit-close';
    close.type = 'button';
    close.textContent = '通常表示へ戻る';
    document.body.append(close);
    const context = document.createElement('div');
    context.id = 'stageContextMenu';
    context.className = 'stage-context-menu';
    context.hidden = true;
    context.innerHTML = '<button data-editor-action="duplicate" type="button">Duplicate</button><button data-editor-action="delete" type="button">Delete</button><button data-editor-action="lock" type="button">Lock</button><hr><button data-editor-action="forward" type="button">Bring Forward</button><button data-editor-action="backward" type="button">Send Backward</button><button data-editor-action="front" type="button">Bring Front</button><button data-editor-action="back" type="button">Send Back</button><hr><button data-editor-action="group" type="button">Group</button><button data-editor-action="ungroup" type="button">Ungroup</button><hr><button data-editor-action="align-left" type="button">Align Left</button><button data-editor-action="align-center" type="button">Align Center</button><button data-editor-action="align-right" type="button">Align Right</button><button data-editor-action="align-top" type="button">Align Top</button><button data-editor-action="align-middle" type="button">Align Middle</button><button data-editor-action="align-bottom" type="button">Align Bottom</button><button data-editor-action="distribute-horizontal" type="button">Distribute H</button><button data-editor-action="distribute-vertical" type="button">Distribute V</button><button data-editor-action="mirror" type="button">Mirror</button><button data-editor-action="mirror-duplicate" type="button">Mirror Duplicate</button>';
    document.body.append(context);
  }

  function bindInspector() {
    const parts = inspectorParts();
    parts.label?.addEventListener('change', event => setObjectField('label', event.target.value));
    parts.x?.addEventListener('change', event => setSelectedGeometry('x', event.target.value));
    parts.y?.addEventListener('change', event => setSelectedGeometry('y', event.target.value));
    parts.width?.addEventListener('change', event => setSelectedGeometry('width', event.target.value));
    parts.height?.addEventListener('change', event => setSelectedGeometry('height', event.target.value));
    parts.rotation?.addEventListener('change', event => setObjectField('rotation', event.target.value));
    parts.scale?.addEventListener('change', event => setObjectField('scale', event.target.value));
    parts.ratioLock?.addEventListener('change', event => setObjectField('ratioLocked', event.target.checked));
    parts.fontSize?.addEventListener('change', event => setObjectField('fontSize', event.target.value));
    parts.fontMinus?.addEventListener('click', () => setObjectField('fontSize', (selectedObject()?.fontSize || 16) - 1));
    parts.fontDefault?.addEventListener('click', () => setObjectField('fontSize', 16));
    parts.fontPlus?.addEventListener('click', () => setObjectField('fontSize', (selectedObject()?.fontSize || 16) + 1));
    parts.strokeWidth?.addEventListener('change', event => setSelectedStrokeWidth(event.target.value));
    parts.strokeMinus?.addEventListener('click', () => setSelectedStrokeWidth((Number(parts.strokeWidth.value) || 2) - .5));
    parts.strokePlus?.addEventListener('click', () => setSelectedStrokeWidth((Number(parts.strokeWidth.value) || 2) + .5));
    parts.category?.addEventListener('change', event => setObjectField('category', event.target.value));
    parts.swatches.forEach(swatch => swatch.addEventListener('click', () => setObjectField('category', swatch.dataset.objectCategory)));
    parts.minus?.addEventListener('click', () => setObjectField('rotation', (selectedObject()?.rotation || 0) - 15));
    parts.zero?.addEventListener('click', () => setObjectField('rotation', 0));
    parts.plus?.addEventListener('click', () => setObjectField('rotation', (selectedObject()?.rotation || 0) + 15));
    parts.scaleReset?.addEventListener('click', () => setObjectField('scale', 100));
    parts.labelOffsetX?.addEventListener('change', event => setObjectField('labelOffsetX', event.target.value));
    parts.labelOffsetY?.addEventListener('change', event => setObjectField('labelOffsetY', event.target.value));
    parts.labelOffsetReset?.addEventListener('click', () => commit(() => unlockedSelection().forEach(object => { object.labelOffsetX = 0; object.labelOffsetY = 0; }), { source: 'label-offset-reset' }));
    parts.actions.forEach(button => button.addEventListener('click', () => runEditorAction(button.dataset.editorAction)));
  }

  function bind() {
    $$('.tools .tool[data-tool]').forEach(tool => tool.addEventListener('click', () => addObject(tool.dataset.tool)));
    bindInspector();
    $$('.inspector-toggle').forEach(toggle => toggle.addEventListener('click', () => {
      const section = toggle.closest('.inspector-section');
      $$('.inspector-section').forEach(item => {
        const open = item === section && !item.classList.contains('open');
        item.classList.toggle('open', open);
        $('.inspector-toggle', item)?.setAttribute('aria-expanded', String(open));
        const panel = $('.inspector-panel', item);
        if (panel) {
          panel.hidden = !open;
          panel.toggleAttribute('inert', !open);
        }
      });
    }));
    $('#equipmentLibraryLauncher')?.addEventListener('click', event => {
      event.stopPropagation();
      setFlyoutOpen($('#equipmentLibraryFlyout')?.hidden !== false);
    });
    $('#equipmentLibraryClose')?.addEventListener('click', () => setFlyoutOpen(false));
    $('#equipmentLibrarySearch')?.addEventListener('input', renderPresetLibrary);
    $('#presetEditToggle')?.addEventListener('click', () => { presetEditMode = !presetEditMode; renderPresetLibrary(); });
    $('#customPresetSelect')?.addEventListener('change', event => {
      activeCustomPresetId = event.target.value;
      renderPresetLibrary();
    });
    $('#createCustomPreset')?.addEventListener('click', createCustomPreset);
    $('#renamePreset')?.addEventListener('click', savePresetMetadata);
    $('#updateCustomPreset')?.addEventListener('click', updateCustomPreset);
    $('#deleteCustomPreset')?.addEventListener('click', deleteCustomPreset);

    const metadataKeys = ['eventName', 'performerName', 'performanceOrder', 'performanceTime', 'allottedTime', 'eventDate'];
    $$('.meta-field input,.meta-field select').forEach((input, index) => input.addEventListener('change', () => commit(() => state.metadata[metadataKeys[index]] = metadataKeys[index] === 'performanceOrder' ? normalizePerformanceOrder(input.value) : input.value)));
    $('.notes textarea')?.addEventListener('change', event => commit(() => state.notes = event.target.value));
    $('.other-request textarea')?.addEventListener('change', event => commit(() => state.otherRequests = event.target.value));

    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#resetAllBtn').addEventListener('click', () => $('#resetConfirm').classList.add('open'));
    $('#cancelReset').addEventListener('click', () => $('#resetConfirm').classList.remove('open'));
    $('#confirmReset').addEventListener('click', () => { $('#resetConfirm').classList.remove('open'); replaceState(deep(initialState)); });
    $('#resetConfirm').addEventListener('click', event => { if (event.target.id === 'resetConfirm') $('#resetConfirm').classList.remove('open'); });
    $('#clearAllBtn')?.addEventListener('click', () => $('#clearAllConfirm').classList.add('open'));
    $('#cancelClearAll')?.addEventListener('click', () => $('#clearAllConfirm').classList.remove('open'));
    $('#confirmClearAll')?.addEventListener('click', () => {
      $('#clearAllConfirm').classList.remove('open');
      commit(() => { state.objects = []; }, { source: 'clear-all' });
      selectOnly(null); render();
    });
    $('#clearAllConfirm')?.addEventListener('click', event => { if (event.target.id === 'clearAllConfirm') $('#clearAllConfirm').classList.remove('open'); });

    const headerButtons = $$('.top-actions button');
    const jsonButton = headerButtons.find(button => button.textContent.trim() === 'JSON保存');
    const outputButton = headerButtons.find(button => button.textContent.includes('PDF / PNG'));
    jsonButton?.addEventListener('click', () => $('.json-menu').classList.add('open'));
    outputButton?.addEventListener('click', () => $('.output-menu').classList.add('open'));
    document.addEventListener('click', event => {
      const editorAction = event.target.closest('[data-editor-action]');
      if (editorAction && !editorAction.closest('.left .props')) { event.stopPropagation(); runEditorAction(editorAction.dataset.editorAction); return; }
      const favorite = event.target.closest('[data-favorite-preset]');
      if (favorite) { event.stopPropagation(); toggleFavoritePreset(favorite.dataset.favoritePreset); return; }
      const place = event.target.closest('[data-place-preset]');
      if (place) placePreset(place.dataset.placePreset);
      const editPreset = event.target.closest('[data-edit-preset]');
      if (editPreset) { activeCustomPresetId = editPreset.dataset.editPreset; renderPresetLibrary(); }
      const flyout = $('#equipmentLibraryFlyout');
      if (flyout && !flyout.hidden && !flyout.contains(event.target) && !event.target.closest('#equipmentLibraryLauncher')) setFlyoutOpen(false);
      if (event.target.matches('.output-menu,.json-menu')) event.target.classList.remove('open');
      if (event.target.dataset.output === 'png') { $('.output-menu').classList.remove('open'); exportPng(); }
      if (event.target.dataset.output === 'pdf') { $('.output-menu').classList.remove('open'); document.body.classList.remove('print-stage-only', 'print-setlist-only'); document.body.classList.add('print-adaptive-document'); requestAnimationFrame(() => window.print()); }
      if (event.target.dataset.json === 'save') { $('.json-menu').classList.remove('open'); saveJson(); }
      if (event.target.dataset.json === 'load') $('#jsonLoadInput').click();
      if (event.target.classList.contains('mobile-edit-close')) exitMobileEdit();
      const add = event.target.closest('.add-equip,.add-request');
      if (add) addEquipment(add.dataset.equipmentAdd || (add.classList.contains('add-equip') ? 'brought' : 'unspecified'));
      const remove = event.target.closest('[data-remove-eq]');
      if (remove) commit(() => {
        const rows = state.equipment[remove.dataset.removeEq];
        const index = rows.findIndex(item => item.id === remove.dataset.manualId);
        if (index >= 0) rows.splice(index, 1);
      });
      if (event.target.id === 'addSetRow') addSetlistRow();
      const deleteSet = event.target.closest('[data-delete-set]');
      if (deleteSet) commit(() => state.setlist.splice(Number(deleteSet.dataset.deleteSet), 1));
      const moveSet = event.target.closest('[data-move-set]');
      if (moveSet) commit(() => { const from = Number(moveSet.dataset.moveSet); const to = from + Number(moveSet.dataset.direction); if (to >= 0 && to < state.setlist.length) state.setlist.splice(to, 0, state.setlist.splice(from, 1)[0]); });
      const play = event.target.closest('[data-play-audio]');
      if (play) playAudio(play.dataset.playAudio).catch(() => {});
      if (contextMenuOpen && !event.target.closest('#stageContextMenu')) closeContextMenu();
    });
    document.addEventListener('keydown', handleEditorKeydown);
    document.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) finishNudge(); });

    $('#jsonLoadInput').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { try { replaceState(JSON.parse(reader.result)); $('.json-menu').classList.remove('open'); } catch (_) { alert('JSONファイルを読み込めませんでした。'); } };
      reader.readAsText(file);
      event.target.value = '';
    });

    $('#bulkAudioBtn').addEventListener('click', () => $('#bulkAudioInput').click());
    $('#bulkAudioInput').addEventListener('change', event => {
      const files = [...event.target.files];
      if (!files.length) return;
      const before = deep(state);
      files.forEach(file => {
        const id = uid();
        audioUrls.set(id, URL.createObjectURL(file));
        state.audio.push({ id, audioId: id, fileName: file.name, name: file.name, mimeType: file.type, type: file.type, size: file.size });
      });
      state = sanitise(state); remember(before); saveLocal(); render();
      notifyChange('audio');
      event.target.value = '';
    });
    $('#otherPlaybackBtn').addEventListener('click', () => alert('各セットリスト行でCD・本人再生・音源なし・その他を選択できます。'));

    document.addEventListener('change', event => {
      if (event.target.id === 'setlistOutputMode') commit(() => { state.setlistOutputMode = event.target.value; });
      const singleMixKeys = { singleMixAudio: 'audioRef', singleMixDuration: 'duration', singleMixCue: 'playbackCue', singleMixCueCustom: 'playbackCueCustom', singleMixCueDetail: 'playbackCueDetail', singleMixNote: 'note' };
      if (singleMixKeys[event.target.id]) commit(() => {
        const key = singleMixKeys[event.target.id];
        state.singleMix[key] = event.target.value;
        if (key === 'audioRef') {
          state.singleMix.audioId = event.target.value.startsWith('audio:') ? event.target.value.slice(6) : '';
          state.singleMix.playbackMode = state.singleMix.audioId ? 'file' : event.target.value;
        }
      });
      const equipment = event.target.closest('[data-eq]');
      if (equipment) commit(() => {
        const row = state.equipment[equipment.dataset.eq].find(item => item.id === equipment.dataset.manualId);
        if (row) row[equipment.dataset.key] = equipment.value;
      });
      const setInput = event.target.closest('[data-set-index]');
      if (setInput) commit(() => {
        const row = state.setlist[Number(setInput.dataset.setIndex)];
        const key = setInput.dataset.setKey;
        row[key] = setInput.value;
        if (key === 'audioRef') {
          row.audioId = setInput.value.startsWith('audio:') ? setInput.value.slice(6) : '';
          row.playbackMode = row.audioId ? 'file' : setInput.value;
        }
      });
    });
    window.addEventListener('afterprint', () => document.body.classList.remove('print-adaptive-document', 'print-stage-only', 'print-setlist-only'));

    const stage = $('.stage');
    stage.addEventListener('pointerdown', event => {
      if (enterMobileEdit()) return;
      if (event.button !== 0) return;
      if (event.target.closest('[data-editor-action],.selection-toolbar,.magnet-toggle')) return;
      const transform = event.target.closest('[data-transform]');
      if (transform?.dataset.transform?.startsWith('multi-')) {
        const object = selectedObject();
        if (object) startPointerAction(event, object, transform.dataset.transform);
        return;
      }
      const node = event.target.closest('.engine-object');
      if (!node) { startMarquee(event); return; }
      const object = state.objects.find(item => item.id === node.dataset.id);
      if (!object) return;
      if (event.ctrlKey || event.metaKey || (event.shiftKey && !selectedIds.has(object.id))) {
        keyObjectId = '';
        openSelectionMenu = '';
        const ids = groupIdsFor(object);
        const remove = ids.every(id => selectedIds.has(id));
        ids.forEach(id => remove ? selectedIds.delete(id) : selectedIds.add(id));
        selected = remove ? [...selectedIds].at(-1) || null : object.id;
        showHandles = Boolean(selected);
        renderStage();
        renderInspector({ hydrateSelection: true });
        event.preventDefault();
        return;
      }
      const groupIds = groupIdsFor(object);
      const retainSelection = groupIds.every(id => selectedIds.has(id));
      const selectionChanged = !retainSelection;
      if (!retainSelection) {
        keyObjectId = '';
        openSelectionMenu = '';
        selectedIds = new Set(groupIds);
        selected = object.id;
        showHandles = true;
      }
      const handle = event.target.closest('[data-transform]');
      const mode = handle?.dataset.transform || 'move';
      renderInspector({ hydrateSelection: selectionChanged });
      if (!handle) renderStage();
      if (!object.locked) startPointerAction(event, object, mode);
    });
    stage.addEventListener('contextmenu', event => {
      const node = event.target.closest('.engine-object');
      if (!node) return;
      event.preventDefault();
      const object = state.objects.find(item => item.id === node.dataset.id);
      if (!object) return;
      if (!selectedIds.has(object.id)) { selectedIds = new Set(groupIdsFor(object)); selected = object.id; showHandles = true; renderStage(); renderInspector({ hydrateSelection: true }); }
      openContextMenu(event);
    });
    window.addEventListener('pointermove', updatePointerAction);
    window.addEventListener('pointerup', endPointerAction);
    window.addEventListener('resize', fitPage);

    $('#setlistBody').addEventListener('dragstart', event => { draggedSetId = event.target.closest('[data-set-id]')?.dataset.setId || null; });
    $('#setlistBody').addEventListener('dragover', event => event.preventDefault());
    $('#setlistBody').addEventListener('drop', event => { event.preventDefault(); reorderSetlist(draggedSetId, event.target.closest('[data-set-id]')?.dataset.setId); draggedSetId = null; });
    EQUIPMENT_KINDS.forEach(kind => bindEquipmentReorder($(`#${EQUIPMENT_LIST_IDS[kind]}`), kind));
  }

  function exposeApi() {
    const api = {
      snapshot: () => deep(state),
      loadSnapshot: (value, options = {}) => replaceState(value, options.rememberPrevious ?? true, options.source || 'external'),
      exportPng,
      print: () => window.print(),
      stagePng: () => stageCanvas().toDataURL('image/png'),
      equipmentLayout: () => deep(equipmentLayout),
      equipmentRows: kind => EQUIPMENT_KINDS.includes(kind) ? deep(equipmentItems(kind)) : [],
      presets: () => deep(allPresets()),
      placePreset,
      selectedIds: () => [...selectedIds],
      selectIds: ids => {
        selectedIds = expandSelectionGroups(new Set((ids || []).map(String).filter(id => state.objects.some(object => object.id === id))));
        selected = [...selectedIds].at(-1) || null; keyObjectId = ''; openSelectionMenu = ''; showHandles = Boolean(selected); renderStage(); renderInspector({ hydrateSelection: true });
      },
      setKeyObject: id => { if (selectedIds.has(String(id || ''))) { keyObjectId = String(id); selected = keyObjectId; renderStage(); } },
      selectionBounds: () => deep(boundsFor(selectedObjects())),
      runAction: runEditorAction,
      setGeometry: setSelectedGeometry,
      setField: setObjectField,
      gridAuthority: () => ({ spacing: GRID_SPACING, originX: GRID_ORIGIN_X, originY: GRID_ORIGIN_Y, centerX: CENTER_X, threshold: SNAP_THRESHOLD }),
      editorUi: () => ({ magnetEnabled, contextMenuOpen, clipboardSize: stageClipboard.length, historyCount: undoStack.length, keyObjectId, openSelectionMenu, presetEditMode }),
      audioPlayback: () => audioPlayer ? { paused: audioPlayer.paused, currentTime: audioPlayer.currentTime, src: audioPlayer.currentSrc, started: audioPlaybackStarted } : null,
      enterMobileEdit,
      exitMobileEdit,
    };
    window.StagePlotEditor = api;
    window.__ARA_STAGE_PLOT_POC__ = api;
  }

  function start() {
    initialState = parseInitialState();
    initialState = sanitise(initialState);
    state = deep(initialState);
    createMenus();
    bind();
    renderStage();
    selectOnly(state.objects.find(object => object.label === 'Gt Head')?.id || null);
    renderInspector();
    renderMetadata();
    renderEquipment();
    renderAudio();
    renderSetlist();
    renderPrintSetlistPages();
    updateHistory();
    fitPage();
    new ResizeObserver(() => requestAnimationFrame(layoutEquipment)).observe($('.carry'));
    exposeApi();
    window.dispatchEvent(new CustomEvent('ara:stage-plot-ready'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

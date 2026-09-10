(() => {
  'use strict';

  const PAGE_W = 1200;
  const PAGE_H = 1390;
  const STAGE_W = 830;
  const STAGE_H = 500;
  const GRID_SPACING = 20;
  const CENTER_X = STAGE_W / 2;
  const GRID_ORIGIN_X = CENTER_X % GRID_SPACING;
  const HISTORY_LIMIT = 500;
  const STORE = 'ara-tech-stage-plot-canonical-v25';
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
  const CATEGORY_LABELS = { brought: '出演者持込', requested: '借用・手配希望', unspecified: '未指定' };
  const EQUIPMENT_KINDS = ['brought', 'requested'];
  const EQUIPMENT_OBJECT_TYPES = new Set(['rect', 'circle', 'microphone', 'monitor', 'power']);
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
  let draggedEquipment = null;
  let equipmentPointerAction = null;
  let draggedSetId = null;
  let audioPlayer = null;
  let audioPlaybackStarted = false;
  let equipmentLayout = { mode: 'normal', overflow: 0, carryVisible: 0, requestVisible: 0 };
  const presetStorage = createPresetStorage?.();
  let userPresets = presetStorage?.load?.() || [];
  let activeCustomPresetId = '';

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
    const metadataInputs = $$('.meta-field input');
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
        requested: $$('#requestList .request-row').map(row => ({ id: uid(), source: 'manual', name: $('input', row)?.value || '', qty: $('.qty', row)?.value || '', detail: '' })),
        order: { brought: [], requested: [] },
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
        category: CATEGORY_LABELS[item.category] ? item.category : 'unspecified',
        labelEdited: Boolean(item.labelEdited || !item.html),
        className: String(item.className || ''),
        html: String(item.html || ''),
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
    const requested = Array.isArray(source.equipment?.requested) ? source.equipment.requested.map(row) : [];
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
        requested,
        order: {
          brought: equipmentOrderFor(source.equipment?.order?.brought, brought, objects, 'brought'),
          requested: equipmentOrderFor(source.equipment?.order?.requested, requested, objects, 'requested'),
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
    if (object.symbolKind === 'topview-equipment-split') return `<div class="rect topview-symbol is-split"><span>${label}</span><span>${escapeHtml(object.splitLabel)}</span></div>`;
    if (object.symbolKind === 'topview-equipment') return `<div class="rect topview-symbol">${label}</div>`;
    if (object.symbolKind === 'drum-kick') return `<div class="rect topview-symbol is-kick">${label}</div>`;
    if (object.symbolKind === 'drum-pedal') return `<div class="rect topview-symbol is-pedal">${label}</div>`;
    if (object.symbolKind === 'cymbal') return `<div class="circle topview-symbol is-cymbal">${label}</div>`;
    if (object.symbolKind === 'drum-shell') return `<div class="circle topview-symbol is-drum-shell">${label}</div>`;
    return objectHtml(object.type, object.label);
  }

  function syncObjectContent(object) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = object.symbolKind ? objectMarkup(object) : (object.html || objectHtml(object.type, object.label));
    const labelNode = $('.rect,.circle,.power-mark,.engine-text', wrapper);
    if (labelNode && object.labelEdited && !object.symbolKind) labelNode.textContent = object.label;
    if (object.category === 'brought') $('.rect,.circle', wrapper)?.classList.add('borrow');
    else $('.rect,.circle', wrapper)?.classList.remove('borrow');
    return wrapper.innerHTML;
  }

  function objectNode(object) {
    const node = document.createElement('div');
    const isSelected = selectedIds.has(object.id);
    node.className = `obj engine-object ${object.className || ''} category-${object.category}${isSelected ? ' selected' : ''}${Number.isFinite(object.strokeWidth) ? ' has-custom-stroke' : ''}`.replace(/\s+/g, ' ').trim();
    node.dataset.id = object.id;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', object.label || TYPE_LABELS[object.type]);
    node.innerHTML = syncObjectContent(object);
    updateObjectNode(node, object);
    if (selected === object.id && showHandles) {
      node.insertAdjacentHTML('beforeend', '<button class="transform-handle rotate-handle" data-transform="rotate" type="button" aria-label="自由回転"></button><button class="transform-handle resize-handle nw" data-transform="resize" type="button" aria-label="左上からサイズ変更"></button><button class="transform-handle resize-handle ne" data-transform="resize" type="button" aria-label="右上からサイズ変更"></button><button class="transform-handle resize-handle se" data-transform="resize" type="button" aria-label="右下からサイズ変更"></button><button class="transform-handle resize-handle sw" data-transform="resize" type="button" aria-label="左下からサイズ変更"></button>');
    }
    return node;
  }

  function updateObjectNode(node, object) {
    node.style.left = `${object.x}px`;
    node.style.top = `${object.y}px`;
    if (object.symbolKind) {
      node.style.width = `${object.width}px`;
      node.style.height = `${object.height}px`;
    }
    node.style.transform = `rotate(${object.rotation}deg) scale(${object.scale / 100})`;
    node.style.transformOrigin = 'center';
    if (Number.isFinite(object.strokeWidth)) {
      const effectiveScale = Math.max(.01, object.scale / 100);
      node.style.setProperty('--object-stroke-width', `${object.strokeWidth / effectiveScale}px`);
      node.style.setProperty('--mic-stroke-width', `${object.strokeWidth * 160 / 38 / effectiveScale}px`);
      node.style.setProperty('--monitor-stroke-width', `${object.strokeWidth * 220 / 56 / effectiveScale}px`);
    } else node.style.removeProperty('--object-stroke-width');
    const labelNode = $('.rect,.circle,.power-mark,.engine-text', node);
    if (labelNode) labelNode.style.fontSize = `${object.fontSize / (object.scale / 100)}px`;
  }

  function renderStage() {
    const stage = $('.stage');
    $$('.stage > .obj').forEach(node => node.remove());
    const fragment = document.createDocumentFragment();
    state.objects.forEach(object => fragment.appendChild(objectNode(object)));
    stage.appendChild(fragment);
  }

  function selectedObject() {
    return state.objects.find(object => object.id === selected);
  }

  function selectedObjects() {
    return state.objects.filter(object => selectedIds.has(object.id));
  }

  function selectOnly(id) {
    selected = id || null;
    selectedIds = id ? new Set([id]) : new Set();
    showHandles = Boolean(id);
  }

  function inspectorParts() {
    const fields = $$('.left .props .field');
    const actionButtons = $$('.left .props > .btnrow button');
    const angleButtons = $$('button', fields[1]);
    const sizeButtons = $$('button', fields[2]);
    const fontButtons = $$('button', fields[3]);
    const strokeButtons = $$('button', fields[5]);
    return {
      title: $$('.left > .panel-title')[1],
      label: $('input', fields[0]),
      rotation: $('input', fields[1]),
      minus: angleButtons[0],
      zero: angleButtons[1],
      plus: angleButtons[2],
      scale: $('input', fields[2]),
      scaleReset: sizeButtons[0],
      fontSize: $('input', fields[3]),
      fontMinus: fontButtons[0],
      fontDefault: fontButtons[1],
      fontPlus: fontButtons[2],
      category: $('select', fields[4]),
      strokeWidth: $('input', fields[5]),
      strokeMinus: strokeButtons[0],
      strokePlus: strokeButtons[1],
      swatches: $$('.sw[data-object-category]', $('.left .props')),
      duplicate: actionButtons[0],
      remove: actionButtons[1],
    };
  }

  function renderInspector({ hydrateSelection = false } = {}) {
    const parts = inspectorParts();
    const object = selectedObject();
    const objects = selectedObjects();
    if (parts.title) parts.title.textContent = objects.length > 1 ? `選択中：${objects.length}個` : `選択中：${object?.label || '未選択'}`;
    [parts.label, parts.rotation, parts.scale, parts.fontSize, parts.category, ...parts.swatches, parts.minus, parts.zero, parts.plus, parts.scaleReset, parts.fontMinus, parts.fontDefault, parts.fontPlus, parts.duplicate, parts.remove].forEach(control => { if (control) control.disabled = !object; });
    const strokeObjects = objects.filter(item => item.type !== 'text');
    [parts.strokeWidth, parts.strokeMinus, parts.strokePlus].forEach(control => { if (control) control.disabled = !strokeObjects.length; });
    if (parts.strokeWidth) {
      const values = [...new Set(strokeObjects.map(item => Number.isFinite(item.strokeWidth) ? item.strokeWidth : (item.type === 'power' ? 1.5 : 2)))];
      parts.strokeWidth.placeholder = values.length > 1 ? '—' : '';
      parts.strokeWidth.value = values.length === 1 ? String(values[0]) : '';
    }
    if (!object) return;
    // A selection is a read-only projection boundary.  The browser does not
    // move focus away from the prior inspector input until after pointerdown,
    // so preserving that focused value here would leak it onto the new object.
    if (hydrateSelection || document.activeElement !== parts.label) parts.label.value = object.label;
    if (hydrateSelection || document.activeElement !== parts.rotation) parts.rotation.value = `${object.rotation}°`;
    if (hydrateSelection || document.activeElement !== parts.scale) parts.scale.value = `${Math.round(object.scale * 10) / 10}%`;
    if (hydrateSelection || document.activeElement !== parts.fontSize) parts.fontSize.value = `${object.fontSize}`;
    if (parts.fontDefault) parts.fontDefault.textContent = '16px';
    parts.category.value = CATEGORY_LABELS[object.category];
    parts.swatches.forEach(swatch => swatch.setAttribute('aria-pressed', String(swatch.dataset.objectCategory === object.category)));
  }

  function renderMetadata() {
    const values = [state.metadata.eventName, state.metadata.performerName, state.metadata.performanceOrder, state.metadata.performanceTime, state.metadata.allottedTime];
    const editorValues = [...values, state.metadata.eventDate];
    $$('.meta-field input').forEach((input, index) => { if (document.activeElement !== input) input.value = editorValues[index] || ''; });
    const artist = $('.page-title .artist');
    if (artist) artist.textContent = state.metadata.performerName || '出演者名';
    const center = $('.page-title .center');
    if (center) {
      center.textContent = '';
      center.append(document.createTextNode(state.metadata.eventName || 'イベント名'), document.createElement('br'));
      const detail = document.createElement('span');
      detail.style.cssText = 'font-size:16px;font-weight:700;letter-spacing:.03em';
      detail.textContent = `STAGE PLOT / 出演順 ${state.metadata.performanceOrder || '—'} / ${state.metadata.performanceTime || '—'}`;
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
      ['出演順', state.metadata.performanceOrder || '—'],
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
    row.className = kind === 'brought' ? 'equip-row borrowed' : 'request-row';
    row.draggable = true;
    row.dataset.equipmentKind = kind;
    row.dataset.equipmentKey = item.key;
    row.dataset.source = item.source;
    const manual = item.source === 'manual';
    row.innerHTML = `<div class="equipment-dragcell"><button class="draghandle equipment-drag-handle" type="button" title="ドラッグして並び替え" aria-label="ドラッグして並び替え">⠿</button></div><input ${manual ? `data-eq="${kind}" data-manual-id="${escapeHtml(item.id)}" data-key="name"` : 'readonly aria-readonly="true"'} value="${escapeHtml(item.name)}" placeholder="${kind === 'brought' ? '持込機材' : '借りたい・用意してほしい機材'}"><input class="qty" ${manual ? `data-eq="${kind}" data-manual-id="${escapeHtml(item.id)}" data-key="qty"` : 'readonly aria-readonly="true"'} value="${escapeHtml(item.qty)}"><button type="button" class="remove-equip" ${manual ? `data-remove-eq="${kind}" data-manual-id="${escapeHtml(item.id)}"` : 'disabled aria-hidden="true"'}>×</button>`;
    return row;
  }

  function renderEquipment() {
    for (const kind of EQUIPMENT_KINDS) {
      const root = kind === 'brought' ? $('#carryList') : $('#requestList');
      root.replaceChildren(...equipmentItems(kind).map(item => equipmentRow(item, kind)));
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
    const brought = equipmentItems('brought');
    const requested = equipmentItems('requested');
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
    const itemPageCount = Math.max(1, Math.ceil(brought.length / perColumn), Math.ceil(requested.length / perColumn));
    const pageCount = itemPageCount + Math.max(0, otherChunks.length - 1);
    const rows = items => `<table><tbody>${items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.qty)}</td></tr>`).join('')}</tbody></table>`;
    node.innerHTML = Array.from({ length: pageCount }, (_, pageIndex) => {
      const left = brought.slice(pageIndex * perColumn, (pageIndex + 1) * perColumn);
      const right = requested.slice(pageIndex * perColumn, (pageIndex + 1) * perColumn);
      const otherIndex = pageIndex - itemPageCount + 1;
      const otherChunk = otherIndex >= 0 ? otherChunks[otherIndex] : '';
      const equipmentSections = [
        left.length ? `<section class="equipment-panel is-carry"><h3>出演者持込</h3>${rows(left)}</section>` : '',
        right.length ? `<section class="equipment-panel"><h3>借りたい・用意してほしい機材</h3>${rows(right)}</section>` : '',
      ].filter(Boolean);
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
    const carryList = $('#carryList');
    const requestList = $('#requestList');
    if (!panel || !carryList || !requestList) return;
    const sections = $$('.carry > .equip-section');
    if (sections.length < 3) return;
    panel.classList.add('adaptive-equipment');
    ['density-normal', 'density-compact', 'density-dense'].forEach(name => panel.classList.remove(name));
    $$('.equipment-overflow-note', panel).forEach(node => node.remove());
    const carryRows = $$('.equip-row', carryList);
    const requestRows = $$('.request-row', requestList);
    [...carryRows, ...requestRows].forEach(row => { row.hidden = false; });
    const fixed = $('.carry-main-title', panel).offsetHeight
      + (panel.children[1]?.offsetHeight || 0)
      + $$('.equip-title', panel).reduce((sum, node) => sum + node.offsetHeight, 0);
    const otherText = String(state.otherRequests || '');
    const otherLines = Math.max(1, otherText.split(/\r?\n/u).length, Math.ceil(otherText.length / 38));
    const minimumOther = clamp(58 + otherLines * 13, 108, 250);
    const capacity = Math.max(0, Math.floor(panel.clientHeight - fixed - minimumOther - 4));
    const total = carryRows.length + requestRows.length;
    let mode = 'normal';
    let rowHeight = 38;
    if (total * rowHeight > capacity) { mode = 'compact'; rowHeight = 27; }
    if (total * rowHeight > capacity) { mode = 'dense'; rowHeight = 22; }
    const needsOverflow = total * rowHeight > capacity;
    const carryVisible = needsOverflow ? 0 : carryRows.length;
    const requestVisible = needsOverflow ? 0 : requestRows.length;
    const overflow = needsOverflow ? total : 0;
    carryRows.forEach(row => { row.hidden = needsOverflow; });
    requestRows.forEach(row => { row.hidden = needsOverflow; });
    panel.classList.toggle('equipment-deferred', needsOverflow);
    if (needsOverflow) {
      const note = document.createElement('div');
      note.className = 'equipment-overflow-note';
      note.textContent = '機材・手配リストは次ページに全件掲載';
      panel.append(note);
    }
    carryList.style.setProperty('--equipment-list-height', `${carryVisible * rowHeight}px`);
    requestList.style.setProperty('--equipment-list-height', `${requestVisible * rowHeight}px`);
    panel.classList.add(`density-${mode}`);
    equipmentLayout = { mode, rowHeight, capacity, overflow, carryVisible, requestVisible, otherHeight: sections[2].offsetHeight };
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
    return [...BUILT_IN_PRESETS, ...userPresets];
  }

  function renderPresetLibrary() {
    const root = $('#equipmentLibraryItems');
    const select = $('#customPresetSelect');
    if (!root || !select) return;
    const query = normalizedEquipmentLabel($('#equipmentLibrarySearch')?.value);
    const presets = allPresets().filter(preset => !query || normalizedEquipmentLabel([preset.name, ...(preset.searchAliases || [])].join(' ')).includes(query));
    root.innerHTML = presets.map(preset => `<div class="library-preset" data-preset-kind="${preset.kind}"><div><strong>${escapeHtml(preset.name)}</strong><small>${preset.kind === 'built-in' ? '内蔵・読取専用' : `${preset.components.length} components`}</small></div><button type="button" data-place-preset="${escapeHtml(preset.id)}">配置</button></div>`).join('') || '<small>一致する機材はありません。</small>';
    select.innerHTML = `<option value="">選択してください</option>${userPresets.map(preset => `<option value="${escapeHtml(preset.id)}" ${preset.id === activeCustomPresetId ? 'selected' : ''}>${escapeHtml(preset.name)}</option>`).join('')}`;
    const hasActive = userPresets.some(preset => preset.id === activeCustomPresetId);
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
    selectedIds = new Set(components.map(object => object.id));
    selected = components.at(-1).id;
    showHandles = true;
    render();
    setFlyoutOpen(false);
  }

  function createCustomPreset() {
    const objects = selectedObjects();
    if (!objects.length) { alert('プリセットに保存する図形を1個以上選択してください。'); return; }
    const name = prompt('新しいプリセット名');
    if (!String(name || '').trim() || !presetFromSelection) return;
    const preset = presetFromSelection(name, objects);
    userPresets.push(preset);
    activeCustomPresetId = preset.id;
    presetStorage?.save?.(userPresets);
    renderPresetLibrary();
  }

  function updateCustomPreset() {
    const index = userPresets.findIndex(preset => preset.id === activeCustomPresetId);
    const objects = selectedObjects();
    if (index < 0 || !objects.length || !presetFromSelection) return;
    if (!confirm(`「${userPresets[index].name}」を現在の選択内容で上書きしますか？`)) return;
    const replacement = presetFromSelection(userPresets[index].name, objects);
    replacement.id = userPresets[index].id;
    userPresets[index] = replacement;
    presetStorage?.save?.(userPresets);
    renderPresetLibrary();
  }

  function deleteCustomPreset() {
    const preset = userPresets.find(item => item.id === activeCustomPresetId);
    if (!preset || !confirm(`「${preset.name}」を削除しますか？`)) return;
    userPresets = userPresets.filter(item => item.id !== activeCustomPresetId);
    activeCustomPresetId = '';
    presetStorage?.save?.(userPresets);
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
      width, height, rotation: 0, scale: 100, label: TYPE_LABELS[type], fontSize: defaultFontSize(type), category: 'unspecified', strokeWidth: 2, labelEdited: true, className: '', html: objectHtml(type),
    };
    commit(() => state.objects.push(object));
    selectOnly(object.id);
    render();
  }

  function setObjectField(key, rawValue) {
    const object = selectedObject();
    if (!object) return;
    commit(() => {
      if (key === 'rotation') object.rotation = Number(String(rawValue).replace('°', '').trim()) || 0;
      else if (key === 'scale') object.scale = clamp(Number(String(rawValue).replace('%', '').trim()) || 100, 30, 300);
      else if (key === 'fontSize') object.fontSize = clamp(Number(rawValue) || defaultFontSize(object.type), 8, 72);
      else if (key === 'category') object.category = CATEGORY_LABELS[rawValue] ? rawValue : Object.entries(CATEGORY_LABELS).find(([, label]) => label === rawValue)?.[0] || 'unspecified';
      else {
        object[key] = String(rawValue);
        object.labelEdited = true;
        object.html = syncObjectContent(object);
      }
    });
  }

  function setSelectedStrokeWidth(rawValue) {
    const value = clamp(Number(rawValue), .5, 8);
    if (!Number.isFinite(value)) return;
    const ids = new Set(selectedObjects().filter(object => object.type !== 'text').map(object => object.id));
    if (!ids.size) return;
    commit(() => state.objects.forEach(object => { if (ids.has(object.id)) object.strokeWidth = Math.round(value * 2) / 2; }), { source: 'stroke-width' });
  }

  function startPointerAction(event, object, mode) {
    const point = logicalPoint(event);
    const center = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
    pointerAction = {
      mode,
      id: object.id,
      before: deep(state),
      start: point,
      x: object.x,
      y: object.y,
      rotation: object.rotation,
      scale: object.scale,
      center,
      startAngle: Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI,
      startDistance: Math.max(1, Math.hypot(point.x - center.x, point.y - center.y)),
    };
    $('.stage').setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function updatePointerAction(event) {
    if (!pointerAction) return;
    const object = state.objects.find(item => item.id === pointerAction.id);
    if (!object) return;
    const point = logicalPoint(event);
    if (pointerAction.mode === 'move') {
      const width = object.width * object.scale / 100;
      const height = object.height * object.scale / 100;
      object.x = clamp(pointerAction.x + point.x - pointerAction.start.x, 0, STAGE_W - Math.min(width, STAGE_W));
      object.y = clamp(pointerAction.y + point.y - pointerAction.start.y, 0, STAGE_H - Math.min(height, STAGE_H));
    } else if (pointerAction.mode === 'rotate') {
      const angle = Math.atan2(point.y - pointerAction.center.y, point.x - pointerAction.center.x) * 180 / Math.PI;
      object.rotation = Math.round((pointerAction.rotation + angle - pointerAction.startAngle) * 10) / 10;
    } else if (pointerAction.mode === 'resize') {
      const distance = Math.hypot(point.x - pointerAction.center.x, point.y - pointerAction.center.y);
      object.scale = Math.round(clamp(pointerAction.scale * distance / pointerAction.startDistance, 30, 300) * 10) / 10;
    }
    const node = $(`.engine-object[data-id="${CSS.escape(object.id)}"]`);
    if (node) updateObjectNode(node, object);
    renderInspector();
  }

  function endPointerAction() {
    if (!pointerAction) return;
    const before = pointerAction.before;
    pointerAction = null;
    state = sanitise(state);
    if (JSON.stringify(before) !== JSON.stringify(state)) {
      remember(before);
      saveLocal();
      notifyChange('pointer');
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
    const brought = object.category === 'brought';
    const legacyStroke = object.type === 'microphone' ? 3 : 2;
    context.lineWidth = (Number.isFinite(object.strokeWidth) ? object.strokeWidth : legacyStroke) / Math.max(.01, scale);
    context.strokeStyle = brought ? '#b84b51' : '#111';
    context.fillStyle = brought ? '#f3cfd2' : '#fff';
    if (object.type === 'circle') { context.beginPath(); context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2); context.fill(); context.stroke(); }
    else if (object.type === 'line' || object.type === 'arrow') { context.beginPath(); context.moveTo(-width / 2, 0); context.lineTo(width / 2 - (object.type === 'arrow' ? 12 : 0), 0); context.stroke(); if (object.type === 'arrow') { context.fillStyle = '#111'; context.beginPath(); context.moveTo(width / 2, 0); context.lineTo(width / 2 - 14, -7); context.lineTo(width / 2 - 14, 7); context.closePath(); context.fill(); } }
    else if (object.type === 'microphone') { context.strokeStyle = brought ? '#d71920' : '#111'; context.beginPath(); context.moveTo(0, -20); context.lineTo(0, 20); context.stroke(); context.fillStyle = '#fff'; context.beginPath(); context.arc(0, 1, 8, 0, Math.PI * 2); context.fill(); context.stroke(); context.beginPath(); context.moveTo(0, -12); context.lineTo(0, 13); context.stroke(); context.fillStyle = brought ? '#d71920' : '#111'; context.beginPath(); context.moveTo(0, -27); context.lineTo(-7, -18); context.lineTo(7, -18); context.closePath(); context.fill(); }
    else if (object.type === 'monitor') { context.fillStyle = brought ? '#f3cfd2' : '#fff'; context.strokeStyle = brought ? '#d71920' : '#111'; context.fillRect(-width / 2, -height / 2, width, height); context.strokeRect(-width / 2, -height / 2, width, height); context.fillStyle = brought ? '#d71920' : '#111'; context.beginPath(); context.moveTo(-width / 2 + 3, -height / 2 + 3); context.lineTo(width / 2 - 3, -height / 2 + 3); context.lineTo(0, height / 4); context.closePath(); context.fill(); }
    else if (object.type !== 'text') { context.fillRect(-width / 2, -height / 2, width, height); context.strokeRect(-width / 2, -height / 2, width, height); }
    if (object.symbolKind === 'topview-equipment-split') {
      context.beginPath(); context.moveTo(-width / 2 + 4, 0); context.lineTo(width / 2 - 4, 0); context.stroke();
      context.fillStyle = brought ? '#5f1013' : '#111';
      context.font = `900 ${object.fontSize}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(object.label, 0, -height / 4, Math.max(20, width - 6));
      context.fillText(object.splitLabel || '', 0, height / 4, Math.max(20, width - 6));
    } else if (!['line', 'arrow', 'microphone', 'monitor'].includes(object.type)) {
      context.fillStyle = brought ? '#5f1013' : '#111';
      context.font = `900 ${object.fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(object.label, 0, 0, Math.max(30, width - 6));
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
    for (let x = GRID_ORIGIN_X; x < STAGE_W; x += GRID_SPACING) for (let y = 20; y < STAGE_H; y += 20) { context.beginPath(); context.arc(x, y, 1, 0, Math.PI * 2); context.fill(); }
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
  }

  function bindInspector() {
    const parts = inspectorParts();
    parts.label?.addEventListener('change', event => setObjectField('label', event.target.value));
    parts.rotation?.addEventListener('change', event => setObjectField('rotation', event.target.value));
    parts.scale?.addEventListener('change', event => setObjectField('scale', event.target.value));
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
    parts.duplicate?.addEventListener('click', () => {
      const object = selectedObject();
      if (!object) return;
      const copy = deep(object);
      copy.id = uid(); copy.x += 18; copy.y += 18;
      commit(() => state.objects.push(copy));
      selectOnly(copy.id); render();
    });
    parts.remove?.addEventListener('click', () => {
      if (!selectedObject()) return;
      const ids = new Set(selectedIds);
      commit(() => state.objects = state.objects.filter(object => !ids.has(object.id)));
      selectOnly(null); render();
    });
  }

  function bind() {
    const tools = $$('.tools .tool');
    tools.forEach((tool, index) => {
      tool.dataset.tool = TOOLS[index];
      tool.setAttribute('role', 'button');
      tool.tabIndex = 0;
      tool.addEventListener('click', () => addObject(TOOLS[index]));
      tool.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); addObject(TOOLS[index]); } });
    });
    bindInspector();
    $('#equipmentLibraryLauncher')?.addEventListener('click', event => {
      event.stopPropagation();
      setFlyoutOpen($('#equipmentLibraryFlyout')?.hidden !== false);
    });
    $('#equipmentLibraryClose')?.addEventListener('click', () => setFlyoutOpen(false));
    $('#equipmentLibrarySearch')?.addEventListener('input', renderPresetLibrary);
    $('#customPresetSelect')?.addEventListener('change', event => {
      activeCustomPresetId = event.target.value;
      renderPresetLibrary();
    });
    $('#createCustomPreset')?.addEventListener('click', createCustomPreset);
    $('#updateCustomPreset')?.addEventListener('click', updateCustomPreset);
    $('#deleteCustomPreset')?.addEventListener('click', deleteCustomPreset);

    const metadataKeys = ['eventName', 'performerName', 'performanceOrder', 'performanceTime', 'allottedTime', 'eventDate'];
    $$('.meta-field input').forEach((input, index) => input.addEventListener('change', () => commit(() => state.metadata[metadataKeys[index]] = input.value)));
    $('.notes textarea')?.addEventListener('change', event => commit(() => state.notes = event.target.value));
    $('.other-request textarea')?.addEventListener('change', event => commit(() => state.otherRequests = event.target.value));

    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#resetAllBtn').addEventListener('click', () => $('#resetConfirm').classList.add('open'));
    $('#cancelReset').addEventListener('click', () => $('#resetConfirm').classList.remove('open'));
    $('#confirmReset').addEventListener('click', () => { $('#resetConfirm').classList.remove('open'); replaceState(deep(initialState)); });
    $('#resetConfirm').addEventListener('click', event => { if (event.target.id === 'resetConfirm') $('#resetConfirm').classList.remove('open'); });

    const headerButtons = $$('.top-actions button');
    const jsonButton = headerButtons.find(button => button.textContent.trim() === 'JSON保存');
    const outputButton = headerButtons.find(button => button.textContent.includes('PDF / PNG'));
    jsonButton?.addEventListener('click', () => $('.json-menu').classList.add('open'));
    outputButton?.addEventListener('click', () => $('.output-menu').classList.add('open'));
    document.addEventListener('click', event => {
      const place = event.target.closest('[data-place-preset]');
      if (place) placePreset(place.dataset.placePreset);
      const flyout = $('#equipmentLibraryFlyout');
      if (flyout && !flyout.hidden && !flyout.contains(event.target) && !event.target.closest('#equipmentLibraryLauncher')) setFlyoutOpen(false);
      if (event.target.matches('.output-menu,.json-menu')) event.target.classList.remove('open');
      if (event.target.dataset.output === 'png') { $('.output-menu').classList.remove('open'); exportPng(); }
      if (event.target.dataset.output === 'pdf') { $('.output-menu').classList.remove('open'); document.body.classList.remove('print-stage-only', 'print-setlist-only'); document.body.classList.add('print-adaptive-document'); requestAnimationFrame(() => window.print()); }
      if (event.target.dataset.json === 'save') { $('.json-menu').classList.remove('open'); saveJson(); }
      if (event.target.dataset.json === 'load') $('#jsonLoadInput').click();
      if (event.target.classList.contains('mobile-edit-close')) exitMobileEdit();
      const add = event.target.closest('.add-equip,.add-request');
      if (add) addEquipment(add.classList.contains('add-equip') ? 'brought' : 'requested');
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
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') setFlyoutOpen(false); });

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
      const node = event.target.closest('.engine-object');
      if (!node) { selectOnly(null); renderStage(); renderInspector(); return; }
      const object = state.objects.find(item => item.id === node.dataset.id);
      if (!object) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (selectedIds.has(object.id)) {
          selectedIds.delete(object.id);
          if (selected === object.id) selected = [...selectedIds].at(-1) || null;
        } else {
          selectedIds.add(object.id);
          selected = object.id;
        }
        showHandles = Boolean(selected);
        renderStage();
        renderInspector({ hydrateSelection: true });
        event.preventDefault();
        return;
      }
      const selectionChanged = selected !== object.id;
      selectOnly(object.id);
      const handle = event.target.closest('[data-transform]');
      const mode = handle?.dataset.transform || 'move';
      renderInspector({ hydrateSelection: selectionChanged });
      if (!handle) renderStage();
      startPointerAction(event, object, mode);
    });
    window.addEventListener('pointermove', updatePointerAction);
    window.addEventListener('pointerup', endPointerAction);
    window.addEventListener('resize', fitPage);

    $('#setlistBody').addEventListener('dragstart', event => { draggedSetId = event.target.closest('[data-set-id]')?.dataset.setId || null; });
    $('#setlistBody').addEventListener('dragover', event => event.preventDefault());
    $('#setlistBody').addEventListener('drop', event => { event.preventDefault(); reorderSetlist(draggedSetId, event.target.closest('[data-set-id]')?.dataset.setId); draggedSetId = null; });
    bindEquipmentReorder($('#carryList'), 'brought');
    bindEquipmentReorder($('#requestList'), 'requested');
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
      audioPlayback: () => audioPlayer ? { paused: audioPlayer.paused, currentTime: audioPlayer.currentTime, src: audioPlayer.currentSrc, started: audioPlaybackStarted } : null,
      enterMobileEdit,
      exitMobileEdit,
    };
    window.StagePlotEditor = api;
    window.__ARA_STAGE_PLOT_POC__ = api;
  }

  function start() {
    initialState = parseInitialState();
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

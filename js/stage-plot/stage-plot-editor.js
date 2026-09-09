(() => {
  'use strict';

  const PAGE_W = 1200;
  const PAGE_H = 1390;
  const STAGE_W = 830;
  const STAGE_H = 500;
  const HISTORY_LIMIT = 500;
  const STORE = 'ara-tech-stage-plot-canonical-v25';
  const TYPES = ['曲', 'SE', 'MC', 'BGM', 'End SE', 'その他'];
  const TOOLS = ['rect', 'circle', 'line', 'arrow', 'text', 'microphone', 'monitor', 'power'];
  const TYPE_LABELS = { rect: '四角形', circle: '円', line: '線', arrow: '矢印', text: 'テキスト', microphone: 'マイク', monitor: 'モニター', power: '100V' };
  const CATEGORY_LABELS = { brought: '出演者持込', requested: '借用・手配希望', unspecified: '未指定' };
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
  let showHandles = false;
  let undoStack = [];
  let redoStack = [];
  let pointerAction = null;
  let draggedSetId = null;
  let audioPlayer = null;
  let audioPlaybackStarted = false;
  let equipmentLayout = { mode: 'normal', overflow: 0, carryVisible: 0, requestVisible: 0 };

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
      schemaVersion: 1,
      version: 25,
      canvas: { width: STAGE_W, height: STAGE_H },
      metadata: {
        eventName: metadataInputs[0]?.value || '',
        performerName: metadataInputs[1]?.value || '',
        performanceOrder: metadataInputs[2]?.value || '',
        performanceTime: metadataInputs[3]?.value || '',
        allottedTime: metadataInputs[4]?.value || '',
      },
      objects,
      equipment: {
        brought: $$('#carryList .equip-row').map(row => ({ id: uid(), name: $('input', row)?.value || '', qty: $('.qty', row)?.value || '', detail: '' })),
        requested: $$('#requestList .request-row').map(row => ({ id: uid(), name: $('input', row)?.value || '', qty: $('.qty', row)?.value || '', detail: '' })),
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
        };
      }),
    };
  }

  function sanitise(raw) {
    const fallback = initialState || parseInitialState();
    const source = raw && typeof raw === 'object' ? raw : fallback;
    const metadata = { ...fallback.metadata, ...(source.metadata || {}) };
    const number = (value, fallbackValue, min, max) => Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallbackValue;
    const objects = Array.isArray(source.objects) ? source.objects.map(item => ({
      id: String(item.id || uid()),
      type: TOOLS.includes(item.type) ? item.type : 'rect',
      x: number(item.x, 350, 0, STAGE_W),
      y: number(item.y, 220, 0, STAGE_H),
      width: number(item.width, 76, 20, 420),
      height: number(item.height, 40, 18, 260),
      rotation: number(item.rotation, 0, -3600, 3600),
      scale: number(item.scale, 100, 30, 300),
      label: String(item.label ?? TYPE_LABELS[item.type] ?? ''),
      fontSize: number(item.fontSize, defaultFontSize(item.type), 8, 72),
      category: CATEGORY_LABELS[item.category] ? item.category : 'unspecified',
      labelEdited: Boolean(item.labelEdited || !item.html),
      className: String(item.className || ''),
      html: String(item.html || objectHtml(item.type, item.label)),
    })) : deep(fallback.objects);
    const row = item => ({ id: String(item.id || uid()), name: String(item.name || ''), qty: String(item.qty || ''), detail: String(item.detail || '') });
    const audio = item => {
      const id = String(item.audioId || item.id || uid());
      return { id, audioId: id, fileName: String(item.fileName || item.name || '音源'), name: String(item.name || item.fileName || '音源'), mimeType: String(item.mimeType || item.type || ''), type: String(item.type || item.mimeType || ''), size: Number(item.size || 0) };
    };
    const setRow = item => {
      const id = String(item.id || item.setlistRowId || uid());
      const audioRef = String(item.audioRef || item.playbackMode || '音源なし');
      const audioId = String(item.audioId || (audioRef.startsWith('audio:') ? audioRef.slice(6) : ''));
      return { id, setlistRowId: id, type: TYPES.includes(item.type) ? item.type : '曲', title: String(item.title || ''), duration: String(item.duration || ''), audioRef, audioId, playbackMode: String(item.playbackMode || (audioId ? 'file' : audioRef)), soundRequest: String(item.soundRequest || ''), lightRequest: String(item.lightRequest || '') };
    };
    return {
      schemaVersion: 1,
      version: 25,
      canvas: { width: STAGE_W, height: STAGE_H },
      metadata,
      objects,
      equipment: {
        brought: Array.isArray(source.equipment?.brought) ? source.equipment.brought.map(row) : [],
        requested: Array.isArray(source.equipment?.requested) ? source.equipment.requested.map(row) : [],
      },
      notes: String(source.notes || ''),
      otherRequests: String(source.otherRequests || ''),
      audio: Array.isArray(source.audio) ? source.audio.map(audio) : [],
      setlist: Array.isArray(source.setlist) ? source.setlist.map(setRow) : [],
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
    showHandles = false;
    render();
    notifyChange(source);
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(deep(state));
    state = sanitise(undoStack.pop());
    selected = null;
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

  function syncObjectContent(object) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = object.html || objectHtml(object.type, object.label);
    const labelNode = $('.rect,.circle,.power-mark,.engine-text', wrapper);
    if (labelNode && object.labelEdited) labelNode.textContent = object.label;
    if (object.category === 'brought') $('.rect,.circle', wrapper)?.classList.add('borrow');
    else $('.rect,.circle', wrapper)?.classList.remove('borrow');
    return wrapper.innerHTML;
  }

  function objectNode(object) {
    const node = document.createElement('div');
    node.className = `obj engine-object ${object.className || ''} category-${object.category}${selected === object.id && showHandles ? ' selected' : ''}`.replace(/\s+/g, ' ').trim();
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
    node.style.transform = `rotate(${object.rotation}deg) scale(${object.scale / 100})`;
    node.style.transformOrigin = 'center';
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

  function inspectorParts() {
    const fields = $$('.left .props .field');
    const actionButtons = $$('.left .props > .btnrow button');
    const angleButtons = $$('button', fields[1]);
    const sizeButtons = $$('button', fields[2]);
    const fontButtons = $$('button', fields[3]);
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
      duplicate: actionButtons[0],
      remove: actionButtons[1],
    };
  }

  function renderInspector() {
    const parts = inspectorParts();
    const object = selectedObject();
    if (parts.title) parts.title.textContent = `選択中：${object?.label || '未選択'}`;
    [parts.label, parts.rotation, parts.scale, parts.fontSize, parts.category, parts.minus, parts.zero, parts.plus, parts.scaleReset, parts.fontMinus, parts.fontDefault, parts.fontPlus, parts.duplicate, parts.remove].forEach(control => { if (control) control.disabled = !object; });
    if (!object) return;
    if (document.activeElement !== parts.label) parts.label.value = object.label;
    if (document.activeElement !== parts.rotation) parts.rotation.value = `${object.rotation}°`;
    if (document.activeElement !== parts.scale) parts.scale.value = `${Math.round(object.scale * 10) / 10}%`;
    if (document.activeElement !== parts.fontSize) parts.fontSize.value = `${object.fontSize}`;
    if (parts.fontDefault) parts.fontDefault.textContent = '16px';
    parts.category.value = CATEGORY_LABELS[object.category];
  }

  function renderMetadata() {
    const values = [state.metadata.eventName, state.metadata.performerName, state.metadata.performanceOrder, state.metadata.performanceTime, state.metadata.allottedTime];
    $$('.meta-field input').forEach((input, index) => { if (document.activeElement !== input) input.value = values[index] || ''; });
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

  function renderPrintSetlistPages() {
    let root = $('.print-setlist-pages');
    if (!root) {
      root = document.createElement('section');
      root.className = 'print-setlist-pages';
      $('.setlist')?.insertAdjacentElement('afterend', root);
    }
    const sourceRows = $$('#setlistBody .setlist-row');
    const chunkSize = 16;
    root.replaceChildren(...Array.from({ length: Math.max(1, Math.ceil(sourceRows.length / chunkSize)) }, (_, pageIndex) => {
      const article = document.createElement('article');
      article.className = 'print-setlist-page';
      article.innerHTML = printMetadataMarkup();
      const sheet = $('.setlist').cloneNode(false);
      sheet.classList.add('print-setlist-sheet');
      const head = $('.setlist-head').cloneNode(true);
      head.querySelectorAll('button, .summary').forEach(node => node.remove());
      head.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
      const header = $('.setlist-grid.header').cloneNode(true);
      const body = document.createElement('div');
      body.className = 'setlist-body';
      sourceRows.slice(pageIndex * chunkSize, (pageIndex + 1) * chunkSize).forEach(row => {
        const copy = row.cloneNode(true);
        copy.removeAttribute('draggable');
        copy.querySelectorAll('button, [id]').forEach(node => {
          if (node.tagName === 'BUTTON') node.remove();
          else node.removeAttribute('id');
        });
        body.append(copy);
      });
      sheet.append(head, header, body);
      if (pageIndex === Math.ceil(sourceRows.length / chunkSize) - 1) sheet.append($('.setlist-foot').cloneNode(true));
      article.append(sheet);
      return article;
    }));
  }

  function equipmentRow(item, kind, index) {
    const row = document.createElement('div');
    row.className = kind === 'brought' ? 'equip-row borrowed' : 'request-row';
    row.innerHTML = `<input data-eq="${kind}" data-index="${index}" data-key="name" value="${escapeHtml(item.name)}" placeholder="${kind === 'brought' ? '持込機材' : '借りたい・用意してほしい機材'}"><input class="qty" data-eq="${kind}" data-index="${index}" data-key="qty" value="${escapeHtml(item.qty)}"><button type="button" class="remove-equip" data-remove-eq="${kind}" data-index="${index}">×</button>`;
    return row;
  }

  function renderEquipment() {
    for (const kind of ['brought', 'requested']) {
      const root = kind === 'brought' ? $('#carryList') : $('#requestList');
      root.replaceChildren(...state.equipment[kind].map((item, index) => equipmentRow(item, kind, index)));
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
      node.className = 'equipment-continuation';
      $('.print-stage-page')?.insertAdjacentElement('afterend', node);
    }
    return node;
  }

  function renderEquipmentContinuation(carryStart, requestStart) {
    const carried = state.equipment.brought.slice(carryStart);
    const requested = state.equipment.requested.slice(requestStart);
    const node = continuationNode();
    const rows = (title, items) => items.length ? `<h3>${title}</h3><table><tbody>${items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.qty)}</td></tr>`).join('')}</tbody></table>` : '';
    node.innerHTML = carried.length || requested.length ? `${printMetadataMarkup()}<h2>機材・手配リスト 続き</h2>${rows('出演者持込', carried)}${rows('借りたい・用意してほしい機材', requested)}` : '';
    node.classList.toggle('has-overflow', Boolean(carried.length || requested.length));
  }

  function layoutEquipment() {
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
    const minimumOther = 108;
    const capacity = Math.max(0, Math.floor(panel.clientHeight - fixed - minimumOther - 4));
    const total = carryRows.length + requestRows.length;
    let mode = 'normal';
    let rowHeight = 38;
    if (total * rowHeight > capacity) { mode = 'compact'; rowHeight = 27; }
    if (total * rowHeight > capacity) { mode = 'dense'; rowHeight = 22; }
    const needsOverflow = total * rowHeight > capacity;
    const visibleCapacity = needsOverflow ? Math.max(0, Math.floor((capacity - 18) / rowHeight)) : total;
    let carryVisible = Math.min(carryRows.length, Math.round(visibleCapacity * (carryRows.length / Math.max(total, 1))));
    let requestVisible = Math.min(requestRows.length, visibleCapacity - carryVisible);
    const spare = visibleCapacity - carryVisible - requestVisible;
    if (spare > 0) {
      const carrySpare = carryRows.length - carryVisible;
      const fromCarry = Math.min(carrySpare, spare);
      carryVisible += fromCarry;
      requestVisible += spare - fromCarry;
    }
    const overflow = total - carryVisible - requestVisible;
    carryRows.forEach((row, index) => { row.hidden = index >= carryVisible; });
    requestRows.forEach((row, index) => { row.hidden = index >= requestVisible; });
    const carryOverflow = carryRows.length - carryVisible;
    const requestOverflow = requestRows.length - requestVisible;
    const noteTarget = requestOverflow ? requestList : carryOverflow ? carryList : null;
    if (noteTarget) {
      const note = document.createElement('div');
      note.className = 'equipment-overflow-note';
      note.textContent = `他 ${overflow} 件は機材・手配リスト 続きへ`;
      noteTarget.append(note);
    }
    carryList.style.setProperty('--equipment-list-height', `${carryVisible * rowHeight + (noteTarget === carryList ? 18 : 0)}px`);
    requestList.style.setProperty('--equipment-list-height', `${requestVisible * rowHeight + (noteTarget === requestList ? 18 : 0)}px`);
    panel.classList.add(`density-${mode}`);
    equipmentLayout = { mode, rowHeight, capacity, overflow, carryVisible, requestVisible, otherHeight: sections[2].offsetHeight };
    renderEquipmentContinuation(carryVisible, requestVisible);
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

  function setlistRow(row, index) {
    const linked = row.audioId && state.audio.find(item => (item.audioId || item.id) === row.audioId);
    const playable = linked && audioUrls.has(linked.audioId || linked.id);
    return `<div class="setlist-row ${row.type === '曲' ? 'song' : 'non-song'}" draggable="true" data-set-id="${escapeHtml(row.id)}">
      <div class="dragcell"><button class="draghandle" type="button" title="ドラッグして並び替え">⠿</button></div>
      <div class="no">${index + 1}</div>
      <div><select class="type-select" data-set-index="${index}" data-set-key="type">${TYPES.map(type => `<option ${row.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></div>
      <div><input data-set-index="${index}" data-set-key="title" value="${escapeHtml(row.title)}" placeholder="曲名・進行内容"></div>
      <div><input data-set-index="${index}" data-set-key="duration" value="${escapeHtml(row.duration)}" placeholder="0:00"></div>
      <div class="audio-cell"><select class="audio-method" data-set-index="${index}" data-set-key="audioRef">${audioOptions(row)}</select><div class="audio-file">${linked && playable ? `<button type="button" data-play-audio="${escapeHtml(linked.audioId || linked.id)}">▶</button><span class="filename done">ローカル再生可</span>` : linked ? '<span class="filename">ファイル未接続</span>' : `<span class="filename">${row.audioRef === '音源なし' ? '—' : escapeHtml(row.audioRef || '—')}</span>`}</div></div>
      <div><input data-set-index="${index}" data-set-key="soundRequest" value="${escapeHtml(row.soundRequest)}" placeholder="音響への要望"></div>
      <div><input data-set-index="${index}" data-set-key="lightRequest" value="${escapeHtml(row.lightRequest)}" placeholder="照明への要望"></div>
      <div class="rowops"><button class="up" data-move-set="${index}" data-direction="-1" type="button">↑</button><button class="down" data-move-set="${index}" data-direction="1" type="button">↓</button><button class="delete" data-delete-set="${index}" type="button">×</button></div>
    </div>`;
  }

  function renderSetlist() {
    $('#setlistBody').innerHTML = state.setlist.map(setlistRow).join('');
    const total = state.setlist.reduce((sum, row) => sum + parseDuration(row.duration), 0);
    const allotted = parseDuration(state.metadata.allottedTime);
    $('#totalTime').textContent = formatDuration(total);
    $('#setlistTotalBox').classList.toggle('over', Boolean(allotted && total > allotted));
    $('#setlistTotalBox').setAttribute('aria-label', allotted && total > allotted ? `合計時間 ${formatDuration(total)}。持ち時間を超えています` : `合計時間 ${formatDuration(total)}`);
  }

  function render(options = {}) {
    renderMetadata();
    renderStage();
    renderInspector();
    renderEquipment();
    renderAudio();
    renderSetlist();
    renderPrintSetlistPages();
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
      width, height, rotation: 0, scale: 100, label: TYPE_LABELS[type], fontSize: defaultFontSize(type), category: 'unspecified', labelEdited: true, className: '', html: objectHtml(type),
    };
    commit(() => state.objects.push(object));
    selected = object.id;
    showHandles = true;
    render();
  }

  function setObjectField(key, rawValue) {
    const object = selectedObject();
    if (!object) return;
    commit(() => {
      if (key === 'rotation') object.rotation = Number(String(rawValue).replace('°', '').trim()) || 0;
      else if (key === 'scale') object.scale = clamp(Number(String(rawValue).replace('%', '').trim()) || 100, 30, 300);
      else if (key === 'fontSize') object.fontSize = clamp(Number(rawValue) || defaultFontSize(object.type), 8, 72);
      else if (key === 'category') object.category = Object.entries(CATEGORY_LABELS).find(([, label]) => label === rawValue)?.[0] || 'unspecified';
      else {
        object[key] = String(rawValue);
        object.labelEdited = true;
        object.html = syncObjectContent(object);
      }
    });
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
    commit(() => state.equipment[kind].push({ id: uid(), name: '', qty: '1', detail: '' }));
  }

  function addSetlistRow() {
    const id = uid();
    commit(() => state.setlist.push({ id, setlistRowId: id, type: '曲', title: '', duration: '', audioRef: '音源なし', audioId: '', playbackMode: '音源なし', soundRequest: '', lightRequest: '' }));
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
    context.lineWidth = 2;
    context.strokeStyle = '#111';
    const brought = object.category === 'brought';
    context.fillStyle = brought ? '#f3cfd2' : '#fff';
    if (object.type === 'circle') { context.beginPath(); context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2); context.fill(); context.stroke(); }
    else if (object.type === 'line' || object.type === 'arrow') { context.beginPath(); context.moveTo(-width / 2, 0); context.lineTo(width / 2 - (object.type === 'arrow' ? 12 : 0), 0); context.stroke(); if (object.type === 'arrow') { context.fillStyle = '#111'; context.beginPath(); context.moveTo(width / 2, 0); context.lineTo(width / 2 - 14, -7); context.lineTo(width / 2 - 14, 7); context.closePath(); context.fill(); } }
    else if (object.type === 'microphone') { context.lineWidth = 3; context.beginPath(); context.moveTo(0, -20); context.lineTo(0, 20); context.stroke(); context.fillStyle = '#fff'; context.beginPath(); context.arc(0, 1, 8, 0, Math.PI * 2); context.fill(); context.stroke(); context.beginPath(); context.moveTo(0, -12); context.lineTo(0, 13); context.stroke(); context.fillStyle = '#111'; context.beginPath(); context.moveTo(0, -27); context.lineTo(-7, -18); context.lineTo(7, -18); context.closePath(); context.fill(); }
    else if (object.type === 'monitor') { context.fillStyle = '#fff'; context.fillRect(-width / 2, -height / 2, width, height); context.strokeRect(-width / 2, -height / 2, width, height); context.fillStyle = '#111'; context.beginPath(); context.moveTo(-width / 2 + 3, -height / 2 + 3); context.lineTo(width / 2 - 3, -height / 2 + 3); context.lineTo(0, height / 4); context.closePath(); context.fill(); }
    else if (object.type !== 'text') { context.fillRect(-width / 2, -height / 2, width, height); context.strokeRect(-width / 2, -height / 2, width, height); }
    if (!['line', 'arrow', 'microphone', 'monitor'].includes(object.type)) {
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
    for (let x = 20; x < STAGE_W; x += 20) for (let y = 20; y < STAGE_H; y += 20) { context.beginPath(); context.arc(x, y, 1, 0, Math.PI * 2); context.fill(); }
    context.strokeStyle = '#111';
    context.lineWidth = 2;
    context.strokeRect(1, 1, STAGE_W - 2, STAGE_H - 2);
    context.setLineDash([2, 4]);
    context.strokeStyle = '#bbb';
    context.beginPath(); context.moveTo(STAGE_W / 2, 0); context.lineTo(STAGE_W / 2, STAGE_H); context.stroke();
    context.setLineDash([]);
    context.fillStyle = '#777';
    context.font = '800 9px sans-serif';
    context.textAlign = 'center'; context.fillText('ステージ奥 / UPSTAGE', STAGE_W / 2, 13); context.fillText('▼ 客席 / AUDIENCE ▼', STAGE_W / 2, STAGE_H - 6);
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
    parts.category?.addEventListener('change', event => setObjectField('category', event.target.value));
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
      selected = copy.id; showHandles = true; render();
    });
    parts.remove?.addEventListener('click', () => {
      if (!selectedObject()) return;
      commit(() => state.objects = state.objects.filter(object => object.id !== selected));
      selected = null; showHandles = false; render();
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

    const metadataKeys = ['eventName', 'performerName', 'performanceOrder', 'performanceTime', 'allottedTime'];
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
      if (event.target.matches('.output-menu,.json-menu')) event.target.classList.remove('open');
      if (event.target.dataset.output === 'png') { $('.output-menu').classList.remove('open'); exportPng(); }
      if (event.target.dataset.output === 'pdf') { $('.output-menu').classList.remove('open'); window.print(); }
      if (event.target.dataset.json === 'save') { $('.json-menu').classList.remove('open'); saveJson(); }
      if (event.target.dataset.json === 'load') $('#jsonLoadInput').click();
      if (event.target.classList.contains('mobile-edit-close')) exitMobileEdit();
      const add = event.target.closest('.add-equip,.add-request');
      if (add) addEquipment(add.classList.contains('add-equip') ? 'brought' : 'requested');
      const remove = event.target.closest('[data-remove-eq]');
      if (remove) commit(() => state.equipment[remove.dataset.removeEq].splice(Number(remove.dataset.index), 1));
      if (event.target.id === 'addSetRow') addSetlistRow();
      const deleteSet = event.target.closest('[data-delete-set]');
      if (deleteSet) commit(() => state.setlist.splice(Number(deleteSet.dataset.deleteSet), 1));
      const moveSet = event.target.closest('[data-move-set]');
      if (moveSet) commit(() => { const from = Number(moveSet.dataset.moveSet); const to = from + Number(moveSet.dataset.direction); if (to >= 0 && to < state.setlist.length) state.setlist.splice(to, 0, state.setlist.splice(from, 1)[0]); });
      const play = event.target.closest('[data-play-audio]');
      if (play) playAudio(play.dataset.playAudio).catch(() => {});
    });

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
      const equipment = event.target.closest('[data-eq]');
      if (equipment) commit(() => state.equipment[equipment.dataset.eq][Number(equipment.dataset.index)][equipment.dataset.key] = equipment.value);
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

    const stage = $('.stage');
    stage.addEventListener('pointerdown', event => {
      if (enterMobileEdit()) return;
      const node = event.target.closest('.engine-object');
      if (!node) { selected = null; showHandles = false; renderStage(); renderInspector(); return; }
      const object = state.objects.find(item => item.id === node.dataset.id);
      if (!object) return;
      selected = object.id;
      showHandles = true;
      const handle = event.target.closest('[data-transform]');
      const mode = handle?.dataset.transform || 'move';
      renderInspector();
      if (!handle) renderStage();
      startPointerAction(event, object, mode);
    });
    window.addEventListener('pointermove', updatePointerAction);
    window.addEventListener('pointerup', endPointerAction);
    window.addEventListener('resize', fitPage);

    $('#setlistBody').addEventListener('dragstart', event => { draggedSetId = event.target.closest('[data-set-id]')?.dataset.setId || null; });
    $('#setlistBody').addEventListener('dragover', event => event.preventDefault());
    $('#setlistBody').addEventListener('drop', event => { event.preventDefault(); reorderSetlist(draggedSetId, event.target.closest('[data-set-id]')?.dataset.setId); draggedSetId = null; });
  }

  function exposeApi() {
    const api = {
      snapshot: () => deep(state),
      loadSnapshot: (value, options = {}) => replaceState(value, options.rememberPrevious ?? true, options.source || 'external'),
      exportPng,
      print: () => window.print(),
      stagePng: () => stageCanvas().toDataURL('image/png'),
      equipmentLayout: () => deep(equipmentLayout),
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
    selected = state.objects.find(object => object.label === 'Gt Head')?.id || null;
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

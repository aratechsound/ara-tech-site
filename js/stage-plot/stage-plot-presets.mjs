export const PHYSICAL_MM_TO_STAGE_PX = 0.12;
export const USER_PRESET_STORAGE_KEY = 'ara-tech-stage-plot-user-presets:v1';
export const USER_PRESET_SCHEMA_VERSION = 1;

const px = mm => mm * PHYSICAL_MM_TO_STAGE_PX;

function equipment({ key, name, label, widthMm, depthMm, source, aliases = [], symbolKind = 'topview-equipment', splitLabel = '' }) {
  return {
    id: `builtin:${key}`,
    kind: 'built-in',
    readOnly: true,
    name,
    searchAliases: aliases,
    components: [{
      type: 'rect', label, relativeX: 0, relativeY: 0,
      width: px(widthMm), height: px(depthMm), rotation: 0, scale: 100,
      fontSize: 10, category: 'unspecified', fillStyle: 'white', strokeWidth: 2,
      symbolKind, splitLabel, equipmentKey: key, equipmentModel: name,
      physicalWidthMm: widthMm, physicalDepthMm: depthMm,
      physicalDimensionSource: source, physicalDimensionVerified: true,
      zOffset: 0, labelEdited: true, className: '', html: '',
    }],
  };
}

const drumCircle = (label, inches, relativeX, relativeY, zOffset, symbolKind = 'drum-shell') => ({
  type: 'circle', label, relativeX, relativeY,
  width: px(inches * 25.4), height: px(inches * 25.4), rotation: 0, scale: 100,
  fontSize: 8.5, category: 'unspecified', fillStyle: 'white', strokeWidth: 2,
  symbolKind, equipmentFamily: 'Pearl VISION VLX', physicalWidthMm: inches * 25.4,
  physicalDepthMm: inches * 25.4, physicalDimensionSource: `${inches} inch nominal diameter`,
  physicalDimensionVerified: true, zOffset, labelEdited: true, className: '', html: '',
});

export const BUILT_IN_PRESETS = Object.freeze([
  equipment({ key: 'roland-jc-120', name: 'Roland JC-120', label: 'JC120', widthMm: 760, depthMm: 280, source: 'verified seed: Roland JC-120' }),
  equipment({ key: 'marshall-jcm900-4x12', name: 'Marshall JCM900 + 4x12', label: 'JCM900', splitLabel: '4x12', widthMm: 770, depthMm: 365, source: 'verified seed: Marshall 1960A cabinet outer footprint', symbolKind: 'topview-equipment-split' }),
  equipment({ key: 'ampeg-svt-810', name: 'SVT + 810', label: 'SVT', splitLabel: '810', widthMm: 660.4, depthMm: 406.4, source: 'verified seed: Ampeg SVT-810E cabinet outer footprint', symbolKind: 'topview-equipment-split' }),
  equipment({ key: 'roland-rd-300', name: 'Roland RD-300', label: 'RD300', widthMm: 1405, depthMm: 461, source: 'verified seed: Roland RD-300', aliases: ['RD3000'] }),
  {
    id: 'builtin:six-one-live-star-drum', kind: 'built-in', readOnly: true,
    name: 'SIX ONE Live STAR Drum', searchAliases: ['Pearl VISION VLX', 'ドラム'],
    components: [
      {
        type: 'rect', label: 'Kick 22×18', relativeX: 105, relativeY: 92,
        width: px(22 * 25.4), height: px(18 * 25.4), rotation: 0, scale: 100,
        fontSize: 8.5, category: 'unspecified', fillStyle: 'white', strokeWidth: 2,
        symbolKind: 'drum-kick', equipmentFamily: 'Pearl VISION VLX',
        physicalWidthMm: 22 * 25.4, physicalDepthMm: 18 * 25.4,
        physicalDimensionSource: 'SIX ONE public list 22 inch kick; 18 inch depth is model-family assumption',
        physicalDimensionVerified: false, dimensionStatus: 'provisional', zOffset: 0,
        labelEdited: true, className: '', html: '',
      },
      drumCircle('Tom 12"', 12, 104, 59, 1),
      drumCircle('Tom 13"', 13, 142, 57, 2),
      drumCircle('Floor 16"', 16, 184, 99, 3),
      drumCircle('Snare 14"', 14, 62, 112, 4),
      drumCircle('HH 14"', 14, 20, 103, 10, 'cymbal'),
      drumCircle('Crash 16"', 16, 42, 25, 11, 'cymbal'),
      drumCircle('Crash 18"', 18, 184, 21, 12, 'cymbal'),
      drumCircle('Ride 20"', 20, 213, 74, 13, 'cymbal'),
      {
        type: 'rect', label: 'Pedal', relativeX: 124, relativeY: 150,
        width: px(160), height: px(300), rotation: 0, scale: 100,
        fontSize: 7.5, category: 'brought', fillStyle: 'white', strokeWidth: 2,
        symbolKind: 'drum-pedal', equipmentFamily: 'SIX ONE Live STAR Drum',
        physicalWidthMm: 160, physicalDepthMm: 300,
        physicalDimensionSource: 'layout symbol provisional footprint', physicalDimensionVerified: false,
        dimensionStatus: 'provisional', zOffset: 20, labelEdited: true, className: '', html: '',
      },
    ],
  },
]);

export function presetFromSelection(name, selectedObjects) {
  if (!Array.isArray(selectedObjects) || selectedObjects.length < 1) throw new Error('preset_selection_required');
  const originX = Math.min(...selectedObjects.map(object => Number(object.x) || 0));
  const originY = Math.min(...selectedObjects.map(object => Number(object.y) || 0));
  return {
    id: `user:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`,
    kind: 'user', readOnly: false, schemaVersion: USER_PRESET_SCHEMA_VERSION,
    name: String(name || '').trim(), updatedAt: new Date().toISOString(),
    components: selectedObjects.map((object, zOffset) => {
      const copy = structuredClone(object);
      delete copy.id;
      delete copy.x;
      delete copy.y;
      return { ...copy, relativeX: (Number(object.x) || 0) - originX, relativeY: (Number(object.y) || 0) - originY, zOffset };
    }),
  };
}

export function instantiatePreset(preset, anchor, createId) {
  const x = Number(anchor?.x) || 0;
  const y = Number(anchor?.y) || 0;
  return [...(preset?.components || [])]
    .sort((a, b) => (Number(a.zOffset) || 0) - (Number(b.zOffset) || 0))
    .map(component => {
      const copy = structuredClone(component);
      delete copy.relativeX;
      delete copy.relativeY;
      delete copy.zOffset;
      return { ...copy, id: createId(), x: x + (Number(component.relativeX) || 0), y: y + (Number(component.relativeY) || 0) };
    });
}

export function createPresetStorage(storage = globalThis.localStorage) {
  return {
    load() {
      try {
        const payload = JSON.parse(storage?.getItem(USER_PRESET_STORAGE_KEY) || 'null');
        if (payload?.schemaVersion !== USER_PRESET_SCHEMA_VERSION || !Array.isArray(payload.presets)) return [];
        return payload.presets.filter(item => item?.kind === 'user' && Array.isArray(item.components));
      } catch (_) { return []; }
    },
    save(presets) {
      storage?.setItem(USER_PRESET_STORAGE_KEY, JSON.stringify({ schemaVersion: USER_PRESET_SCHEMA_VERSION, presets }));
    },
  };
}

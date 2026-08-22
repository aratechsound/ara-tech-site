export const eventTypes = Object.freeze([
    'ライブ・コンサート',
    'クラブ・DJイベント',
    '祭り・地域イベント',
    '企業・式典',
    '講演会・セミナー',
    'ダンス・舞台公演',
    '学校・文化イベント'
]);

export const serviceTypeLabels = Object.freeze({
    pa_sound: 'PA・音響',
    artist_pa_operation: 'アーティストPAオペレート',
    simple_lighting: '簡易照明',
    stage_lighting: 'ステージ照明',
    led_video: 'LEDビジョン・映像',
    temporary_stage_setup: '仮設ステージ設営',
    truss_setup: 'トラス設営',
    event_technical_production: 'イベント技術制作',
    system_design_construction: 'システム設計・施工'
});

export const serviceTypeCodes = Object.freeze(Object.keys(serviceTypeLabels));

export const isAllowedEventType = (value) => eventTypes.includes(String(value || '').trim());

export const normalizeServiceTypes = (values) => [...new Set(
    (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter((value) => Object.hasOwn(serviceTypeLabels, value))
)];

export const getServiceTypeLabels = (values) => normalizeServiceTypes(values)
    .map((value) => serviceTypeLabels[value]);

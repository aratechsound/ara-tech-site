export const workCategories = [
    'お祭り・地域イベント音響',
    'ライブ・アーティストPA',
    'DJイベント音響',
    'ステージ・照明',
    'ツアーPA',
    '音響設備・施工',
    '機材レンタル',
    'その他'
];

export const legacyWorkCategories = [
    'WORKS',
    'PA RENTAL',
    'STAGE PRODUCTION',
    'TOUR PA',
    'INSTALLATION'
];

export const servicePlanLabels = Object.freeze({
    compact_pa: 'Compact PA',
    standard_live: 'Standard LIVE',
    matsuri_pack: 'Matsuri Pack',
    school_festival_pack: 'School Festival Pack',
    pa_operator_only: 'PA Operator Only',
    large_scale: 'Large Scale',
    technical_advisor_training: 'Technical Advisor / Training',
    custom: 'その他・個別対応'
});

export const assignmentItemLabels = Object.freeze({
    sound_equipment: '音響機材一式',
    pa_operation: 'PAオペレート',
    load_in_setup_strike: '搬入・設営・撤去',
    simple_lighting: '簡易照明',
    lighting_operation: '照明オペレート',
    stage_production: 'ステージ制作',
    equipment_rental_only: '機材のみレンタル',
    sound_installation: '音響設備・施工',
    event_operation: '本番対応',
    other: 'その他'
});

const allowedCategories = new Set([...workCategories, ...legacyWorkCategories]);

export const isAllowedWorkCategory = (value) => allowedCategories.has(String(value || ''));

export const normalizeServicePlan = (value) => {
    const key = String(value || '').trim();
    return Object.hasOwn(servicePlanLabels, key) ? key : null;
};

export const getServicePlanLabel = (value) => servicePlanLabels[normalizeServicePlan(value)] || '';

export const normalizeAssignmentItems = (values) => [...new Set(
    (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter((value) => Object.hasOwn(assignmentItemLabels, value))
)];

export const getAssignmentItemLabels = (values) => normalizeAssignmentItems(values)
    .map((value) => assignmentItemLabels[value]);

const CASE_TYPES = Object.freeze({
 PA_EVENT: 'PA・イベント音響', AUDIO_INSTALL: '音響設備施工', AV_INSTALL: 'AV設備施工',
 LIGHTING_INSTALL: '照明設備施工', VIDEO_INSTALL: '映像設備施工', EQUIPMENT_RENTAL: '機材レンタル', OTHER: 'その他'
});
// Missing column means an unmigrated legacy deployment. NULL means unclassified.
const isPaCase = row => row && (!Object.hasOwn(row, 'case_type') || row.case_type === 'PA_EVENT');
const requirePaCase = row => { if (!isPaCase(row)) throw new Error('pa_only_operation'); };
module.exports = { CASE_TYPES, isPaCase, requirePaCase };

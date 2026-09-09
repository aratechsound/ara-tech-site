const { isUuid } = require("./_pa-mail.cjs");
const { rpc } = require("./_pa-portal.cjs");

const MAX_STATE_BYTES = 3 * 1024 * 1024;

const validateCaseId = (caseId) => {
    if (!isUuid(caseId)) throw new Error("invalid_inquiry");
};

const validatePlotId = (plotId) => {
    if (!isUuid(plotId)) throw new Error("invalid_stage_plot_id");
};

const validateState = (state) => {
    if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("invalid_stage_plot_state");
    if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1 || state.schemaVersion > 100000) throw new Error("invalid_stage_plot_state");
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) throw new Error("invalid_stage_plot_state");
    return state;
};

const create = ({ caseId, accessToken, state }, fetchImpl = fetch) => {
    validateCaseId(caseId);
    return rpc(accessToken, "pa_stage_plot_create", { p_case_id: caseId, p_state: validateState(state) }, fetchImpl);
};

const get = ({ caseId, plotId, accessToken }, fetchImpl = fetch) => {
    validateCaseId(caseId); validatePlotId(plotId);
    return rpc(accessToken, "pa_stage_plot_get", { p_case_id: caseId, p_stage_plot_id: plotId }, fetchImpl);
};

const list = ({ caseId, accessToken }, fetchImpl = fetch) => {
    validateCaseId(caseId);
    return rpc(accessToken, "pa_stage_plot_list", { p_case_id: caseId }, fetchImpl);
};

const save = ({ caseId, plotId, accessToken, state }, fetchImpl = fetch) => {
    validateCaseId(caseId); validatePlotId(plotId);
    return rpc(accessToken, "pa_stage_plot_save", { p_case_id: caseId, p_stage_plot_id: plotId, p_state: validateState(state) }, fetchImpl);
};

const revisionList = ({ caseId, plotId, accessToken }, fetchImpl = fetch) => {
    validateCaseId(caseId); validatePlotId(plotId);
    return rpc(accessToken, "pa_stage_plot_revision_list", { p_case_id: caseId, p_stage_plot_id: plotId }, fetchImpl);
};

const revisionGet = ({ caseId, plotId, revisionNo, accessToken }, fetchImpl = fetch) => {
    validateCaseId(caseId); validatePlotId(plotId);
    if (!Number.isInteger(revisionNo) || revisionNo < 1) throw new Error("invalid_stage_plot_revision");
    return rpc(accessToken, "pa_stage_plot_revision_get", { p_case_id: caseId, p_stage_plot_id: plotId, p_revision_no: revisionNo }, fetchImpl);
};

module.exports = { MAX_STATE_BYTES, create, get, list, revisionGet, revisionList, save, validateState };

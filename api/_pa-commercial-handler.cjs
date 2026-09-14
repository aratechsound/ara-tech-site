const { createService, SAFE } = require('./_pa-commercial.cjs');
const { verifyAdmin } = require('./_pa-mail.cjs');
const { streamAttachmentResponse } = require('./_pa-gmail.cjs');
const { applyOriginPolicy, checkRateLimit } = require('./_request-security.cjs');

const ACTIONS = new Set([
  'snapshot', 'document', 'confirmation_preview', 'confirmation_receipt_preview', 'begin_revision', 'issue_estimate', 'issue_confirmation', 'revoke_confirmation',
  'confirm_settlement', 'create_billing', 'record_payment', 'record_prepayment', 'adjust_payment',
  'close_case', 'reopen_case', 'dispatch_outbox', 'recovery_candidates', 'recovery_preview', 'recover_estimate',
  'correct_estimate', 'remind_confirmation', 'create_change_proposal', 'record_change_agreement', 'composer_preview'
]);

function createHandler({ service = createService(), admin = verifyAdmin, rate = checkRateLimit } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, data) => res.status(status).json(data);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(405, { ok: false, code: 'method_not_allowed' });
    }
    if (!applyOriginPolicy(req, res)) return json(403, { ok: false, code: 'invalid_origin' });
    try {
      const input = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(String(req.body || ''));
      if (!input || Array.isArray(input) || !ACTIONS.has(input.action) || Buffer.byteLength(JSON.stringify(input)) > 8_000_000) {
        throw Error('invalid_commercial_request');
      }
      const bearer = String(req.headers?.authorization || '').match(/^Bearer (\S+)$/u)?.[1];
      const actor = await admin(bearer);
      const limit = await rate({ request: req, policyName: 'PA_COMMERCIAL_ADMIN', scope: actor.id });
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfter || 60));
        return json(429, { ok: false, code: 'rate_limited' });
      }
      let result;
      switch (input.action) {
        case 'snapshot': result = await service.snapshot(input.case_id); break;
        case 'document': return streamAttachmentResponse(res, await service.document(input.case_id, input.document_id));
        case 'confirmation_preview': result = await service.confirmationPreview(input, actor); break;
        case 'confirmation_receipt_preview': return streamAttachmentResponse(res, await service.confirmationReceiptPreview(input, actor));
        case 'begin_revision': result = await service.beginRevision(input, actor); break;
        case 'issue_estimate': result = await service.issueEstimate(input, actor); break;
        case 'issue_confirmation': result = await service.issueConfirmation(input, actor); break;
        case 'revoke_confirmation': result = await service.revoke(input, actor); break;
        case 'confirm_settlement': result = await service.settle(input, actor); break;
        case 'create_billing': result = await service.createBilling(input, actor); break;
        case 'record_payment': result = await service.recordPayment(input, actor); break;
        case 'record_prepayment': result = await service.recordPrepayment(input, actor); break;
        case 'adjust_payment': result = await service.adjustPayment(input, actor); break;
        case 'close_case': result = await service.close(input, actor); break;
        case 'reopen_case': result = await service.reopen(input, actor); break;
        case 'dispatch_outbox': result = await service.dispatch(input, actor); break;
        case 'recovery_candidates': result = await service.recoveryCandidates(input.case_id); break;
        case 'recovery_preview': result = await service.recoveryPreview(input); break;
        case 'recover_estimate': result = await service.recoverEstimate(input, actor); break;
        case 'correct_estimate': result = await service.correctEstimate(input, actor); break;
        case 'remind_confirmation': result = await service.remindConfirmation(input, actor); break;
        case 'create_change_proposal': result = await service.createChangeProposal(input, actor); break;
        case 'record_change_agreement': result = await service.recordChangeAgreement(input, actor); break;
        case 'composer_preview': result = await service.composerPreview(input, actor); break;
      }
      return json(200, { ok: true, result });
    } catch (error) {
      const code = String(error?.message || '');
      const allowed = SAFE.has(code);
      return json(code === 'not_authorized' ? 401 : code === 'stale_confirmation_preview' ? 409 : allowed ? 400 : 503, { ok: false, code: allowed ? code : 'service_unavailable' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

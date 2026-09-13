const crypto = require('node:crypto');
const mail = require('./_pa-mail.cjs');
const gmail = require('./_pa-gmail.cjs');
const pdf = require('./_pa-contract-pdf.cjs');
const estimateAmount = require('./_pa-estimate-amount.cjs');

const SAFE = new Set([
  'not_authorized', 'case_unavailable', 'commercial_state_changed',
  'legacy_confirmation_reconciliation_required', 'post_contract_change_required',
  'delivery_outcome_unresolved', 'document_identity_mismatch', 'invalid_estimate',
  'estimate_delivery_not_confirmed', 'estimate_not_found', 'confirmation_already_active',
  'contract_already_accepted', 'invalid_contract', 'invalid_confirmation', 'accepted_contract_immutable',
  'revoke_reason_required', 'invalid_revision_start', 'outbox_not_found', 'outbox_busy',
  'outbox_unknown_requires_reconciliation', 'outbox_lease_changed', 'invalid_outbox_result',
  'mail_outcome_unknown',
  'invalid_settlement', 'settlement_not_ready', 'contract_not_found', 'invalid_billing',
  'invalid_billing_mail', 'due_date_evidence_required', 'invoice_document_not_allowed',
  'billing_not_open', 'invalid_payment', 'payment_not_found', 'invalid_payment_adjustment',
  'accepted_contract_required', 'billing_already_exists',
  'case_not_ready_to_close', 'invoice_not_sent', 'payment_balance_not_zero',
  'reopen_reason_required', 'mail_adapter_not_configured', 'fake_adapter_requires_local_db',
  'outbox_key_not_configured', 'outbox_secret_invalid', 'invalid_commercial_request',
  'invalid_reply_cc', 'invalid_estimate_recovery', 'amount_extraction_mismatch', 'idempotency_payload_mismatch',
  'estimate_correction_reason_required', 'estimate_not_recoverable', 'estimate_already_corrected',
  'invalid_confirmation_reminder', 'confirmation_not_remindable',
  'confirmation_reminder_secret_unavailable', 'invalid_change_proposal',
  'change_proposal_already_active', 'change_agreement_evidence_required',
  'change_proposal_not_found', 'change_already_agreed', 'change_not_agreeable',
  'change_proposal_not_sent', 'change_after_billing_not_allowed', 'unresolved_change_orders', 'settlement_amount_mismatch',
  'commercial_history_immutable'
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuid = (value) => {
  const result = String(value || '');
  if (!UUID.test(result)) throw Error('invalid_commercial_request');
  return result;
};
const object = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_commercial_request');
  return value;
};
const text = (value, max, optional = false) => {
  const result = String(value || '').trim();
  if ((!optional && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) {
    throw Error('invalid_commercial_request');
  }
  return result || null;
};
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw Error('invalid_commercial_request');
  return result;
};
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const fromBytea = (value) => {
  if (typeof value !== 'string' || !/^\\x[0-9a-f]+$/iu.test(value)) throw Error('document_identity_mismatch');
  return Buffer.from(value.slice(2), 'hex');
};
const isLocalUrl = (value) => {
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
};
const keyBytes = () => {
  const raw = String(process.env.PA_COMMERCIAL_OUTBOX_KEY || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/iu.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); } catch { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) throw Error('outbox_key_not_configured');
  return key;
};
const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
};
const decryptSecret = (envelope) => {
  try {
    const [version, iv, tag, body] = String(envelope || '').split('.');
    if (version !== 'v1') throw Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw Error('outbox_secret_invalid');
  }
};

function createService({ fetchImpl = fetch, sendTransport } = {}) {
  const db = async (path, options = {}) => {
    const { url, serviceRoleKey } = mail.supabaseConfig();
    const response = await fetchImpl(url + '/rest/v1/' + path, {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        authorization: 'Bearer ' + serviceRoleKey,
        'content-type': 'application/json',
        prefer: 'return=representation',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      let payload;
      try { payload = await response.json(); } catch {}
      const code = String(payload?.message || '');
      throw Error(SAFE.has(code) ? code : 'service_unavailable');
    }
    return response.status === 204 ? null : response.json();
  };
  const rpc = (name, input) => db('rpc/' + name, { method: 'POST', body: JSON.stringify(input) });
  const rows = (table, params) => db(table + '?' + new URLSearchParams(params));
  const one = async (table, params) => (await rows(table, { ...params, limit: '1' }))?.[0] || null;

  async function snapshot(caseId) {
    uuid(caseId);
    const inquiry = await mail.getInquiry(caseId, fetchImpl);
    const [state, estimates, documents, offers, tokens, contracts, outbox, billings, payments, adjustments, changeOrders, deliveryEvidence, importCorrections] = await Promise.all([
      one('pa_case_commercial_state', { inquiry_id: 'eq.' + caseId, select: '*' }),
      rows('pa_estimate_revisions', { inquiry_id: 'eq.' + caseId, select: '*', order: 'issued_at.desc', limit: '100' }),
      rows('pa_commercial_documents', { inquiry_id: 'eq.' + caseId, select: 'id,inquiry_id,document_kind,source_kind,gmail_message_id,gmail_attachment_id,original_filename,mime_type,sha256,metadata,created_at', order: 'created_at.desc', limit: '200' }),
      rows('pa_contract_offers', { inquiry_id: 'eq.' + caseId, select: 'id,version,issued_at,expires_at,snapshot,estimate_revision_id', order: 'version.desc', limit: '100' }),
      rows('pa_contract_tokens', { select: 'offer_id,state', limit: '200' }),
      rows('pa_contracts', { inquiry_id: 'eq.' + caseId, select: 'id,version,confirmed_at,snapshot', order: 'version.desc', limit: '100' }),
      rows('pa_commercial_outbox', { inquiry_id: 'eq.' + caseId, select: 'id,operation_id,job_kind,aggregate_id,state,recipient,subject,reply_binding,attachment_ids,provider_message_id,provider_thread_id,attempt_count,last_error_code,created_at,finished_at', order: 'created_at.desc', limit: '200' }),
      rows('pa_billings', { inquiry_id: 'eq.' + caseId, select: '*', order: 'billing_number.desc', limit: '100' }),
      rows('pa_payment_records', { inquiry_id: 'eq.' + caseId, select: '*', order: 'confirmed_at.desc', limit: '200' }),
      rows('pa_payment_adjustments', { inquiry_id: 'eq.' + caseId, select: '*', order: 'adjusted_at.desc', limit: '200' }),
      rows('pa_change_orders', { inquiry_id: 'eq.' + caseId, select: '*', order: 'created_at.desc', limit: '100' }),
      rows('pa_estimate_delivery_evidence', { inquiry_id: 'eq.' + caseId, select: '*', order: 'recorded_at.desc', limit: '200' }),
      rows('pa_estimate_import_corrections', { inquiry_id: 'eq.' + caseId, select: '*', order: 'recorded_at.desc', limit: '200' })
    ]);
    const contractIds = new Set(contracts.map((item) => item.id));
    return {
      case_status: inquiry.status,
      state: state || { inquiry_id: caseId, revision: 0, estimate_change_state: 'ready', fulfillment_state: 'not_confirmed', settlement_state: 'unsettled', unresolved_changes: false },
      estimates, documents, offers: offers.map((offer) => ({
        ...offer,
        state: contractIds.has(offer.id) ? 'accepted' : tokens.find((token) => token.offer_id === offer.id)?.state || 'unknown'
      })),
      outbox, billings, payments: payments.map((item) => ({ ...item, amount_minor: Number(item.amount) })), adjustments, change_orders: changeOrders,
      estimate_delivery_evidence: deliveryEvidence, estimate_import_corrections: importCorrections
    };
  }

  async function document(caseId, documentId) {
    await mail.getInquiry(uuid(caseId), fetchImpl);
    const item = await one('pa_commercial_documents', {
      id: 'eq.' + uuid(documentId), inquiry_id: 'eq.' + caseId,
      select: 'original_filename,mime_type,content,sha256'
    });
    if (!item) throw Error('document_identity_mismatch');
    const bytes = fromBytea(item.content);
    if (pdf.sha(bytes) !== item.sha256) throw Error('document_identity_mismatch');
    return { bytes, filename: item.original_filename, mime_type: item.mime_type };
  }

  async function mailPreview({ caseId, actor, body, attachments = [], replySource = null, ccAddresses = [] }) {
    return gmail.replyPreview({
      inquiryId: caseId,
      actorId: actor.id,
      body,
      attachments, ccAddresses,
      ...(replySource ? { replySourceMessageId: replySource.message_id, replySourceThreadId: replySource.thread_id } : {})
    }, fetchImpl);
  }
  const composerPreview = (input, actor) => mailPreview({
    caseId: uuid(input.case_id), actor, body: text(input.body, 20000),
    ccAddresses: Array.isArray(input.cc_addresses) ? input.cc_addresses : [], replySource: input.reply_source || null
  });
  const replyBinding = (preview) => ({
    thread_id: preview.gmail_thread_id,
    confirmation_token: preview.confirmation_token,
    reply_source_explicit: Boolean(preview.reply_source_explicit),
    reply_source_message_id: preview.reply_source_message_id || null,
    reply_source_thread_id: preview.gmail_thread_id,
    cc_addresses: preview.cc_addresses || []
  });

  async function issueEstimate(input, actor) {
    const bytes = Buffer.from(text(input.content_base64, 8000000), 'base64');
    await pdf.validatePdf(bytes, text(input.sha256, 64));
    const body = text(input.body, 20000);
    const attachment = {
      filename: text(input.filename, 500),
      mime_type: 'application/pdf',
      data: bytes.toString('base64url')
    };
    const operationId = uuid(input.operation_id);
    const priorJob = await one('pa_commercial_outbox', { operation_id: 'eq.' + operationId, select: '*'});
    if (priorJob) {
      const priorPreview = await mailPreview({ caseId: input.case_id, actor, body, attachments: [attachment], replySource: input.reply_source || null, ccAddresses: input.cc_addresses || [] });
      const priorEstimate = await one('pa_estimate_revisions', { id: 'eq.' + priorJob.aggregate_id, select: '*' });
      const priorDocument = priorEstimate ? await one('pa_commercial_documents', { id: 'eq.' + priorEstimate.document_id, select: 'id,original_filename,sha256' }) : null;
      if (priorJob.job_kind !== 'estimate' || !priorEstimate || !priorDocument || priorDocument.id !== input.document_id
        || priorDocument.original_filename !== attachment.filename || priorDocument.sha256 !== pdf.sha(bytes)
        || Number(priorEstimate.amount_minor) !== Number(input.amount_minor) || priorEstimate.currency !== (input.currency || 'JPY')
        || priorEstimate.tax_basis !== input.tax_basis || canonical(priorEstimate.conditions_snapshot) !== canonical(input.conditions)
        || priorEstimate.source_kind !== input.source_kind || priorJob.body_text !== priorPreview.body
        || priorJob.subject !== priorPreview.subject || priorJob.recipient !== priorPreview.recipient
        || canonical(priorJob.reply_binding?.cc_addresses || []) !== canonical(priorPreview.cc_addresses || [])) throw Error('idempotency_payload_mismatch');
      return { id: priorEstimate.id, revision_number: priorEstimate.revision_number, outbox_id: priorJob.id, already_committed: true };
    }
    let preview;
    if (input.source_kind === 'sent_recovery') {
      const source = await one('pa_gmail_message_index', {
        inquiry_id: 'eq.' + uuid(input.case_id),
        gmail_message_id: 'eq.' + text(input.gmail_message_id, 200),
        direction: 'eq.outbound',
        select: 'gmail_message_id,gmail_thread_id,sent_at,to_addresses,attachment_metadata'
      });
      if (!source || !source.attachment_metadata?.some((item) => item.id === input.gmail_attachment_id)) throw Error('invalid_estimate');
      preview = { recipient: source.to_addresses?.[0], subject: text(input.subject, 998), body, gmail_thread_id: source.gmail_thread_id, confirmation_token: 'sent-recovery-no-send' };
    } else {
      preview = await mailPreview({ caseId: input.case_id, actor, body, attachments: [attachment], replySource: input.reply_source || null, ccAddresses: input.cc_addresses || [] });
    }
    return rpc('pa_v5_issue_estimate', {
      p_actor: actor.id, p_case: uuid(input.case_id),
      p_expected_revision: integer(input.expected_revision), p_expected_current: input.expected_current ? uuid(input.expected_current) : null,
      p_operation: operationId, p_document_id: uuid(input.document_id),
      p_filename: attachment.filename, p_mime: attachment.mime_type, p_content_base64: bytes.toString('base64'),
      p_sha256: pdf.sha(bytes), p_amount_minor: integer(input.amount_minor, 1, 9999999999),
      p_currency: text(input.currency || 'JPY', 3), p_tax_basis: text(input.tax_basis, 20),
      p_conditions: object(input.conditions || {}), p_source_kind: text(input.source_kind, 30),
      p_source_sent_at: input.source_sent_at || null, p_recipient: preview.recipient,
      p_subject: preview.subject, p_body: preview.body,
      p_reply_binding: input.source_kind === 'sent_recovery' ? {} : replyBinding(preview)
    });
  }

  async function beginRevision(input, actor) {
    return rpc('pa_v5_begin_estimate_revision', {
      p_actor: actor.id, p_case: uuid(input.case_id), p_expected_revision: integer(input.expected_revision),
      p_operation: uuid(input.operation_id), p_reason: text(input.reason, 2000)
    });
  }

  async function issueConfirmation(input, actor) {
    const operationId = uuid(input.operation_id);
    const priorJob = await one('pa_commercial_outbox', { operation_id: 'eq.' + operationId, select: '*' });
    if (priorJob) {
      const priorOffer = await one('pa_contract_offers', { id: 'eq.' + priorJob.aggregate_id, select: '*' });
      const expectedBody = text(input.body_template, 20000);
      if (priorJob.job_kind !== 'confirmation' || !priorOffer || priorOffer.id !== input.offer_id
        || priorOffer.estimate_revision_id !== input.estimate_revision_id || priorJob.body_text !== expectedBody
        || priorOffer.snapshot?.event_name !== input.event_name || priorOffer.snapshot?.event_date !== input.event_date
        || canonical(priorOffer.snapshot?.customer_acknowledgement) !== canonical(input.customer_acknowledgement)) throw Error('idempotency_payload_mismatch');
      return { id: priorOffer.id, version: priorOffer.version, outbox_id: priorJob.id, already_committed: true, secret_url_returned_once: null };
    }
    const current = await snapshot(input.case_id);
    if (current.state.revision !== integer(input.expected_revision) || current.state.current_estimate_revision_id !== input.estimate_revision_id) {
      throw Error('commercial_state_changed');
    }
    const estimate = current.estimates.find((item) => item.id === input.estimate_revision_id);
    const document = current.documents.find((item) => item.id === estimate?.document_id);
    if (!estimate || !document) throw Error('estimate_not_found');
    const token = crypto.randomBytes(32).toString('hex');
    const origin = String(process.env.PA_PUBLIC_ORIGIN || 'https://ara-tech.cc').replace(/\/+$/u, '');
    const confirmationUrl = origin + '/pa-contract.html#' + token;
    const bodyTemplate = text(input.body_template, 20000);
    if (!bodyTemplate.includes('{{CONFIRMATION_URL}}')) throw Error('invalid_commercial_request');
    const body = bodyTemplate.replace('{{CONFIRMATION_URL}}', confirmationUrl);
    const preview = await mailPreview({ caseId: input.case_id, actor, body, replySource: input.reply_source || null, ccAddresses: input.cc_addresses || [] });
    const offerId = uuid(input.offer_id);
    const result = await rpc('pa_v5_issue_confirmation', {
      p_actor: actor.id, p_case: uuid(input.case_id), p_expected_revision: current.state.revision,
      p_estimate: uuid(estimate.id), p_offer: offerId, p_operation: operationId,
      p_token_hash: pdf.sha(token), p_secret_envelope: encryptSecret(confirmationUrl),
      p_snapshot: {
        event_name: text(input.event_name, 200), event_date: text(input.event_date, 10),
        recipient: preview.recipient, customer_acknowledgement: object(input.customer_acknowledgement),
        estimate_sha256: document.sha256, conditions: estimate.conditions_snapshot
      },
      p_recipient: preview.recipient, p_subject: preview.subject,
      p_body: bodyTemplate, p_reply_binding: replyBinding(preview)
    });
    return { ...result, secret_url_returned_once: confirmationUrl };
  }

  async function createBilling(input, actor) {
    const separate = input.invoice_policy === 'separate_pdf';
    const bytes = separate ? Buffer.from(text(input.content_base64, 8000000), 'base64') : null;
    if (bytes) await pdf.validatePdf(bytes, text(input.sha256, 64));
    const operationId = uuid(input.operation_id);
    const priorBilling = await one('pa_billings', { operation_id: 'eq.' + operationId, select: '*' });
    if (priorBilling) {
      const priorDocument = priorBilling.invoice_document_id ? await one('pa_commercial_documents', { id: 'eq.' + priorBilling.invoice_document_id, select: 'id,original_filename,sha256' }) : null;
      if (priorBilling.contract_id !== input.contract_id || priorBilling.estimate_revision_id !== input.estimate_revision_id
        || Number(priorBilling.amount_minor) !== Number(input.amount_minor) || priorBilling.invoice_policy !== input.invoice_policy
        || String(priorBilling.due_date || '') !== String(input.due_date || '') || canonical(priorBilling.due_basis) !== canonical(input.due_basis)
        || canonical(priorBilling.agreement_evidence) !== canonical(input.agreement_evidence)
        || (separate && (!priorDocument || priorDocument.id !== input.document_id || priorDocument.original_filename !== input.filename || priorDocument.sha256 !== pdf.sha(bytes)))) {
        throw Error('idempotency_payload_mismatch');
      }
      const priorJob = await one('pa_commercial_outbox', { operation_id: 'eq.' + operationId, select: 'id' });
      return { id: priorBilling.id, billing_number: priorBilling.billing_number, outbox_id: priorJob?.id || null, already_committed: true };
    }
    let preview = { recipient: null, subject: null, body: null, gmail_thread_id: null, confirmation_token: null };
    if (separate) {
      preview = await mailPreview({
        caseId: input.case_id, actor, body: text(input.body, 20000),
        attachments: [{ filename: text(input.filename, 500), mime_type: 'application/pdf', data: bytes.toString('base64url') }],
        replySource: input.reply_source || null, ccAddresses: input.cc_addresses || []
      });
    }
    return rpc('pa_v5_create_billing', {
      p_actor: actor.id, p_case: uuid(input.case_id), p_expected_revision: integer(input.expected_revision),
      p_operation: operationId, p_contract: uuid(input.contract_id), p_estimate: uuid(input.estimate_revision_id),
      p_amount_minor: integer(input.amount_minor, 0, 9999999999), p_policy: text(input.invoice_policy, 30),
      p_document_id: separate ? uuid(input.document_id) : null, p_filename: separate ? text(input.filename, 500) : null,
      p_content_base64: separate ? bytes.toString('base64') : null, p_sha256: separate ? pdf.sha(bytes) : null,
      p_due: input.due_date || null, p_due_basis: object(input.due_basis),
      p_customer_planned: input.customer_planned_payment_on || null, p_evidence: object(input.agreement_evidence),
      p_recipient: preview.recipient, p_subject: preview.subject, p_body: preview.body,
      p_reply_binding: separate ? replyBinding(preview) : {}
    });
  }

  async function recoveryCandidates(caseId) {
    uuid(caseId);
    await mail.getInquiry(caseId, fetchImpl);
    const messages = await rows('pa_gmail_message_index', {
      inquiry_id: 'eq.' + caseId, direction: 'eq.outbound',
      select: 'gmail_message_id,gmail_thread_id,message_source,subject,sent_at,indexed_at,to_addresses,attachment_metadata',
      order: 'sent_at.desc', limit: '100'
    });
    const evidence = await rows('pa_estimate_delivery_evidence', {
      inquiry_id: 'eq.' + caseId,
      select: 'estimate_revision_id,gmail_message_id,gmail_attachment_id,source_sent_at,recorded_at', limit: '200'
    });
    const managed = await gmail.managedReplyMetadata(caseId, fetchImpl);
    return messages.flatMap((message) => (message.attachment_metadata || [])
      .filter((item) => String(item.mime_type || '').split(';')[0].toLowerCase() === 'application/pdf')
      .map((item, index) => ({
        gmail_message_id: message.gmail_message_id, gmail_thread_id: message.gmail_thread_id,
        gmail_attachment_id: item.id,
        filename: message.message_source === 'pa_case_manager' && managed.get(message.gmail_message_id)?.[index]
          ? managed.get(message.gmail_message_id)[index]
          : item.original_filename || item.filename,
        size: item.size || null,
        subject: message.subject, source_sent_at: message.sent_at || message.indexed_at,
        existing: evidence.find((row) => row.gmail_message_id === message.gmail_message_id && row.gmail_attachment_id === item.id) || null
      })));
  }

  async function recoveryPreview(input) {
    const binary = await gmail.getAttachmentBinary({
      inquiryId: uuid(input.case_id), gmailMessageId: text(input.gmail_message_id, 200),
      gmailAttachmentId: text(input.gmail_attachment_id, 500)
    }, fetchImpl);
    if (binary.mime_type !== 'application/pdf') throw Error('invalid_estimate_recovery');
    await pdf.validatePdf(binary.bytes, pdf.sha(binary.bytes));
    return {
      original_filename: binary.filename,
      mime_type: binary.mime_type,
      size: binary.size,
      amount_extraction: await estimateAmount.extractEstimateAmount(binary.bytes)
    };
  }

  async function recoverEstimate(input, actor) {
    const binary = await gmail.getAttachmentBinary({
      inquiryId: uuid(input.case_id), gmailMessageId: text(input.gmail_message_id, 200),
      gmailAttachmentId: text(input.gmail_attachment_id, 500)
    }, fetchImpl);
    if (binary.mime_type !== 'application/pdf') throw Error('invalid_estimate_recovery');
    await pdf.validatePdf(binary.bytes, pdf.sha(binary.bytes));
    const extraction = await estimateAmount.extractEstimateAmount(binary.bytes);
    const amountMinor = integer(input.amount_minor, 1, 9999999999);
    if (extraction.status === 'HIGH_CONFIDENCE' && extraction.amount_minor !== amountMinor) throw Error('amount_extraction_mismatch');
    const result = await rpc('pa_v5_import_sent_estimate', {
      p_actor: actor.id, p_case: input.case_id, p_expected_revision: integer(input.expected_revision),
      p_expected_current: input.expected_current ? uuid(input.expected_current) : null,
      p_operation: uuid(input.operation_id), p_mode: text(input.mode, 20), p_document_id: uuid(input.document_id),
      p_filename: binary.filename, p_content_base64: binary.bytes.toString('base64'), p_sha256: pdf.sha(binary.bytes),
      p_amount_minor: amountMinor, p_currency: text(input.currency || 'JPY', 3),
      p_tax_basis: text(input.tax_basis, 20), p_conditions: object(input.conditions || {}),
      p_gmail_message_id: text(input.gmail_message_id, 200), p_gmail_attachment_id: text(input.gmail_attachment_id, 500)
    });
    return { ...result, original_filename: binary.filename, amount_extraction: extraction };
  }

  const correctEstimate = (input, actor) => rpc('pa_v5_correct_estimate_import', {
    p_actor: actor.id, p_case: uuid(input.case_id), p_estimate: uuid(input.estimate_revision_id),
    p_expected_revision: integer(input.expected_revision), p_operation: uuid(input.operation_id), p_reason: text(input.reason, 2000)
  });

  async function remindConfirmation(input, actor) {
    const bodyTemplate = text(input.body_template, 20000);
    if (!bodyTemplate.includes('{{CONFIRMATION_URL}}')) throw Error('invalid_confirmation_reminder');
    const original = await one('pa_commercial_outbox', {
      aggregate_id: 'eq.' + uuid(input.offer_id), job_kind: 'eq.confirmation', state: 'eq.sent',
      select: 'secret_envelope'
    });
    if (!original?.secret_envelope) throw Error('confirmation_reminder_secret_unavailable');
    const confirmationUrl = decryptSecret(original.secret_envelope);
    const preview = await mailPreview({
      caseId: input.case_id, actor,
      body: bodyTemplate.replace('{{CONFIRMATION_URL}}', confirmationUrl),
      replySource: input.reply_source || null, ccAddresses: input.cc_addresses || []
    });
    return rpc('pa_v5_queue_confirmation_reminder', {
      p_actor: actor.id, p_case: uuid(input.case_id), p_offer: uuid(input.offer_id),
      p_expected_revision: integer(input.expected_revision), p_operation: uuid(input.operation_id),
      p_subject: preview.subject, p_body: bodyTemplate, p_reply_binding: replyBinding(preview)
    });
  }

  async function createChangeProposal(input, actor) {
    const bytes = Buffer.from(text(input.content_base64, 8000000), 'base64');
    await pdf.validatePdf(bytes, text(input.sha256, 64));
    const attachment = { filename: text(input.filename, 500), mime_type: 'application/pdf', data: bytes.toString('base64url') };
    const preview = await mailPreview({
      caseId: input.case_id, actor, body: text(input.body, 20000), attachments: [attachment],
      replySource: input.reply_source || null, ccAddresses: input.cc_addresses || []
    });
    return rpc('pa_v5_create_change_proposal', {
      p_actor: actor.id, p_case: uuid(input.case_id), p_expected_revision: integer(input.expected_revision),
      p_operation: uuid(input.operation_id), p_contract: uuid(input.contract_id),
      p_estimate: uuid(input.estimate_revision_id), p_document: uuid(input.document_id),
      p_filename: attachment.filename, p_content_base64: bytes.toString('base64'), p_sha256: pdf.sha(bytes),
      p_amount_minor: integer(input.amount_minor, 1, 9999999999), p_currency: text(input.currency || 'JPY', 3),
      p_tax_basis: text(input.tax_basis, 20), p_conditions: object(input.conditions),
      p_recipient: preview.recipient, p_subject: preview.subject, p_body: preview.body, p_reply_binding: replyBinding(preview)
    });
  }

  const recordChangeAgreement = (input, actor) => rpc('pa_v5_record_change_agreement', {
    p_actor: actor.id, p_case: uuid(input.case_id), p_change: uuid(input.change_order_id),
    p_expected_revision: integer(input.expected_revision), p_operation: uuid(input.operation_id), p_evidence: object(input.evidence)
  });

  const defaultTransport = async (job, attachments) => {
    const adapter = String(process.env.PA_MAIL_ADAPTER || '').trim();
    if (adapter === 'fake') {
      if (!isLocalUrl(mail.supabaseConfig().url)) throw Error('fake_adapter_requires_local_db');
      return { gmail_message_id: 'fake-' + job.id, gmail_thread_id: 'fake-thread-' + job.inquiry_id };
    }
    if (adapter !== 'gmail') throw Error('mail_adapter_not_configured');
    let body = job.body_text;
    if (job.secret_envelope) body = body.replace('{{CONFIRMATION_URL}}', decryptSecret(job.secret_envelope));
    return gmail.sendReply({
      inquiryId: job.inquiry_id, actorId: job.actor_id, body, attachments,
      mode: 'normal', confirmationToken: job.reply_binding.confirmation_token,
      ccAddresses: job.reply_binding.cc_addresses || [],
      ...(job.reply_binding.reply_source_explicit ? {
        replySourceMessageId: job.reply_binding.reply_source_message_id,
        replySourceThreadId: job.reply_binding.reply_source_thread_id
      } : {})
    }, fetchImpl);
  };

  async function dispatch(input, actor) {
    const jobId = uuid(input.job_id);
    const lease = crypto.randomUUID();
    const claimed = await rpc('pa_v5_outbox_claim', { p_actor: actor.id, p_job: jobId, p_lease: lease });
    if (claimed?.state === 'cancelled') return claimed;
    if (claimed?.already_committed && claimed.state === 'sent') {
      const completed = await one('pa_commercial_outbox', { id: 'eq.' + jobId, select: 'provider_message_id' });
      return { state: 'sent', provider_message_id: completed?.provider_message_id || null, already_committed: true };
    }
    const job = await one('pa_commercial_outbox', { id: 'eq.' + jobId, select: '*' });
    const documents = [];
    for (const id of job.attachment_ids || []) {
      const document = await one('pa_commercial_documents', { id: 'eq.' + id, inquiry_id: 'eq.' + job.inquiry_id, select: 'original_filename,mime_type,content' });
      documents.push({ filename: document.original_filename, mime_type: document.mime_type, data: fromBytea(document.content).toString('base64url') });
    }
    let sent;
    try {
      sent = await (sendTransport || defaultTransport)({ ...job, actor_id: actor.id }, documents);
    } catch (error) {
      const knownFailure = ['mail_adapter_not_configured', 'fake_adapter_requires_local_db'].includes(error.message) || String(error.message).startsWith('gmail_send_');
      await rpc('pa_v5_outbox_finish', {
        p_actor: actor.id, p_job: jobId, p_lease: lease, p_state: knownFailure ? 'failed' : 'unknown',
        p_message: null, p_thread: null, p_error: knownFailure ? error.message : 'mail_outcome_unknown'
      });
      throw error;
    }
    try {
      await rpc('pa_v5_outbox_finish', { p_actor: actor.id, p_job: jobId, p_lease: lease, p_state: 'sent', p_message: sent.gmail_message_id, p_thread: sent.gmail_thread_id, p_error: null });
      return { state: 'sent', provider_message_id: sent.gmail_message_id };
    } catch {
      const recorded = await one('pa_commercial_outbox', { id: 'eq.' + jobId, select: 'state,provider_message_id' }).catch(() => null);
      if (recorded?.state === 'sent' && recorded.provider_message_id === sent.gmail_message_id) {
        return { state: 'sent', provider_message_id: sent.gmail_message_id, already_committed: true, finish_response_recovered: true };
      }
      await rpc('pa_v5_outbox_finish', {
        p_actor: actor.id, p_job: jobId, p_lease: lease, p_state: 'unknown',
        p_message: null, p_thread: null, p_error: 'mail_outcome_unknown'
      }).catch(() => null);
      throw Error('mail_outcome_unknown');
    }
  }

  return {
    snapshot, document, issueEstimate, beginRevision, issueConfirmation, createBilling, dispatch,
    recoveryCandidates, recoveryPreview, recoverEstimate, correctEstimate, remindConfirmation, createChangeProposal, recordChangeAgreement, composerPreview,
    revoke: (input, actor) => rpc('pa_v5_revoke_confirmation', { p_actor: actor.id, p_case: uuid(input.case_id), p_offer: uuid(input.offer_id), p_operation: uuid(input.operation_id), p_reason: text(input.reason, 2000) }),
    settle: (input, actor) => rpc('pa_v5_confirm_fulfillment_and_settlement', { p_actor: actor.id, p_case: uuid(input.case_id), p_expected_revision: integer(input.expected_revision), p_operation: uuid(input.operation_id), p_amount_minor: integer(input.amount_minor), p_unresolved: input.unresolved_changes === true, p_evidence: object(input.evidence) }),
    recordPayment: (input, actor) => rpc('pa_v5_record_payment', { p_actor: actor.id, p_case: uuid(input.case_id), p_billing: uuid(input.billing_id), p_operation: uuid(input.operation_id), p_payment_date: text(input.payment_date, 10), p_amount_minor: integer(input.amount_minor, 1), p_method: text(input.payment_method, 30), p_memo: text(input.memo, 5000, true) }),
    recordPrepayment: (input, actor) => rpc('pa_v5_record_prepayment', { p_actor: actor.id, p_case: uuid(input.case_id), p_operation: uuid(input.operation_id), p_payment_date: text(input.payment_date, 10), p_amount_minor: integer(input.amount_minor, 1), p_method: text(input.payment_method, 30), p_memo: text(input.memo, 5000, true) }),
    adjustPayment: (input, actor) => rpc('pa_v5_adjust_payment', { p_actor: actor.id, p_case: uuid(input.case_id), p_billing: input.billing_id ? uuid(input.billing_id) : null, p_payment: uuid(input.payment_id), p_operation: uuid(input.operation_id), p_delta_minor: integer(input.delta_minor, -9999999999, 9999999999), p_reason: text(input.reason, 2000) }),
    close: (input, actor) => rpc('pa_v5_payment_and_close', { p_actor: actor.id, p_case: uuid(input.case_id), p_billing: uuid(input.billing_id), p_expected_revision: integer(input.expected_revision), p_operation: uuid(input.operation_id), p_payment_date: input.payment_date || null, p_new_payment_minor: integer(input.new_payment_minor), p_method: input.payment_method || null, p_memo: text(input.memo, 5000, true) }),
    reopen: (input, actor) => rpc('pa_v5_reopen_case', { p_actor: actor.id, p_case: uuid(input.case_id), p_operation: uuid(input.operation_id), p_reason: text(input.reason, 2000) })
  };
}

module.exports = { createService, SAFE, encryptSecret, decryptSecret };

const crypto = require('node:crypto');
const mail = require('./_pa-mail.cjs');
const gmail = require('./_pa-gmail.cjs');
const pdf = require('./_pa-contract-pdf.cjs');
const estimateAmount = require('./_pa-estimate-amount.cjs');
const { issuanceTermsV4 } = require('./_pa-contract-terms.cjs');
const { canonicalAssetKey } = require('./_pa-portal-candidates.cjs');

const FORMAL_SNAPSHOT_VERSION = 'PA-FORMAL-V5-20260914-1';
const PRE_ISSUE_PREVIEW_VERSION = 'PA-EST-006-PREVIEW-1';
const CUSTOMER_CONFIRMATION_TEMPLATE_VERSION = 'PA-CUSTOMER-WEB-V3.2';
const RECEIPT_TEMPLATE_VERSION = 'PA-RECEIPT-V4.1';
const CONFIRMATION_URL_PLACEHOLDER = '発行時に正式URLが入ります';

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
  ,'stale_confirmation_preview', 'invalid_production_e2e_test', 'production_e2e_test_not_found',
  'production_e2e_test_already_archived', 'production_e2e_failpoint_already_used',
  'production_e2e_delivery_not_found', 'production_e2e_duplicate_delivery',
  'production_e2e_delivery_mismatch', 'production_e2e_recovery_blocked'
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
const emailAddress=value=>String(value||'').trim().match(/<?([^<>\s,;]+@[^<>\s,;]+)>?/u)?.[1]?.toLowerCase()||'';
const deliveryFailureDetails = (error, trace = {}) => {
  const rawCode = String(error?.message || '');
  const failureCode = /^[a-z][a-z0-9_]{0,99}$/u.test(rawCode) ? rawCode : 'unexpected_delivery_failure';
  const inferredResponse = /^gmail_send_/u.test(failureCode);
  const providerRequestStarted = Boolean(trace.provider_request_started || inferredResponse);
  const providerResponseReceived = Boolean(trace.provider_response_received || inferredResponse);
  const providerHttpStatus = Number.isInteger(trace.provider_http_status)
    ? trace.provider_http_status
    : Number(failureCode.match(/^gmail_send_([1-5][0-9]{2})$/u)?.[1]) || null;
  const deliveryState = !providerRequestStarted
    ? 'failed_before_provider'
    : providerResponseReceived ? 'failed_after_provider_response' : 'unknown_after_provider_start';
  const state = deliveryState === 'unknown_after_provider_start' ? 'unknown' : 'failed';
  const safeMessages = {
    invalid_confirmation: '送信内容の確認情報と添付ファイルが一致しません。',
    document_identity_mismatch: '添付書類の同一性を確認できません。',
    recipient_changed: '送信先が固定時から変更されています。',
    mail_adapter_not_configured: 'メール配送設定が完了していません。',
    invalid_production_e2e_test: 'Production TEST配送の固定条件と一致しません。'
  };
  const safeMessage = safeMessages[failureCode]
    || (failureCode.startsWith('gmail_oauth_') ? 'Gmail認証に失敗しました。'
      : failureCode.startsWith('gmail_send_') ? 'Gmail APIが送信リクエストを受理しませんでした。'
        : deliveryState === 'unknown_after_provider_start' ? '送信開始後の結果を確定できません。' : 'メール配送開始前に失敗しました。');
  const phase = /^[a-z][a-z0-9_]{0,99}$/u.test(String(trace.phase || '')) ? trace.phase : 'dispatch';
  return { state, deliveryState, failureCode, safeMessage, phase, providerRequestStarted, providerResponseReceived, providerHttpStatus };
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

const materialCategory = (filename, fallback = 'other') => {
  const value = String(filename || '');
  if (/(見積|estimate)/iu.test(value)) return 'estimate';
  if (/(請求|invoice)/iu.test(value)) return 'invoice';
  if (/(タイム|進行|timetable|schedule)/iu.test(value)) return 'timetable';
  if (/(配置|会場|layout|stage|ステージ)/iu.test(value)) return 'layout';
  if (/(出演|artist|performer)/iu.test(value)) return 'performer';
  if (/^image\//iu.test(fallback) || /\.(?:jpe?g|png|webp)$/iu.test(value)) return 'photo';
  return fallback;
};
const gmailIdentity = (messageId, attachmentId) => messageId && attachmentId ? `gmail:${messageId}:${attachmentId}` : null;
const sourceIdentities = (item) => [item?.canonical_attachment_key, gmailIdentity(item?.source_ref?.gmail_message_id, item?.source_ref?.gmail_attachment_id)].filter(Boolean);
const commercialGmailIdentities = (item, gmailMessages) => {
  const messageId = String(item?.gmail_message_id || '');
  const storedAttachmentId = String(item?.gmail_attachment_id || '');
  if (!messageId || !storedAttachmentId) return [];
  const message = gmailMessages.find((candidate) => candidate.gmail_message_id === messageId);
  const attachments = (Array.isArray(message?.attachment_metadata) ? message.attachment_metadata : []).filter(businessAttachment);
  const exact = attachments.filter((attachment) => [attachment.id, attachment.gmail_attachment_id, attachment.part_id, attachment.gmail_part_id]
    .filter(Boolean).map(String).includes(storedAttachmentId));
  const filename = String(item.original_filename || '').trim();
  const mime = String(item.mime_type || '').toLowerCase().split(';')[0];
  const sameFile = attachments.filter((attachment) => String(attachment.filename || '').trim() === filename
    && String(attachment.mime_type || '').toLowerCase().split(';')[0] === mime);
  const matched = exact.length === 1 ? exact[0] : exact.length === 0 && sameFile.length === 1 ? sameFile[0] : null;
  if (!matched) return [];
  return [
    gmailIdentity(messageId, matched.id || matched.gmail_attachment_id),
    canonicalAssetKey(messageId, matched.part_id || matched.gmail_part_id)
  ].filter(Boolean);
};
const businessAttachment = (attachment) => {
  const filename = String(attachment?.filename || '').trim();
  const mime = String(attachment?.mime_type || '').toLowerCase().split(';')[0];
  const size = Number(attachment?.size || 0);
  if (!filename || attachment?.inline === true || /\binline\b/iu.test(String(attachment?.content_disposition || ''))) return false;
  if (/(?:^|[-_.\s])(logo|signature|署名|smime|pixel|spacer)(?:[-_.\s]|$)/iu.test(filename)) return false;
  if (mime.startsWith('image/') && size > 0 && size < 1024) return false;
  return /^(?:application\/pdf|image\/(?:jpeg|png|webp)|application\/(?:vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet)|msword|vnd\.ms-excel))$/iu.test(mime)
    || /\.(?:pdf|jpe?g|png|webp|docx?|xlsx?)$/iu.test(filename);
};
const buildRelatedMaterials = ({ caseId, state, estimates = [], documents = [], gmailMessages = [], portalCards = [], portalVersions = [], portalPhotos = [] }) => {
  const currentDocumentId = estimates.find((item) => item.id === state?.current_estimate_revision_id)?.document_id || null;
  const cards = new Map(portalCards.map((card) => [card.id, card]));
  const seen = new Set();
  const materials = [];
  const push = (item, identities) => {
    const keys = (Array.isArray(identities) ? identities : [identities]).filter(Boolean);
    if (keys.some((identity) => seen.has(identity))) return;
    keys.forEach((identity) => seen.add(identity));
    materials.push(item);
  };
  for (const item of documents) {
    const identities = [gmailIdentity(item.gmail_message_id, item.gmail_attachment_id), ...commercialGmailIdentities(item, gmailMessages), `commercial:${item.id}`];
    const current = item.id === currentDocumentId;
    push({ material_id: `commercial:${item.id}`, case_id: caseId, source_type: 'commercial', source_id: item.id,
      category: materialCategory(item.original_filename, item.document_kind), display_title: item.original_filename,
      original_filename: item.original_filename, mime_type: item.mime_type, direction: item.source_kind === 'sent_recovery' ? 'outbound' : null,
      source_date: item.created_at, visibility: 'internal', portal_publication_state: 'unchanged', is_current: current, is_pinned: current,
      open_capability: { kind: 'commercial_document', document_id: item.id } }, identities);
  }
  for (const item of portalVersions) {
    const card = cards.get(item.card_id);
    if (!card || card.archived_at || item.archived_at) continue;
    const identities = [...sourceIdentities(item), `portal-version:${item.id}`];
    const current = card.current_version_id === item.id;
    push({ material_id: `portal-version:${item.id}`, case_id: caseId, source_type: 'portal', source_id: item.id,
      category: materialCategory(item.display_filename, card.category), display_title: card.title || item.display_filename,
      original_filename: item.display_filename, mime_type: item.mime_type, direction: item.contributor_kind === 'ara_tech' ? 'outbound' : 'inbound',
      source_date: item.source_created_at || item.created_at, visibility: card.owner_kind || item.contributor_kind || 'shared',
      portal_publication_state: current ? 'current' : 'history', is_current: current, is_pinned: current,
      open_capability: { kind: 'portal_asset', asset_kind: 'version', asset_id: item.id } }, identities);
  }
  for (const item of portalPhotos) {
    if (item.archived_at) continue;
    const identities = [...sourceIdentities(item), `portal-photo:${item.id}`];
    push({ material_id: `portal-photo:${item.id}`, case_id: caseId, source_type: 'portal', source_id: item.id,
      category: 'photo', display_title: item.caption || item.display_filename, original_filename: item.display_filename,
      mime_type: item.mime_type, direction: item.contributor_kind === 'ara_tech' ? 'outbound' : 'inbound', source_date: item.source_created_at || item.created_at,
      visibility: item.owner_kind || item.contributor_kind || 'shared', portal_publication_state: 'published', is_current: true, is_pinned: false,
      open_capability: { kind: 'portal_asset', asset_kind: 'photo', asset_id: item.id } }, identities);
  }
  for (const message of gmailMessages) {
    for (const attachment of Array.isArray(message.attachment_metadata) ? message.attachment_metadata : []) {
      if (!businessAttachment(attachment)) continue;
      const attachmentId = String(attachment.id || attachment.gmail_attachment_id || '');
      const identity = gmailIdentity(message.gmail_message_id, attachmentId);
      if (!identity) continue;
      const identities = [
        canonicalAssetKey(message.gmail_message_id, attachment.part_id || attachment.gmail_part_id),
        identity
      ];
      push({ material_id: identity, case_id: caseId, source_type: 'gmail', source_id: identity,
        category: materialCategory(attachment.filename, attachment.mime_type), display_title: attachment.filename,
        original_filename: attachment.filename, mime_type: String(attachment.mime_type || '').toLowerCase().split(';')[0], direction: message.direction,
        source_date: message.received_at || message.sent_at || message.indexed_at, visibility: 'conversation', portal_publication_state: 'not_published',
        is_current: false, is_pinned: false, open_capability: { kind: 'gmail_attachment', gmail_message_id: message.gmail_message_id, gmail_attachment_id: attachmentId } }, identities);
    }
  }
  const order = { estimate: 0, timetable: 10, layout: 20, photo: 30, performer: 40, invoice: 50, supporting: 60, other: 70 };
  return materials.sort((left, right) => Number(right.is_pinned) - Number(left.is_pinned)
    || Number(right.is_current) - Number(left.is_current) || (order[left.category] ?? 99) - (order[right.category] ?? 99)
    || String(right.source_date || '').localeCompare(String(left.source_date || '')) || left.material_id.localeCompare(right.material_id));
};

function createService({ fetchImpl = fetch, sendTransport, termsForIssue = issuanceTermsV4, createReceipt = pdf.createReceipt } = {}) {
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
  const finishOutbox = async (input) => {
    try { return await rpc('pa_v5_outbox_finish_v2', input); }
    catch (error) {
      if (error.message !== 'service_unavailable') throw error;
      return rpc('pa_v5_outbox_finish', {
        p_actor: input.p_actor, p_job: input.p_job, p_lease: input.p_lease,
        p_state: input.p_state, p_message: input.p_message, p_thread: input.p_thread, p_error: input.p_error
      });
    }
  };
  const rows = (table, params) => db(table + '?' + new URLSearchParams(params));
  const one = async (table, params) => (await rows(table, { ...params, limit: '1' }))?.[0] || null;
  const productionE2eMetadata = (caseId) => one('pa_production_e2e_tests', {
    test_case_id: 'eq.' + uuid(caseId), state: 'eq.active', select: '*'
  });

  async function confirmationMailPreview({ caseId, actor, body, attachments = [], ccAddresses = [], contentOnly = false }) {
    try {
      const render = contentOnly ? gmail.replyContentPreview : gmail.replyPreview;
      return await render({ inquiryId: caseId, actorId: actor.id, body, mode: 'confirmation', attachments, ccAddresses }, fetchImpl);
    } catch (error) {
      if (error.message !== 'gmail_thread_not_linked') throw error;
      const metadata = await productionE2eMetadata(caseId);
      if (!metadata || emailAddress(metadata.allowed_recipient) !== 'tonokun@gmail.com') throw error;
      const render = contentOnly ? gmail.standaloneContentPreview : gmail.standalonePreview;
      return render({
        inquiryId: caseId, actorId: actor.id, body, mode: 'confirmation', attachments,
        subjectOverride: metadata.source_confirmation_subject
      }, fetchImpl);
    }
  }

  async function snapshot(caseId) {
    uuid(caseId);
    const inquiry = await mail.getInquiry(caseId, fetchImpl);
    const [state, estimates, documents, offers, tokens, contracts, outbox, billings, payments, adjustments, changeOrders, deliveryEvidence, importCorrections, gmailMessages, portal, primaryThread, productionE2e] = await Promise.all([
      one('pa_case_commercial_state', { inquiry_id: 'eq.' + caseId, select: '*' }),
      rows('pa_estimate_revisions', { inquiry_id: 'eq.' + caseId, select: '*', order: 'issued_at.desc', limit: '100' }),
      rows('pa_commercial_documents', { inquiry_id: 'eq.' + caseId, select: 'id,inquiry_id,document_kind,source_kind,gmail_message_id,gmail_attachment_id,original_filename,mime_type,sha256,metadata,created_at', order: 'created_at.desc', limit: '200' }),
      rows('pa_contract_offers', { inquiry_id: 'eq.' + caseId, select: 'id,version,issued_at,expires_at,snapshot,estimate_revision_id', order: 'version.desc', limit: '100' }),
      rows('pa_contract_tokens', { select: 'offer_id,state', limit: '200' }),
      rows('pa_contracts', { inquiry_id: 'eq.' + caseId, select: 'id,version,confirmed_at,snapshot', order: 'version.desc', limit: '100' }),
      rows('pa_commercial_outbox', { inquiry_id: 'eq.' + caseId, select: '*', order: 'created_at.desc', limit: '200' }),
      rows('pa_billings', { inquiry_id: 'eq.' + caseId, select: '*', order: 'billing_number.desc', limit: '100' }),
      rows('pa_payment_records', { inquiry_id: 'eq.' + caseId, select: '*', order: 'confirmed_at.desc', limit: '200' }),
      rows('pa_payment_adjustments', { inquiry_id: 'eq.' + caseId, select: '*', order: 'adjusted_at.desc', limit: '200' }),
      rows('pa_change_orders', { inquiry_id: 'eq.' + caseId, select: '*', order: 'created_at.desc', limit: '100' }),
      rows('pa_estimate_delivery_evidence', { inquiry_id: 'eq.' + caseId, select: '*', order: 'recorded_at.desc', limit: '200' }),
      rows('pa_estimate_import_corrections', { inquiry_id: 'eq.' + caseId, select: '*', order: 'recorded_at.desc', limit: '200' }),
      rows('pa_gmail_message_index', { inquiry_id: 'eq.' + caseId, select: 'gmail_message_id,direction,sent_at,received_at,indexed_at,attachment_metadata', order: 'indexed_at.desc', limit: '200' }),
      one('pa_portals', { case_id: 'eq.' + caseId, select: 'id' }),
      one('pa_gmail_thread_links', { inquiry_id: 'eq.' + caseId, conversation_role: 'eq.primary_conversation', select: 'gmail_thread_id' }),
      emailAddress(inquiry.email) === 'tonokun@gmail.com' ? productionE2eMetadata(caseId) : Promise.resolve(null)
    ]);
    const portalCards = portal ? await rows('pa_portal_document_cards', { portal_id: 'eq.' + portal.id, archived_at: 'is.null', select: 'id,category,title,owner_kind,sort_order,current_version_id,archived_at' }) : [];
    const cardIds = new Set(portalCards.map((item) => item.id));
    const [casePortalVersions, portalPhotos] = portal ? await Promise.all([
      cardIds.size ? rows('pa_portal_document_versions', { card_id: `in.(${[...cardIds].join(',')})`, archived_at: 'is.null', select: 'id,card_id,source_type,source_ref,display_filename,mime_type,version_label,contributor_kind,source_created_at,created_at,archived_at,canonical_attachment_key' }) : [],
      rows('pa_portal_photo_items', { portal_id: 'eq.' + portal.id, archived_at: 'is.null', select: 'id,portal_id,source_type,source_ref,display_filename,mime_type,caption,contributor_kind,owner_kind,source_created_at,sort_order,created_at,archived_at,canonical_attachment_key' })
    ]) : [[], []];
    const effectiveState = state || { inquiry_id: caseId, revision: 0, estimate_change_state: 'ready', fulfillment_state: 'not_confirmed', settlement_state: 'unsettled', unresolved_changes: false };
    const contractIds = new Set(contracts.map((item) => item.id));
    const safeOutbox = outbox.map(({ body_text: _bodyText, secret_envelope: _secretEnvelope, ...item }) => item);
    return {
      case_status: inquiry.status,
      state: effectiveState,
      estimates, documents, offers: offers.map((offer) => ({
        ...offer,
        state: contractIds.has(offer.id) ? 'accepted' : tokens.find((token) => token.offer_id === offer.id)?.state || 'unknown',
        confirmed_at: contracts.find((contract) => contract.id === offer.id)?.confirmed_at || null
      })),
      outbox: safeOutbox, billings, payments: payments.map((item) => ({ ...item, amount_minor: Number(item.amount) })), adjustments, change_orders: changeOrders,
      estimate_delivery_evidence: deliveryEvidence, estimate_import_corrections: importCorrections,
      confirmation_preflight: {
        event_name: inquiry.event_name, event_date: inquiry.event_date, event_time: inquiry.event_time || null,
        venue: inquiry.venue || null, service_scope: inquiry.request_summary || null,
        organization: inquiry.organization_name || null, contact_name: inquiry.contact_name || inquiry.customer_name || null,
        recipient: inquiry.email, gmail_thread_id: primaryThread?.gmail_thread_id || null,
        payment_due_date: issuanceTermsV4(inquiry.event_date).payment_due_date,
        cancellation_terms: issuanceTermsV4(inquiry.event_date).cancellation_terms
      },
      production_e2e_test: productionE2e ? { state: productionE2e.state, allowed_recipient: productionE2e.allowed_recipient } : null,
      related_materials: buildRelatedMaterials({ caseId, state: effectiveState, estimates, documents, gmailMessages, portalCards, portalVersions: casePortalVersions, portalPhotos })
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
    delivery_mode: preview.delivery_mode || 'reply',
    reply_source_explicit: Boolean(preview.reply_source_explicit),
    reply_source_message_id: preview.reply_source_message_id || null,
    reply_source_thread_id: preview.gmail_thread_id,
    cc_addresses: preview.cc_addresses || []
  });

  const confirmationBodyTemplate = (inquiry) => {
    const contact = String(inquiry.contact_name || inquiry.customer_name || 'ご担当者').trim().replace(/\s*様\s*$/u, '');
    return `${contact} 様\n\nお世話になっております。\nARA-TECHの荒殿です。\n\n「${String(inquiry.event_name || '').trim()}」の正式受注確認をご案内いたします。\n対象のお見積り、キャンセル・変更条件、お支払期限をご確認ください。\n\n確認ページ：{{CONFIRMATION_URL}}\n\nご不明な点や調整が必要な事項がございましたら、正式依頼の前にこのメールへご返信ください。\n\nよろしくお願いいたします。\n\nARA-TECH\n荒殿`;
  };

  async function confirmationAuthority(caseId, actor) {
    const safeCaseId = uuid(caseId);
    const current = await snapshot(safeCaseId);
    const estimate = current.estimates.find((item) => item.id === current.state.current_estimate_revision_id);
    if (!estimate) throw Error('estimate_not_found');
    if (current.offers.some((item) => item.state === 'accepted')) throw Error('contract_already_accepted');
    if (current.offers.some((item) => item.state === 'active')) throw Error('confirmation_already_active');
    const [inquiry, documentRow] = await Promise.all([
      mail.getInquiry(safeCaseId, fetchImpl),
      one('pa_commercial_documents', {
        id: 'eq.' + estimate.document_id, inquiry_id: 'eq.' + safeCaseId,
        select: 'id,original_filename,mime_type,content,sha256,created_at'
      })
    ]);
    if (!documentRow) throw Error('document_identity_mismatch');
    const quoteBytes = fromBytea(documentRow.content);
    if (documentRow.mime_type !== 'application/pdf' || pdf.sha(quoteBytes) !== documentRow.sha256) throw Error('document_identity_mismatch');
    await pdf.validatePdf(quoteBytes, documentRow.sha256);
    const agreement = termsForIssue(text(inquiry.event_date, 10));
    const bodyTemplate = confirmationBodyTemplate(inquiry);
    const previewBody = bodyTemplate.replace('{{CONFIRMATION_URL}}', CONFIRMATION_URL_PLACEHOLDER);
    const confirmationAttachment = [{ filename: documentRow.original_filename, mime_type: documentRow.mime_type, data: quoteBytes.toString('base64url') }];
    const email = await confirmationMailPreview({ caseId: safeCaseId, actor, body: previewBody, attachments: confirmationAttachment, contentOnly: true });
    if (emailAddress(email.recipient) !== emailAddress(inquiry.email)) throw Error('invalid_contract');
    const contactName = String(inquiry.contact_name || inquiry.customer_name || '').trim();
    const organization = String(inquiry.organization_name || '').trim();
    const customerDisplay = [organization, contactName].filter(Boolean).join(' ');
    const customerSnapshot = {
      snapshot_schema_version: FORMAL_SNAPSHOT_VERSION,
      presentation_version: 5,
      preview_mode: 'pre_issue',
      case: {
        event_name: String(inquiry.event_name || '').trim(), event_date: String(inquiry.event_date || ''),
        event_time: String(inquiry.event_time || '').trim() || null, venue: String(inquiry.venue || '').trim(),
        service_scope: String(inquiry.request_summary || '').trim(),
        requested_services: Array.isArray(inquiry.requested_services) ? inquiry.requested_services.map((item) => String(item || '').trim()).filter(Boolean) : []
      },
      customer: { organization: organization || null, department: null, contact_name: contactName, display_name: customerDisplay },
      estimate: {
        estimate_id: estimate.id, revision_number: Number(estimate.revision_number), amount_minor: Number(estimate.amount_minor),
        currency: estimate.currency, original_filename: documentRow.original_filename, document_id: documentRow.id,
        mime_type: documentRow.mime_type, sha256: documentRow.sha256, sent_at: estimate.source_sent_at || estimate.issued_at || documentRow.created_at
      },
      terms: agreement,
      issuance: { issued_at: null, expires_at: null },
      acceptance: { confirmer_name: '', confirmed_at: null, agreed: false },
      customer_acknowledgement: { estimate_revision_id: estimate.id, amount_minor: Number(estimate.amount_minor), source: 'owner_pre_issue_preview' },
      conditions: estimate.conditions_snapshot || {},
      event_name: String(inquiry.event_name || '').trim(), event_date: String(inquiry.event_date || ''),
      recipient: String(inquiry.email || '').trim(), customer_name: customerDisplay, confirmer_name: contactName,
      amount: Number(estimate.amount_minor), amount_minor: Number(estimate.amount_minor), currency: estimate.currency,
      estimate_revision_id: estimate.id, estimate_revision_number: Number(estimate.revision_number), estimate_sha256: documentRow.sha256,
      order_scope: { performance_time: String(inquiry.event_time || '').trim(), venue: String(inquiry.venue || '').trim(), services: String(inquiry.request_summary || '').trim() },
      request_summary: String(inquiry.request_summary || '').trim(), payment_due_date: agreement.payment_due_date,
      payment_summary: agreement.payment_summary, payment_terms: agreement.payment_terms,
      cancellation_terms: agreement.cancellation_terms, cancellation_bands: agreement.cancellation_bands,
      business_terms: agreement.business_terms, other_terms_sections: agreement.other_terms_sections,
      terms_text: agreement.terms_text, quote: { filename: documentRow.original_filename, mime_type: documentRow.mime_type, sha256: documentRow.sha256, size: quoteBytes.length },
      related_documents: []
    };
    const authority = {
      preview_version: PRE_ISSUE_PREVIEW_VERSION,
      case_id: safeCaseId,
      case_revision: inquiry.updated_at || null,
      commercial_state_revision: Number(current.state.revision),
      event: customerSnapshot.case,
      customer: customerSnapshot.customer,
      inquiry_recipient_email: String(inquiry.email || '').trim(),
      recipient_email: email.recipient,
      recipient_thread: email.gmail_thread_id,
      reply_source_message_id: email.reply_source_message_id,
      cc: email.cc_addresses || [],
      current_estimate: customerSnapshot.estimate,
      estimate_conditions: estimate.conditions_snapshot || {},
      terms_version: agreement.terms_version,
      terms_content_sha256: pdf.sha(Buffer.from(canonical(agreement), 'utf8')),
      payment_due_date: agreement.payment_due_date,
      receipt_template_version: RECEIPT_TEMPLATE_VERSION,
      receipt_template_sha256: pdf.RECEIPT_V41_TEMPLATE_SHA,
      customer_confirmation_template_version: CUSTOMER_CONFIRMATION_TEMPLATE_VERSION,
      customer_service_summary: pdf.customerServiceSummary(customerSnapshot.case),
      email_subject: email.subject,
      email_body_template: bodyTemplate,
      email_html_sha256: pdf.sha(Buffer.from(email.html, 'utf8'))
    };
    const fingerprint = pdf.sha(Buffer.from(canonical(authority), 'utf8'));
    return { current, inquiry, estimate, documentRow, quoteBytes, confirmationAttachment, agreement, bodyTemplate, email, customerSnapshot, authority, fingerprint };
  }

  async function confirmationPreview(input, actor) {
    const result = await confirmationAuthority(input.case_id, actor);
    return {
      preview_route: '/api/pa-mail?surface=commercial',
      fingerprint: result.fingerprint,
      fingerprint_short: result.fingerprint.slice(0, 12),
      fingerprint_fields: Object.keys(result.authority),
      customer_snapshot: result.customerSnapshot,
      service_summary: pdf.customerServiceSummary(result.customerSnapshot.case),
      recipient: {
        customer_name: result.customerSnapshot.customer.contact_name,
        organization: result.customerSnapshot.customer.organization,
        to: result.email.recipient, gmail_thread_id: result.email.gmail_thread_id,
        reply_source_message_id: result.email.reply_source_message_id, cc: result.email.cc_addresses || []
      },
      estimate: { ...result.customerSnapshot.estimate, bytes: result.quoteBytes.length },
      email: { subject: result.email.subject, body: result.email.body, html: result.email.html },
      versions: { customer: CUSTOMER_CONFIRMATION_TEMPLATE_VERSION, receipt: RECEIPT_TEMPLATE_VERSION }
    };
  }

  async function confirmationReceiptPreview(input, actor) {
    const result = await confirmationAuthority(input.case_id, actor);
    if (result.fingerprint !== text(input.preview_fingerprint, 64)) throw Error('stale_confirmation_preview');
    const receipt = await createReceipt(result.customerSnapshot, result.quoteBytes);
    return { bytes: receipt.bytes, filename: `正式受注確認書_送信前プレビュー_${result.customerSnapshot.case.event_name}.pdf`, mime_type: 'application/pdf' };
  }

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
      if (priorJob.job_kind !== 'confirmation' || !priorOffer || priorOffer.inquiry_id !== input.case_id) throw Error('idempotency_payload_mismatch');
      return { id: priorOffer.id, version: priorOffer.version, outbox_id: priorJob.id, already_committed: true, secret_url_returned_once: null };
    }
    let prepared;
    try {
      prepared = await confirmationAuthority(input.case_id, actor);
    } catch (error) {
      if (['invalid_contract', 'estimate_not_found', 'document_identity_mismatch', 'gmail_thread_not_linked', 'reply_target_unavailable', 'invalid_reply_source', 'confirmation_already_active', 'contract_already_accepted'].includes(error.message)) {
        throw Error('stale_confirmation_preview');
      }
      throw error;
    }
    if (prepared.fingerprint !== text(input.preview_fingerprint, 64)) throw Error('stale_confirmation_preview');
    const { current, estimate, inquiry, agreement, bodyTemplate } = prepared;
    const token = crypto.randomBytes(32).toString('hex');
    const origin = String(process.env.PA_PUBLIC_ORIGIN || 'https://ara-tech.cc').replace(/\/+$/u, '');
    const confirmationUrl = origin + '/pa-contract.html#' + token;
    const body = bodyTemplate.replace('{{CONFIRMATION_URL}}', confirmationUrl);
    let preview;
    try {
      preview = await confirmationMailPreview({ caseId: input.case_id, actor, body, attachments: prepared.confirmationAttachment, ccAddresses: prepared.email.cc_addresses || [] });
    } catch (error) {
      if (['invalid_reply_cc', 'gmail_thread_not_linked', 'reply_target_unavailable', 'invalid_reply_source'].includes(error.message)) throw Error('stale_confirmation_preview');
      throw error;
    }
    if (preview.gmail_thread_id !== prepared.email.gmail_thread_id || preview.reply_source_message_id !== prepared.email.reply_source_message_id
      || preview.recipient !== prepared.email.recipient || preview.subject !== prepared.email.subject) throw Error('stale_confirmation_preview');
    const offerId = crypto.randomUUID();
    let result;
    try {
      result = await rpc('pa_v5_issue_confirmation', {
        p_actor: actor.id, p_case: uuid(input.case_id), p_expected_revision: current.state.revision,
        p_estimate: uuid(estimate.id), p_offer: offerId, p_operation: operationId,
        p_token_hash: pdf.sha(token), p_secret_envelope: encryptSecret(confirmationUrl),
        p_snapshot: {
          snapshot_schema_version: FORMAL_SNAPSHOT_VERSION,
          customer_acknowledgement: { estimate_revision_id: estimate.id, amount_minor: Number(estimate.amount_minor), source: 'owner_pre_issue_preview', preview_fingerprint: prepared.fingerprint },
          conditions: estimate.conditions_snapshot,
          ...agreement
        },
        p_recipient: preview.recipient, p_subject: preview.subject,
        p_body: bodyTemplate, p_reply_binding: replyBinding(preview)
      });
    } catch (error) {
      if (['commercial_state_changed', 'confirmation_already_active', 'contract_already_accepted', 'estimate_not_found', 'document_identity_mismatch', 'estimate_delivery_not_confirmed', 'invalid_contract'].includes(error.message)) throw Error('stale_confirmation_preview');
      throw error;
    }
    return { ...result, secret_url_returned_once: result.already_committed ? null : confirmationUrl };
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

  const defaultTransport = async (job, attachments, deliveryTrace) => {
    deliveryTrace.phase = 'adapter_validation';
    const adapter = String(process.env.PA_MAIL_ADAPTER || '').trim();
    if (adapter === 'fake') {
      if (!isLocalUrl(mail.supabaseConfig().url)) throw Error('fake_adapter_requires_local_db');
      return { gmail_message_id: 'fake-' + job.id, gmail_thread_id: 'fake-thread-' + job.inquiry_id };
    }
    if (adapter !== 'gmail') throw Error('mail_adapter_not_configured');
    deliveryTrace.phase = 'secret_resolution';
    let body = job.body_text;
    if (job.secret_envelope) body = body.replace('{{CONFIRMATION_URL}}', decryptSecret(job.secret_envelope));
    if (job.job_kind === 'confirmation' && job.reply_binding?.delivery_mode === 'standalone_production_e2e') {
      deliveryTrace.phase = 'production_e2e_guard';
      const metadata = await productionE2eMetadata(job.inquiry_id);
      if (!metadata
        || emailAddress(job.recipient) !== 'tonokun@gmail.com'
        || emailAddress(metadata.allowed_recipient) !== emailAddress(job.recipient)
        || metadata.source_confirmation_subject !== job.subject) throw Error('invalid_production_e2e_test');
      return gmail.sendStandalone({
        inquiryId: job.inquiry_id, actorId: job.actor_id, body, attachments,
        confirmationToken: job.reply_binding.confirmation_token,
        subjectOverride: job.subject, jobId: job.id, deliveryTrace
      }, fetchImpl);
    }
    if(job.job_kind==='accept_receipt'){
      const binding=job.reply_binding||{};
      const options={inquiryId:job.inquiry_id,actorId:job.actor_id,body,attachments,mode:'normal',ccAddresses:binding.cc_addresses||[],subjectOverride:job.subject,deliveryTrace,
        ...(binding.reply_source_explicit?{replySourceMessageId:binding.reply_source_message_id,replySourceThreadId:binding.reply_source_thread_id}:{})};
      const preview=await gmail.replyPreview(options,fetchImpl);
      if(emailAddress(preview.recipient)!==emailAddress(job.recipient))throw Error('recipient_changed');
      return gmail.sendReply({...options,confirmationToken:preview.confirmation_token},fetchImpl);
    }
    return gmail.sendReply({
      inquiryId: job.inquiry_id, actorId: job.actor_id, body, attachments,
      mode: job.job_kind === 'confirmation' ? 'confirmation' : 'normal', confirmationToken: job.reply_binding.confirmation_token,
      deliveryTrace,
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
    let sent;
    const deliveryTrace = { phase: 'attachment_loading', provider_request_started: false, provider_response_received: false, provider_http_status: null };
    try {
      let documents=[];
      if(job.job_kind==='accept_receipt')documents=await require('./_pa-contract.cjs').createService({fetchImpl}).receiptAttachments(job.inquiry_id,job.aggregate_id);
      else for (const id of job.attachment_ids || []) {
        const document = await one('pa_commercial_documents', { id: 'eq.' + id, inquiry_id: 'eq.' + job.inquiry_id, select: 'original_filename,mime_type,content' });
        if(!document)throw Error('document_identity_mismatch');
        documents.push({ filename: document.original_filename, mime_type: document.mime_type, data: fromBytea(document.content).toString('base64url') });
      }
      if (sendTransport) {
        deliveryTrace.phase = 'provider_request';
        deliveryTrace.provider_request_started = true;
      }
      sent = await (sendTransport || defaultTransport)({ ...job, actor_id: actor.id }, documents, deliveryTrace);
      if (sent?.production_e2e_standalone) {
        deliveryTrace.phase = 'post_send_failpoint';
        const failpoint = await rpc('pa_production_e2e_consume_failpoint', {
          p_actor: actor.id, p_case: job.inquiry_id, p_job: job.id
        });
        if (failpoint?.fired) throw Error('production_e2e_after_gmail_send');
        deliveryTrace.phase = 'gmail_thread_link';
        await gmail.manualLink({
          inquiryId: job.inquiry_id, gmailThreadId: sent.gmail_thread_id,
          conversationRole: 'primary_conversation', actorId: actor.id
        }, fetchImpl);
      }
    } catch (error) {
      const failure = deliveryFailureDetails(error, deliveryTrace);
      await finishOutbox({
        p_actor: actor.id, p_job: jobId, p_lease: lease, p_state: failure.state,
        p_message: sent?.gmail_message_id || null, p_thread: sent?.gmail_thread_id || null,
        p_error: failure.state === 'unknown' ? 'mail_outcome_unknown' : failure.failureCode,
        p_delivery_state: failure.deliveryState, p_failure_phase: failure.phase,
        p_failure_code: failure.failureCode, p_safe_message: failure.safeMessage,
        p_provider_started: failure.providerRequestStarted, p_provider_response: failure.providerResponseReceived,
        p_provider_status: failure.providerHttpStatus
      });
      throw error;
    }
    try {
      await finishOutbox({
        p_actor: actor.id, p_job: jobId, p_lease: lease, p_state: 'sent', p_message: sent.gmail_message_id, p_thread: sent.gmail_thread_id, p_error: null,
        p_delivery_state: 'sent', p_failure_phase: null, p_failure_code: null, p_safe_message: null,
        p_provider_started: true, p_provider_response: true, p_provider_status: deliveryTrace.provider_http_status || 200
      });
      return { state: 'sent', provider_message_id: sent.gmail_message_id };
    } catch {
      const recorded = await one('pa_commercial_outbox', { id: 'eq.' + jobId, select: 'state,provider_message_id' }).catch(() => null);
      if (recorded?.state === 'sent' && recorded.provider_message_id === sent.gmail_message_id) {
        return { state: 'sent', provider_message_id: sent.gmail_message_id, already_committed: true, finish_response_recovered: true };
      }
      await finishOutbox({
        p_actor: actor.id, p_job: jobId, p_lease: lease, p_state: 'unknown',
        p_message: sent?.gmail_message_id || null, p_thread: sent?.gmail_thread_id || null, p_error: 'mail_outcome_unknown',
        p_delivery_state: 'unknown_after_provider_start', p_failure_phase: 'outbox_finish',
        p_failure_code: 'mail_outcome_unknown', p_safe_message: '送信後の保存結果を確定できません。',
        p_provider_started: true, p_provider_response: true, p_provider_status: deliveryTrace.provider_http_status || 200
      }).catch(() => null);
      throw Error('mail_outcome_unknown');
    }
  }

  const createProductionE2eClone = (input, actor) => rpc('pa_production_e2e_clone_case', {
    p_actor: actor.id,
    p_source_case: uuid(input.source_case_id),
    p_allowed_recipient: emailAddress(input.allowed_recipient),
    p_operation: uuid(input.operation_id)
  });

  const armProductionE2eFailpoint = (input, actor) => rpc('pa_production_e2e_arm_failpoint', {
    p_actor: actor.id, p_case: uuid(input.case_id), p_operation: uuid(input.operation_id)
  });

  async function reconcileProductionE2eUnknown(input, actor) {
    const caseId = uuid(input.case_id);
    const jobId = uuid(input.job_id);
    const [metadata, job] = await Promise.all([
      productionE2eMetadata(caseId),
      one('pa_commercial_outbox', { id: 'eq.' + jobId, inquiry_id: 'eq.' + caseId, select: '*' })
    ]);
    if (!metadata || !job || job.job_kind !== 'confirmation'
      || !['unknown', 'sent'].includes(job.state)
      || emailAddress(job.recipient) !== 'tonokun@gmail.com') throw Error('invalid_production_e2e_test');
    const evidence = await gmail.findStandaloneDelivery({ jobId, recipient: job.recipient, subject: job.subject }, fetchImpl);
    if (job.state === 'sent') {
      if (job.provider_message_id !== evidence.gmail_message_id || job.provider_thread_id !== evidence.gmail_thread_id) {
        throw Error('production_e2e_delivery_mismatch');
      }
      return { state: 'sent', already_committed: true, ...evidence };
    }
    const result = await rpc('pa_production_e2e_reconcile_unknown', {
      p_actor: actor.id, p_case: caseId, p_job: jobId,
      p_message: evidence.gmail_message_id, p_thread: evidence.gmail_thread_id,
      p_sent_at: evidence.sent_at
    });
    await gmail.manualLink({
      inquiryId: caseId, gmailThreadId: evidence.gmail_thread_id,
      conversationRole: 'primary_conversation', actorId: actor.id
    }, fetchImpl);
    return { ...result, ...evidence };
  }

  async function productionE2eRecoveryPreview(input, actor) {
    const caseId = uuid(input.case_id);
    const jobId = uuid(input.job_id);
    const [metadata, job] = await Promise.all([
      productionE2eMetadata(caseId),
      one('pa_commercial_outbox', { id: 'eq.' + jobId, inquiry_id: 'eq.' + caseId, select: '*' })
    ]);
    if (!metadata || metadata.state !== 'active' || !job || job.job_kind !== 'confirmation'
      || emailAddress(metadata.allowed_recipient) !== 'tonokun@gmail.com'
      || emailAddress(job.recipient) !== 'tonokun@gmail.com'
      || job.reply_binding?.delivery_mode !== 'standalone_production_e2e') throw Error('invalid_production_e2e_test');
    const [offer, token, estimate] = await Promise.all([
      one('pa_contract_offers', { id: 'eq.' + job.aggregate_id, inquiry_id: 'eq.' + caseId, select: 'id,version,estimate_revision_id,snapshot' }),
      one('pa_contract_tokens', { offer_id: 'eq.' + job.aggregate_id, select: 'state' }),
      one('pa_estimate_revisions', { id: 'eq.' + metadata.test_estimate_id, inquiry_id: 'eq.' + caseId, select: 'id,revision_number,amount_minor,currency' })
    ]);
    if (!offer || Number(offer.version) !== 1 || token?.state !== 'active' || !estimate
      || offer.estimate_revision_id !== estimate.id || Number(estimate.revision_number) !== 2
      || Number(estimate.amount_minor) !== 198550 || estimate.currency !== 'JPY') throw Error('invalid_production_e2e_test');
    const evidence = await gmail.probeStandaloneDelivery({ jobId, recipient: job.recipient, subject: job.subject }, fetchImpl);
    const deliveryState = job.delivery_state || ({ failed: 'failed_before_provider', unknown: 'unknown_after_provider_start', sent: 'sent' }[job.state] || job.state);
    if (job.state === 'sent' && evidence.match_count !== 1) throw Error('production_e2e_delivery_mismatch');
    if (evidence.match_count === 1 && job.state === 'sent'
      && (job.provider_message_id !== evidence.gmail_message_id || job.provider_thread_id !== evidence.gmail_thread_id)) {
      throw Error('production_e2e_delivery_mismatch');
    }
    return {
      case_id: caseId, job_id: jobId, offer_id: offer.id, confirmation_version: Number(offer.version),
      recipient: job.recipient, subject: job.subject, event_name: '2026龍姫湖まつり',
      estimate_revision_number: Number(estimate.revision_number), amount_minor: Number(estimate.amount_minor), currency: estimate.currency,
      state: job.state, delivery_state: deliveryState, attempt_count: Number(job.attempt_count),
      failure_phase: job.failure_phase || null, failure_code: job.failure_code || job.last_error_code || null,
      safe_error_message: job.safe_error_message || null, deterministic_message_id: gmail.productionE2eMessageId(jobId),
      provider_match_count: evidence.match_count, provider_message_id: evidence.gmail_message_id || null,
      provider_thread_id: evidence.gmail_thread_id || null, sent_at: evidence.sent_at || null,
      can_send_same_confirmation: evidence.match_count === 0 && deliveryState === 'failed_before_provider',
      will_send: evidence.match_count === 0 && deliveryState === 'failed_before_provider'
    };
  }

  async function recoverProductionE2eDelivery(input, actor) {
    const preview = await productionE2eRecoveryPreview(input, actor);
    if (preview.provider_match_count === 1) {
      const result = await rpc('pa_production_e2e_reconcile_delivery', {
        p_actor: actor.id, p_case: preview.case_id, p_job: preview.job_id,
        p_message: preview.provider_message_id, p_thread: preview.provider_thread_id, p_sent_at: preview.sent_at
      });
      await gmail.manualLink({
        inquiryId: preview.case_id, gmailThreadId: preview.provider_thread_id,
        conversationRole: 'primary_conversation', actorId: actor.id
      }, fetchImpl);
      return { ...result, send_performed: false, provider_match_count: 1, deterministic_message_id: preview.deterministic_message_id };
    }
    if (!preview.can_send_same_confirmation) throw Error('production_e2e_recovery_blocked');
    const result = await dispatch({ job_id: preview.job_id }, actor);
    return { ...result, send_performed: true, provider_match_count: 0, deterministic_message_id: preview.deterministic_message_id };
  }

  const archiveProductionE2eCase = (input, actor) => rpc('pa_production_e2e_archive_case', {
    p_actor: actor.id, p_case: uuid(input.case_id), p_reason: text(input.reason, 2000)
  });

  return {
    snapshot, document, confirmationPreview, confirmationReceiptPreview, issueEstimate, beginRevision, issueConfirmation, createBilling, dispatch,
    recoveryCandidates, recoveryPreview, recoverEstimate, correctEstimate, remindConfirmation, createChangeProposal, recordChangeAgreement, composerPreview,
    createProductionE2eClone, armProductionE2eFailpoint, reconcileProductionE2eUnknown,
    productionE2eRecoveryPreview, recoverProductionE2eDelivery, archiveProductionE2eCase,
    revoke: (input, actor) => rpc('pa_v5_revoke_confirmation', { p_actor: actor.id, p_case: uuid(input.case_id), p_offer: uuid(input.offer_id), p_operation: uuid(input.operation_id), p_reason: text(input.reason, 2000) }),
    settle: (input, actor) => rpc('pa_v5_confirm_fulfillment_and_settlement', { p_actor: actor.id, p_case: uuid(input.case_id), p_expected_revision: integer(input.expected_revision), p_operation: uuid(input.operation_id), p_amount_minor: integer(input.amount_minor), p_unresolved: input.unresolved_changes === true, p_evidence: object(input.evidence) }),
    recordPayment: (input, actor) => rpc('pa_v5_record_payment', { p_actor: actor.id, p_case: uuid(input.case_id), p_billing: uuid(input.billing_id), p_operation: uuid(input.operation_id), p_payment_date: text(input.payment_date, 10), p_amount_minor: integer(input.amount_minor, 1), p_method: text(input.payment_method, 30), p_memo: text(input.memo, 5000, true) }),
    recordPrepayment: (input, actor) => rpc('pa_v5_record_prepayment', { p_actor: actor.id, p_case: uuid(input.case_id), p_operation: uuid(input.operation_id), p_payment_date: text(input.payment_date, 10), p_amount_minor: integer(input.amount_minor, 1), p_method: text(input.payment_method, 30), p_memo: text(input.memo, 5000, true) }),
    adjustPayment: (input, actor) => rpc('pa_v5_adjust_payment', { p_actor: actor.id, p_case: uuid(input.case_id), p_billing: input.billing_id ? uuid(input.billing_id) : null, p_payment: uuid(input.payment_id), p_operation: uuid(input.operation_id), p_delta_minor: integer(input.delta_minor, -9999999999, 9999999999), p_reason: text(input.reason, 2000) }),
    close: (input, actor) => rpc('pa_v5_payment_and_close', { p_actor: actor.id, p_case: uuid(input.case_id), p_billing: uuid(input.billing_id), p_expected_revision: integer(input.expected_revision), p_operation: uuid(input.operation_id), p_payment_date: input.payment_date || null, p_new_payment_minor: integer(input.new_payment_minor), p_method: input.payment_method || null, p_memo: text(input.memo, 5000, true) }),
    reopen: (input, actor) => rpc('pa_v5_reopen_case', { p_actor: actor.id, p_case: uuid(input.case_id), p_operation: uuid(input.operation_id), p_reason: text(input.reason, 2000) })
  };
}

module.exports = { createService, SAFE, encryptSecret, decryptSecret, buildRelatedMaterials, businessAttachment, materialCategory, PRE_ISSUE_PREVIEW_VERSION, CUSTOMER_CONFIRMATION_TEMPLATE_VERSION, RECEIPT_TEMPLATE_VERSION };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildRelatedMaterials, businessAttachment } = require('../api/_pa-commercial.cjs');
const { canonicalAssetKey } = require('../api/_pa-portal-candidates.cjs');

const caseId = 'case-a';
const documents = [{ id: 'doc-1', inquiry_id: caseId, document_kind: 'estimate', source_kind: 'sent_recovery', gmail_message_id: 'm1', gmail_attachment_id: 'a1', original_filename: '見積書.pdf', mime_type: 'application/pdf', created_at: '2026-09-13T01:00:00Z' }];
const portalCards = [{ id: 'card-1', category: 'layout', title: '会場図', owner_kind: 'shared', current_version_id: 'version-1' }];
const portalVersions = [{ id: 'version-1', card_id: 'card-1', source_ref: { gmail_message_id: 'm2', gmail_attachment_id: 'historical-a2' }, canonical_attachment_key: canonicalAssetKey('m2', '1'), display_filename: '会場図.pdf', mime_type: 'application/pdf', contributor_kind: 'organizer', source_created_at: '2026-09-12T01:00:00Z' }];
const portalPhotos = [{ id: 'photo-1', source_ref: { gmail_message_id: 'm3', gmail_attachment_id: 'historical-a3' }, canonical_attachment_key: canonicalAssetKey('m3', '1'), display_filename: 'ステージ写真.JPG', mime_type: 'image/jpeg', contributor_kind: 'organizer', source_created_at: '2026-09-11T01:00:00Z' }];
const gmailMessages = [{ gmail_message_id: 'm1', direction: 'outbound', sent_at: '2026-09-13T01:00:00Z', attachment_metadata: [{ id: 'a1', filename: '見積書.pdf', mime_type: 'application/pdf' }] },
  { gmail_message_id: 'm2', direction: 'inbound', received_at: '2026-09-12T01:00:00Z', attachment_metadata: [{ id: 'current-a2', part_id: '1', filename: '会場図.pdf', mime_type: 'application/pdf' }] },
  { gmail_message_id: 'm3', direction: 'inbound', received_at: '2026-09-11T01:00:00Z', attachment_metadata: [{ id: 'current-a3', part_id: '1', filename: 'ステージ写真.JPG', mime_type: 'image/jpeg', size: 50000 }, { id: 'logo', part_id: '2', filename: 'signature-logo.png', mime_type: 'image/png', size: 400 }] },
  { gmail_message_id: 'm4', direction: 'outbound', sent_at: '2026-09-14T01:00:00Z', attachment_metadata: [{ id: 'a4', filename: '見積書 改訂.pdf', mime_type: 'application/pdf' }] }];
const result = buildRelatedMaterials({ caseId, state: { current_estimate_revision_id: 'estimate-1' }, estimates: [{ id: 'estimate-1', document_id: 'doc-1' }], documents, gmailMessages, portalCards, portalVersions, portalPhotos });
assert.equal(result.length, 4, 'commercial, portal version, portal photo and Gmail-only revised estimate');
assert.equal(new Set(result.map((item) => item.material_id)).size, 4);
assert.equal(result[0].material_id, 'commercial:doc-1');
assert.equal(result.every((item) => item.case_id === caseId), true);
assert.equal(result.filter((item) => item.original_filename === '会場図.pdf').length, 1, 'portal copy suppresses Gmail duplicate');
assert.equal(result.some((item) => /signature/iu.test(item.original_filename)), false);
assert.equal(businessAttachment({ filename: 'inline-logo.png', mime_type: 'image/png', inline: true }), false);

const source = fs.readFileSync(path.join(__dirname, '..', 'api', '_pa-commercial.cjs'), 'utf8');
assert.match(source, /pa_portal_document_cards[^\n]+portal_id:\s*'eq\.'\s*\+\s*portal\.id/u);
assert.match(source, /pa_portal_photo_items[^\n]+portal_id:\s*'eq\.'\s*\+\s*portal\.id/u);
assert.match(source, /pa_portal_document_versions[^\n]+card_id:\s*`in\.\(/u);
console.log('PASS PA-EST-004R11 related materials: three-source projection, deterministic dedupe, inline exclusion and case-scoped reads');

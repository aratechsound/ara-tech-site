import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const base = process.env.PA_EST_004_REAL_BASE || 'http://127.0.0.1:8772';
const snapshot = await (await fetch(`${base}/__fixture/snapshot`)).json();
const caseId = snapshot.state.inquiry_id;
const documentId = snapshot.documents[0].id;
const otherCase = crypto.randomUUID();
const forgedId = crypto.randomUUID();
const post = (path, body, token) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});

assert.equal((await post('/api/pa-mail?surface=commercial', { action: 'document', case_id: caseId, document_id: documentId })).status, 401, 'anonymous commercial preview rejected');
assert.equal((await post('/api/pa-mail?surface=commercial', { action: 'document', case_id: caseId, document_id: documentId }, 'not-admin')).status, 401, 'non-admin commercial preview rejected');
const valid = await post('/api/pa-mail?surface=commercial', { action: 'document', case_id: caseId, document_id: documentId }, 'fixture-admin');
assert.equal(valid.status, 200, 'case-bound owner preview succeeds');
assert.match(valid.headers.get('cache-control') || '', /no-store/u);
assert.equal((await post('/api/pa-mail?surface=commercial', { action: 'document', case_id: otherCase, document_id: documentId }, 'fixture-admin')).ok, false, 'case crossover rejected');
assert.equal((await post('/api/pa-mail?surface=commercial', { action: 'document', case_id: caseId, document_id: forgedId }, 'fixture-admin')).status, 400, 'forged commercial source id rejected');

assert.equal((await post('/api/pa-portal', { action: 'download', inquiry_id: caseId, asset_id: forgedId, asset_kind: 'version' })).status, 401, 'anonymous portal preview rejected');
assert.equal((await post('/api/pa-portal', { action: 'download', inquiry_id: otherCase, asset_id: forgedId, asset_kind: 'version' }, 'fixture-admin')).status, 400, 'portal case crossover rejected');
assert.equal((await post('/api/pa-portal', { action: 'download', inquiry_id: caseId, asset_id: forgedId, asset_kind: 'version' }, 'fixture-admin')).status, 400, 'forged portal source id rejected');
assert.equal((await post('/api/pa-gmail', { action: 'attachment_download', inquiry_id: caseId, gmail_message_id: 'direct_sent_001', gmail_attachment_id: 'forged' }, 'fixture-admin')).status, 400, 'Gmail attachment crossover rejected');
assert.equal((await fetch(`${base}/api/pa-mail?surface=commercial&action=document&case_id=${caseId}&document_id=${documentId}`)).status, 405, 'private document has no public GET route');

const serialized = JSON.stringify(snapshot.related_materials);
assert.doesNotMatch(serialized, /portal_secret|storage_path|service_role|signed_url/iu, 'admin projection exposes no portal secret or storage key');
console.log('PASS PA-EST-004R11B preview security: auth, non-admin, case crossover, forged source, Gmail crossover, no public GET/secret/storage exposure');

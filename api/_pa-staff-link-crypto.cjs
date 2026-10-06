const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const fail = () => { throw new Error('staff_url_unavailable'); };
function keyring(environment = process.env) {
  let entries;
  try { entries = JSON.parse(environment.PA_STAFF_LINK_KEYRING_JSON || ''); } catch { return fail(); }
  if (!entries || Array.isArray(entries) || typeof entries !== 'object') return fail();
  const keys = new Map();
  for (const [id, value] of Object.entries(entries)) {
    if (!KEY_ID.test(id) || typeof value !== 'string') return fail();
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) return fail();
    keys.set(id, key);
  }
  const active = environment.PA_STAFF_LINK_ACTIVE_KEY_ID;
  if (!KEY_ID.test(active || '') || !keys.has(active)) return fail();
  return { keys, active };
}
function aad(binding) {
  if (!UUID.test(binding.link_id || '') || !UUID.test(binding.case_id || '') || !HASH.test(binding.token_hash || '') || !['GENERAL', 'TECHNICAL'].includes(binding.grade) || !KEY_ID.test(binding.key_id || '') || binding.version !== 1) return fail();
  return Buffer.from(JSON.stringify(['ara-tech/staff-link', 1, binding.link_id, binding.case_id, binding.grade, binding.token_hash, binding.key_id]));
}
function seal(secret, binding, environment = process.env) {
  if (!HASH.test(secret || '') || crypto.createHash('sha256').update(secret).digest('hex') !== binding.token_hash) return fail();
  const { keys, active } = keyring(environment), iv = crypto.randomBytes(12);
  const bound = { ...binding, key_id: active, version: 1 };
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(active), iv);
  cipher.setAAD(aad(bound));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { link_id: binding.link_id, key_id: active, version: 1, iv: iv.toString('hex'), ciphertext: ciphertext.toString('base64') };
}
function open(envelope, environment = process.env) {
  try {
    const { keys } = keyring(environment), key = keys.get(envelope.key_id);
    if (!key || !/^[a-f0-9]{24}$/u.test(envelope.iv || '')) return fail();
    const bytes = Buffer.from(envelope.ciphertext || '', 'base64');
    if (bytes.length !== 80 || bytes.toString('base64') !== envelope.ciphertext) return fail();
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    cipher.setAAD(aad(envelope)); cipher.setAuthTag(bytes.subarray(64));
    const secret = Buffer.concat([cipher.update(bytes.subarray(0,64)), cipher.final()]).toString('utf8');
    if (!HASH.test(secret) || !crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(secret).digest('hex')), Buffer.from(envelope.token_hash))) return fail();
    return secret;
  } catch { return fail(); }
}
module.exports = { seal, open };

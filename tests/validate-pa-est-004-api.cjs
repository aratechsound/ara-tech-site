const assert = require('node:assert/strict');
const { createHandler } = require('../api/_pa-commercial-handler.cjs');
const { encryptSecret, decryptSecret } = require('../api/_pa-commercial.cjs');

process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:8765';
process.env.PA_COMMERCIAL_OUTBOX_KEY = '11'.repeat(32);
const actor = { id: '91000000-0000-4000-8000-000000000001' };
const calls = [];
const service = new Proxy({}, { get: (_target, name) => async (...args) => { calls.push([name, ...args]); if (name === 'snapshot') return { state: { revision: 3 } }; if (name === 'document') return { bytes: Buffer.from('fixture'), filename: 'fixture.txt', mime_type: 'text/plain' }; return { action: name }; } });
const admin = async token => { if (token !== 'fixture') throw Error('not_authorized'); return actor; };
const allowedRate = async () => ({ allowed: true });
const handler = createHandler({ service, admin, rate: allowedRate });
const request = async (body, options = {}) => {
  const res = { headers:{}, setHeader(k,v){this.headers[k]=v;}, getHeader(k){return this.headers[k];}, status(s){this.statusCode=s;return this;}, json(value){this.body=value;return this;}, write(value){this.bytes=Buffer.concat([this.bytes||Buffer.alloc(0),Buffer.from(value)]);return true;}, end(){this.ended=true;return this;} };
  await handler({ method: options.method || 'POST', headers: { origin: options.origin ?? 'http://127.0.0.1:8765', authorization: options.auth === false ? '' : 'Bearer fixture' }, body, socket:{remoteAddress:'127.0.0.1'} }, res);
  return res;
};

(async () => {
  let res = await request({ action:'snapshot', case_id:'92000000-0000-4000-8000-000000000001' });
  assert.equal(res.statusCode,200); assert.equal(res.body.result.state.revision,3);
  assert.equal(res.headers['Cache-Control'],'private, no-store, max-age=0');
  res = await request({ action:'not_real' }); assert.equal(res.statusCode,400); assert.equal(res.body.code,'invalid_commercial_request');
  res = await request({ action:'snapshot', case_id:'92000000-0000-4000-8000-000000000001' }, { auth:false }); assert.equal(res.statusCode,401);
  res = await request({ action:'snapshot', case_id:'92000000-0000-4000-8000-000000000001' }, { origin:'https://attacker.invalid' }); assert.equal(res.statusCode,403);
  res = await request({}, { method:'GET' }); assert.equal(res.statusCode,405); assert.equal(res.headers.Allow,'POST');
  const limited = createHandler({ service, admin, rate: async () => ({allowed:false,retryAfter:17}) });
  const rateRes={headers:{},setHeader(k,v){this.headers[k]=v;},getHeader(k){return this.headers[k];},status(s){this.statusCode=s;return this;},json(v){this.body=v;return this;}};
  await limited({method:'POST',headers:{authorization:'Bearer fixture'},body:{action:'snapshot',case_id:'92000000-0000-4000-8000-000000000001'},socket:{}},rateRes);
  assert.equal(rateRes.statusCode,429); assert.equal(rateRes.headers['Retry-After'],'17');
  const secret='https://example.invalid/pa-contract.html#fixture-secret';
  const envelope=encryptSecret(secret); assert.equal(decryptSecret(envelope),secret); assert(!envelope.includes('fixture-secret'));
  process.env.PA_COMMERCIAL_OUTBOX_KEY='22'.repeat(32); assert.throws(()=>decryptSecret(envelope),/outbox_secret_invalid/);
  assert(calls.some(([name])=>name==='snapshot'));
  console.log('PASS PA-EST-004 HTTP/security: auth, origin, rate limit, action allow-list, no-store, secret envelope');
})().catch(error=>{console.error(error);process.exitCode=1;});

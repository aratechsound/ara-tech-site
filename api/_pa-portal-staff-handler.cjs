const staff = require('./_pa-portal-staff.cjs');
const { streamAttachmentResponse } = require('./_pa-gmail.cjs');
const { applyOriginPolicy, checkRateLimit } = require('./_request-security.cjs');
const COOKIE = 'ara_pa_staff_session';
const headers = response => {
  for (const [k,v] of Object.entries({ 'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })) response.setHeader(k,v);
};
const json = (r,s,p) => { r.setHeader('Content-Type','application/json; charset=utf-8'); return r.status(s).json(p); };
async function handleStaffPortal(request,response) {
  headers(response);
  if (request.method !== 'POST') { response.setHeader('Allow','POST'); return json(response,405,{ ok:false,code:'method_not_allowed' }); }
  if (!applyOriginPolicy(request,response)) return json(response,403,{ ok:false,code:'link_unavailable' });
  try {
    const input = typeof request.body === 'object' && !Buffer.isBuffer(request.body) ? request.body : JSON.parse(String(request.body || ''));
    if (!input || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input))>4096) throw new Error('invalid_input');
    if (!['exchange','read','download'].includes(input.action)) return json(response,403,{ ok:false,code:'not_permitted' });
    const allowedKeys = input.action === 'exchange' ? ['action','token'] : input.action === 'read' ? ['action'] : ['action','asset_ref','asset_kind'];
    if (Object.keys(input).some(k=>!allowedKeys.includes(k))) throw new Error('invalid_input');
    const rate = await checkRateLimit({request,policyName:input.action==='exchange'?'PA_STAFF_VERIFY':'PA_STAFF_READ'});
    if (!rate.allowed) { response.setHeader('Retry-After',String(Math.max(1,rate.retryAfter))); return json(response,429,{ok:false,code:'link_unavailable'}); }
    if (input.action==='exchange') {
      const result=await staff.exchange(input.token);
      const age=Math.max(1,Math.min(staff.SESSION_SECONDS,Math.floor((Date.parse(result.expiresAt)-Date.now())/1000)));
      response.setHeader('Set-Cookie',`${COOKIE}=${result.session}; Max-Age=${age}; Path=/api/staff-portal; HttpOnly; Secure; SameSite=Strict`);
      return json(response,200,{ok:true,result:{expires_at:result.expiresAt}});
    }
    const session=String(request.headers?.cookie || '').split(';').map(p=>p.trim().split('=')).find(([k])=>k===COOKIE)?.[1];
    if (!session) throw new Error('link_unavailable');
    if (input.action==='read') return json(response,200,{ok:true,result:await staff.read(session)});
    return streamAttachmentResponse(response,await staff.download({session,assetRef:input.asset_ref,kind:input.asset_kind}));
  } catch(error) {
    const code=error?.message;
    if (code==='link_unavailable') { response.setHeader('Set-Cookie',`${COOKIE}=; Max-Age=0; Path=/api/staff-portal; HttpOnly; Secure; SameSite=Strict`); return json(response,401,{ok:false,code}); }
    if (code==='asset_unavailable') return json(response,404,{ok:false,code});
    if (code==='invalid_input' || error instanceof SyntaxError) return json(response,400,{ok:false,code:'invalid_input'});
    // Never echo database errors, raw credentials, refs or request bodies.
    return json(response,503,{ok:false,code:'service_unavailable'});
  }
}
module.exports={handleStaffPortal,COOKIE};

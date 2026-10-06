// Adapt the existing authorized portalRequest; the server remains authority.
export function createStaffShareBridge(portalRequest) {
 const run=(grade,action)=>portalRequest('staff_link_'+action,{grade:grade.toUpperCase()});
 const state=value=>({status:value.active?'active':value.exists||value.revoked?'revoked':'none',url:value.active&&value.share_url?new URL(value.share_url,location.origin).href:''});
 return {async status(){const [g,t]=await Promise.all(['general','technical'].map(grade=>run(grade,'status')));return{general:state(g),technical:state(t)};},create:grade=>run(grade,'create'),rotate:grade=>run(grade,'rotate'),revoke:grade=>run(grade,'revoke')};
}

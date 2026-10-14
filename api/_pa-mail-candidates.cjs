'use strict';
const normalize=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g,'');
const address=value=>String(value||'').trim().toLowerCase();
function customerQuery(email){
  const value=address(email);
  if(!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value)||value.length>254)throw Error('customer_email_unavailable');
  return '{from:'+value+' to:'+value+'}';
}
function relatedToCase(inquiry,messages){
  const markers=[inquiry.inquiry_number,normalize(inquiry.event_name).replace(/(?:19|20)\d{2}年?/g,'')].map(normalize).filter(v=>v.length>=4);
  return messages.some(m=>markers.some(value=>normalize([m.subject,m.body_text,m.snippet].join('\n')).includes(value)));
}
function chooseCandidate({inquiry,caseIds,candidates,truncated}){
  if(truncated||caseIds.length!==1||caseIds[0]!==inquiry.id)return null;
  return candidates.filter(c=>c.address_match&&c.related&&!c.conflict&&!c.unknown&&Number.isFinite(Date.parse(c.latest_at))).sort((a,b)=>Date.parse(b.latest_at)-Date.parse(a.latest_at))[0]?.gmail_thread_id||null;
}
module.exports={customerQuery,relatedToCase,chooseCandidate,address};

export const openScheduleToken = rows => rows.find(token=>!token.revoked_at&&!token.answered_at) || null;
export const scheduleTokenUrl = token => 'https://ara-tech.cc/pa-schedule-confirm.html?token='+encodeURIComponent(token);
export function scheduleTokenSecret(){
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'');
}
export async function scheduleTokenRequest(client,{caseId,updatedAt,expectedToken,action,token=null,expiry=null}){
  const {data,error}=await client.rpc('pa_manage_schedule_token_v2',{
    p_inquiry_id:caseId,p_expected_updated_at:updatedAt,p_expected_token_id:expectedToken,
    p_action:action,p_token:token,p_expires_at:expiry
  });
  if(error||!data)throw Error('schedule_result_unknown');
  return data;
}

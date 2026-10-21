import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../js/supabase-config.js';
import {AUTH_OPTIONS,createWorkspaceAuth} from './auth-session.mjs';
import {completeGeneralCase} from './general-case-completion.mjs';
import {readPaCloseAuthority,savePaClose} from './pa-case-completion.mjs';
const client=createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:AUTH_OPTIONS});
export const workspaceAuth=createWorkspaceAuth(client);
export const saveGeneralCompletion=snapshot=>completeGeneralCase(client,workspaceAuth,snapshot);
async function paCompletionRequest(action,input){
 if(!['snapshot','close_case'].includes(action))throw Error('completion_unavailable');
 const s=await workspaceAuth.current();if(!s?.access_token)throw Error('login_required');
 const r=await fetch('/api/pa-mail?surface=commercial',{method:'POST',cache:'no-store',redirect:'error',headers:{authorization:'Bearer '+s.access_token,'content-type':'application/json'},body:JSON.stringify({...input,action})});
 const p=await r.json();if(!r.ok||p.ok!==true)throw Error('completion_unavailable');return p.result;
}
export const readPaCompletion=snapshot=>readPaCloseAuthority(client,workspaceAuth,snapshot,paCompletionRequest);
export const savePaCompletion=(snapshot,choice,authority,confirmed)=>savePaClose(client,workspaceAuth,snapshot,choice,authority,paCompletionRequest,confirmed);
export const readPaCompletionStatus=async id=>{const {data,error}=await client.from('pa_inquiries').select('id,status').eq('id',id).single();if(error||data?.id!==id)throw Error('completion_unavailable');return data;};
export function readUrl(path){if(!path.startsWith('/data/'))throw Error('read_route_refused');return '/api/pa-workspace-read?path='+encodeURIComponent(path);}
export function legacyUrl(caseId){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(caseId||''))throw Error('invalid_case');return '/pa-admin-legacy.html?case='+encodeURIComponent(caseId);}

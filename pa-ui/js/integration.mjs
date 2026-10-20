import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../js/supabase-config.js';
import {AUTH_OPTIONS,createWorkspaceAuth} from './auth-session.mjs';
import {completeGeneralCase} from './general-case-completion.mjs';
const client=createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:AUTH_OPTIONS});
export const workspaceAuth=createWorkspaceAuth(client);
export const saveGeneralCompletion=snapshot=>completeGeneralCase(client,workspaceAuth,snapshot);
export function readUrl(path){if(!path.startsWith('/data/'))throw Error('read_route_refused');return '/api/pa-workspace-read?path='+encodeURIComponent(path);}
export function legacyUrl(caseId){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(caseId||''))throw Error('invalid_case');return '/pa-admin-legacy.html?case='+encodeURIComponent(caseId);}

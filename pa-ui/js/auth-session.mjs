// Persistence and refresh belong to Supabase Auth; no password or token store here.
export const AUTH_OPTIONS=Object.freeze({persistSession:true,autoRefreshToken:true});
export const requiresReauthentication=(code,status)=>status===401||code==='admin_required';
export function createWorkspaceAuth(client,now=Date.now){
  function fresh(session){
    if(!session?.access_token||!session.user||!Number.isFinite(session.expires_at)||session.expires_at*1000<=now())throw Error('login_required');
    return session;
  }
  async function requireAdmin(session){
    if(!session)return null;
    fresh(session);
    const {data:user,error:authError}=await client.auth.getUser(session.access_token);
    if(authError||!user?.user||user.user.id!==session.user.id)throw Error('login_required');
    const {data,error}=await client.from('work_admins').select('user_id').eq('user_id',user.user.id).maybeSingle();
    if(error||!data||data.user_id!==user.user.id)throw Error('admin_required');
    return session;
  }
  async function current(){const {data,error}=await client.auth.getSession();if(error)throw error;return fresh(data.session);}
  return {
    async login(email,password){const {data,error}=await client.auth.signInWithPassword({email,password});if(error)throw error;return requireAdmin(fresh(data.session));},
    async restore(){const {data,error}=await client.auth.getSession();if(error)throw error;return requireAdmin(data.session);},
    current,
    async logout(){const {error}=await client.auth.signOut({scope:'local'});if(error)throw error;},
    subscribe(callback){return client.auth.onAuthStateChange((event,session)=>{queueMicrotask(()=>callback(event,session));}).data.subscription;}
  };
}

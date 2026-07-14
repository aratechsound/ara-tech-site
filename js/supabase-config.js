// Supabaseの「Project URL」と「Publishable / anon key」を設定してください。
// service_role keyなどの管理者用シークレットは、絶対にここへ記載しないでください。
export const SUPABASE_URL = 'https://kogbnremsouajxxsgxro.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_nGgPKpwiePrFS_vH8lPpVg_0I1HGGaS';
export const WORKS_BUCKET = 'work-flyers';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

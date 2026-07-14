// Supabaseの「Project URL」と「Publishable / anon key」を設定してください。
// service_role keyなどの管理者用シークレットは、絶対にここへ記載しないでください。
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
export const WORKS_BUCKET = 'work-flyers';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

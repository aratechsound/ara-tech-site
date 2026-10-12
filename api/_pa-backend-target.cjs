'use strict';
const DEFAULT_SUPABASE_URL = 'https://kogbnremsouajxxsgxro.supabase.co';
// Shared by the commercial backend and the read-only release diagnostic.
// Preserve the existing commercial resolver exactly; do not read a credential.
const resolveSupabaseUrl = (env = process.env) =>
  String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/u, '');
module.exports = {DEFAULT_SUPABASE_URL, resolveSupabaseUrl};

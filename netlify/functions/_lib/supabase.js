const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

/**
 * Server-side Supabase client using the SERVICE ROLE key.
 * This key bypasses Row Level Security, which is exactly why it must
 * only ever be used here, inside a Netlify Function — never sent to
 * the browser. The browser only ever talks to our functions, never
 * to Supabase directly.
 */
function getSupabase() {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  }
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

module.exports = { getSupabase };

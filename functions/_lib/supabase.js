import { createClient } from "@supabase/supabase-js";

export function getSupabase(env) {
  const url = env && env.SUPABASE_URL;
  const key = env && env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment secrets."
    );
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

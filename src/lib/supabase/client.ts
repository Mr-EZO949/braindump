import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient() {
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  if (!browserClient) {
    browserClient = createBrowserClient(supabaseUrl, supabaseKey);
  }

  return browserClient;
}

export const supabase = getSupabaseBrowserClient();

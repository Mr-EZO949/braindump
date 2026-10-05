// Where standing preferences live (docs/preferences.md): the user's Supabase
// auth user_metadata, under one key — no table, no migration. Server only:
// writes go through the service-role admin API (the chat stream can't set
// session cookies mid-response); GoTrue merges user_metadata by key, so the
// auto-add switch and anything else stored there are left alone.

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { PREFERENCES_METADATA_KEY, preferencesFromMetadata, type Preference } from "./preferences";

/** The user's saved list, fresh from the auth server. Fail-soft: [] on error. */
export async function loadPreferences(userId: string, supabase?: SupabaseClient): Promise<Preference[]> {
  try {
    const admin = getSupabaseAdminClient();
    if (admin) {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (!error && data.user) return preferencesFromMetadata(data.user.user_metadata);
    }
    if (supabase) {
      const { data } = await supabase.auth.getUser();
      if (data.user?.id === userId) return preferencesFromMetadata(data.user.user_metadata);
    }
  } catch {
    // fall through
  }
  return [];
}

export async function savePreferences(
  userId: string,
  list: Preference[],
  supabase?: SupabaseClient,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const admin = getSupabaseAdminClient();
    if (admin) {
      const { error } = await admin.auth.admin.updateUserById(userId, {
        user_metadata: { [PREFERENCES_METADATA_KEY]: list },
      });
      return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (supabase) {
      const { error } = await supabase.auth.updateUser({ data: { [PREFERENCES_METADATA_KEY]: list } });
      return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: "no auth client" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// POST /api/account/delete
// Permanently deletes the signed-in user's account and ALL their data.
//
// Every application table has `user_id ... references auth.users (id) on
// delete cascade`, so removing the auth user removes every row the user
// owns across all 29 tables in a single DB-level cascade. This is
// irreversible.

import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Account deletion is temporarily unavailable. Please contact support." },
      { status: 500 },
    );
  }

  // Deleting the auth user cascades to every user-owned row via FK
  // ON DELETE CASCADE. No manual per-table cleanup needed.
  const { error } = await admin.auth.admin.deleteUser(user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}

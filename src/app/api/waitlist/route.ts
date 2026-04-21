// POST /api/waitlist — public waitlist signup.
// Unauthenticated endpoint. Writes go through the service-role client since
// anon cannot insert into a table with no RLS policies.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;
const MAX_NOTE_LEN = 500;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const note =
    typeof raw.note === "string" && raw.note.trim().length > 0
      ? raw.note.trim().slice(0, MAX_NOTE_LEN)
      : null;
  const source = typeof raw.source === "string" ? raw.source.slice(0, 64) : "landing";

  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email." }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  const { error } = await admin.from("waitlist").insert({
    email,
    note,
    source,
    user_agent: userAgent,
  });

  if (error) {
    // 23505 = unique_violation — treat a duplicate email as a success from the
    // user's perspective so we don't leak whether an address is on the list.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, already: true });
    }
    console.error("waitlist insert failed", error);
    return NextResponse.json({ error: "Could not save. Try again in a minute." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

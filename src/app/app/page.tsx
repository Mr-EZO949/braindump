import { redirect } from "next/navigation";

import { AppShell } from "@/components/ui/app-shell";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function AppRoutePage() {
  const supabase = await getSupabaseServerClient();
  // getClaims() verifies the session JWT locally (cached ES256 keys) instead of
  // a Supabase Auth round trip before the first byte of the app. It only seeds
  // the shell; every data read is still enforced by RLS on the JWT.
  const { data } = supabase ? await supabase.auth.getClaims() : { data: null };
  const claims = data?.claims;

  if (!claims?.sub) {
    redirect("/login");
  }

  return (
    <AppShell
      initialUser={{
        email: typeof claims.email === "string" ? claims.email : null,
        id: claims.sub,
      }}
    />
  );
}

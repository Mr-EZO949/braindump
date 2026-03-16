import { redirect } from "next/navigation";

import { AppShell } from "@/components/ui/app-shell";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function AppRoutePage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  if (!user) {
    redirect("/login");
  }

  return <AppShell initialUser={{ email: user.email ?? null, id: user.id }} />;
}

import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  redirect(user ? "/app" : "/login");
}

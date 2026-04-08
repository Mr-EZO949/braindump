import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import LandingPage from "@/components/landing/landing-page";

export default async function Home() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  if (user) redirect("/app");

  return <LandingPage />;
}

import { redirect } from "next/navigation";
import { Instrument_Serif } from "next/font/google";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import LandingPage from "@/components/landing/landing-page";

// Cursive display serif for the hero headline (app UI stays sans).
const displaySerif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export default async function Home() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  if (user) redirect("/app");

  return (
    <div className={displaySerif.variable}>
      <LandingPage />
    </div>
  );
}

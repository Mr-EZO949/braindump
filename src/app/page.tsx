import { redirect } from "next/navigation";
import { Instrument_Serif } from "next/font/google";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import LandingPage from "@/components/landing/landing-page";

// Display face for the landing hero only — an editorial serif with real
// character (the app UI itself stays on the sans). Loaded here (server
// component) and passed down as a CSS variable.
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

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ReadingView } from "@/components/reading/reading-view";
import { getReadingViewData } from "@/lib/graph/reading-view";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ nodeId: string }>;
}): Promise<Metadata> {
  const { nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { title: "BrainDump" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { title: "BrainDump" };

  const { data } = await supabase
    .from("nodes")
    .select("title")
    .eq("user_id", user.id)
    .eq("id", nodeId)
    .maybeSingle();

  const title = (data as { title?: string } | null)?.title;
  return { title: title ? `${title} — BrainDump` : "BrainDump" };
}

export default async function NodeReadingPage({
  params,
}: {
  params: Promise<{ nodeId: string }>;
}) {
  const { nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    redirect("/login");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const data = await getReadingViewData(supabase, user.id, nodeId);
  if (!data) {
    notFound();
  }

  return <ReadingView data={data} exitHref="/app" />;
}

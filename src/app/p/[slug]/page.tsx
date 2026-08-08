import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicBanner } from "@/components/reading/public-banner";
import { ReadingView } from "@/components/reading/reading-view";
import { getPublicReadingViewData } from "@/lib/graph/reading-view";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { title: "BrainDump" };

  const data = await getPublicReadingViewData(supabase, slug);
  if (!data) return { title: "Shared graph — BrainDump" };

  const title = `${data.node.title} · ${data.workspace?.name ?? "BrainDump"}`;
  const description = data.node.summary ?? undefined;
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicGraphLanding({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) notFound();

  const data = await getPublicReadingViewData(supabase, slug);
  if (!data) notFound();

  return (
    <ReadingView
      data={data}
      editable={false}
      showOrderLink={false}
      nodeHref={(id) => `/p/${slug}/${id}`}
      minimapHref={`/p/${slug}`}
      topSlot={
        <PublicBanner slug={slug} workspaceName={data.workspace?.name ?? "Shared graph"} />
      }
    />
  );
}

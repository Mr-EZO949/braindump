import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicBanner } from "@/components/reading/public-banner";
import { ReadingView } from "@/components/reading/reading-view";
import { getPublicReadingViewData } from "@/lib/graph/reading-view";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; nodeId: string }>;
}): Promise<Metadata> {
  const { slug, nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { title: "BrainDump" };

  const data = await getPublicReadingViewData(supabase, slug, nodeId);
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

export default async function PublicGraphNode({
  params,
}: {
  params: Promise<{ slug: string; nodeId: string }>;
}) {
  const { slug, nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) notFound();

  const data = await getPublicReadingViewData(supabase, slug, nodeId);
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

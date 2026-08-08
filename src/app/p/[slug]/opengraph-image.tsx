import { ImageResponse } from "next/og";

import { getPublicReadingViewData } from "@/lib/graph/reading-view";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "A BrainDump graph";

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await getSupabaseServerClient();
  const data = supabase ? await getPublicReadingViewData(supabase, slug) : null;

  const workspaceName = data?.workspace?.name ?? "Shared graph";
  const nodeTitle = data?.node.title ?? "BrainDump";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0b0d",
          padding: "72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{ width: "18px", height: "18px", borderRadius: "9px", background: "#d53a47" }}
          />
          <div
            style={{
              color: "#928b85",
              fontSize: "26px",
              letterSpacing: "4px",
              textTransform: "uppercase",
            }}
          >
            BrainDump · {workspaceName}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            color: "#f2efe9",
            fontSize: "76px",
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-2px",
          }}
        >
          {nodeTitle.length > 90 ? `${nodeTitle.slice(0, 87)}…` : nodeTitle}
        </div>

        <div style={{ color: "#6f6964", fontSize: "28px" }}>
          Read this graph as a document →
        </div>
      </div>
    ),
    size,
  );
}

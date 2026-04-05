import { NextRequest, NextResponse } from "next/server";

import { AI_JOBS } from "@/lib/ai/config";
import { drainAIJobsWithAdminClient } from "@/lib/ai/jobs";

function getBearerToken(request: NextRequest) {
  const header = request.headers.get("authorization");

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.AI_JOB_RUNNER_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { error: "AI_JOB_RUNNER_SECRET is not configured" },
      { status: 503 },
    );
  }

  const token = getBearerToken(req);
  if (token !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let limit: number = AI_JOBS.BATCH_SIZE;
  try {
    const body = (await req.json()) as { limit?: number };
    if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
      limit = Math.min(50, Math.max(1, Math.floor(body.limit)));
    }
  } catch {
    // Empty body is allowed; default batch size is used.
  }

  const result = await drainAIJobsWithAdminClient({ limit });
  if (!result) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 },
    );
  }

  return NextResponse.json(result);
}

// POST /api/images
// Accepts a single image (multipart/form-data: `file`, optional `nodeId`),
// resizes + converts it to web-optimised webp server-side (aspect ratio
// preserved), uploads it to the node-images bucket under the caller's own
// folder, and returns the public URL to drop into the markdown body as an
// image. Storage RLS enforces that a user can only write under <their uid>/…

import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Column-width images never need more than ~1600px even on retina displays.
const MAX_WIDTH = 1600;
const WEBP_QUALITY = 82;
// Pre-resize upload ceiling. The stored (resized) object is far smaller.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "File must be an image" }, { status: 415 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "Image is too large (max 15 MB)" }, { status: 413 });
  }

  const nodeIdRaw = form.get("nodeId");
  const nodeId =
    typeof nodeIdRaw === "string" && /^[0-9a-f-]{36}$/i.test(nodeIdRaw) ? nodeIdRaw : "misc";

  let webp: Buffer;
  try {
    webp = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate() // honour EXIF orientation
      .resize({ width: MAX_WIDTH, withoutEnlargement: true }) // keep aspect ratio
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "Could not process that image" }, { status: 422 });
  }

  const path = `${user.id}/${nodeId}/${crypto.randomUUID()}.webp`;

  const { error: uploadError } = await supabase.storage
    .from("node-images")
    .upload(path, webp, { contentType: "image/webp", upsert: false });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("node-images").getPublicUrl(path);

  return NextResponse.json({ url: publicUrl });
}

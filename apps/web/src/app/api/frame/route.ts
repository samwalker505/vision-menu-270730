import { NextResponse } from "next/server";
import { getFrameStore } from "@/lib/frame-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FRAME_BYTES = 200_000;

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("image/jpeg") && !contentType.includes("application/octet-stream")) {
    return NextResponse.json(
      { error: "Expected Content-Type: image/jpeg" },
      { status: 415 },
    );
  }

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length < 4 || bytes.length > MAX_FRAME_BYTES) {
    return NextResponse.json({ error: "Invalid JPEG size" }, { status: 400 });
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return NextResponse.json({ error: "Not a JPEG" }, { status: 400 });
  }

  getFrameStore().setFrame(bytes);
  return new Response(null, { status: 204 });
}

import { IngestPayloadSchema } from "@repo/shared";
import { NextResponse } from "next/server";
import { getVisionStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = IngestPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  getVisionStore().ingest(parsed.data);
  // Keep the response tiny — firmware streams at high cadence and must not
  // download the last JPEG back on every POST.
  return NextResponse.json({ ok: true });
}

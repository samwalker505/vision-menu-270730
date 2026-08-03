import { NextResponse } from "next/server";
import { getOfferStore } from "@/lib/offer-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Snapshot of the current guest offer + ePaper command (for debugging). */
export async function GET() {
  const snapshot = getOfferStore().getSnapshot();
  return NextResponse.json(snapshot);
}

/**
 * Manually claim a promo (simulates the panel "Show my offer" button).
 * Pushes code + QR to connected ePaper clients for 60s, then welcome.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
  };
  const store = getOfferStore();

  if (body.action === "dismiss") {
    return NextResponse.json(store.dismiss());
  }
  if (body.action === "welcome") {
    return NextResponse.json(store.returnToWelcome());
  }
  if (body.action === "eligible") {
    const snapshot = store.markEligible() ?? store.getSnapshot();
    return NextResponse.json(snapshot);
  }

  const snapshot = await store.claim();
  return NextResponse.json(snapshot);
}

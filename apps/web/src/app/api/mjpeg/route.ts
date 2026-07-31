import { getFrameStore } from "@/lib/frame-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOUNDARY = "visionframe";
const encoder = new TextEncoder();
const PART_END = encoder.encode("\r\n");

function partHeader(length: number): Uint8Array {
  return encoder.encode(
    `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`,
  );
}

export async function GET() {
  const store = getFrameStore();
  let unsubscribe: (() => void) | null = null;
  let lastSeq = -1;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (frame: Buffer, seq: number) => {
        if (seq === lastSeq) return;
        lastSeq = seq;
        try {
          controller.enqueue(partHeader(frame.length));
          controller.enqueue(new Uint8Array(frame));
          controller.enqueue(PART_END);
        } catch {
          // Client disconnected mid-write.
        }
      };

      const latest = store.getFrame();
      if (latest) {
        push(latest, store.getSeq());
      }

      unsubscribe = store.subscribe(push);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

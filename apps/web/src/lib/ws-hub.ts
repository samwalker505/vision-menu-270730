import { Buffer } from "node:buffer";
import { WebSocketServer, type WebSocket } from "ws";
import { IngestPayloadSchema, type PanelState } from "@repo/shared";
import { getFrameStore } from "@/lib/frame-store";
import { getVisionStore } from "@/lib/store";

const WS_PORT = Number(process.env.VISION_WS_PORT ?? 3001);

declare global {
  var __visionMenuWsHubStarted: boolean | undefined;
}

function broadcast(
  wss: WebSocketServer,
  data: Buffer | string,
  except?: WebSocket,
) {
  for (const client of wss.clients) {
    if (client === except) continue;
    if (client.readyState !== client.OPEN) continue;
    client.send(data);
  }
}

function sendState(client: WebSocket, state: PanelState) {
  if (client.readyState !== client.OPEN) return;
  client.send(
    JSON.stringify({
      type: "state",
      state: { ...state, imageBase64: null },
    }),
  );
}

export function startVisionWsHub() {
  if (globalThis.__visionMenuWsHubStarted) {
    return;
  }
  globalThis.__visionMenuWsHubStarted = true;

  const frameStore = getFrameStore();
  const visionStore = getVisionStore();

  const wss = new WebSocketServer({
    host: "0.0.0.0",
    port: WS_PORT,
    perMessageDeflate: false,
  });

  console.log(`[vision-ws] listening on ws://0.0.0.0:${WS_PORT}`);

  // Push stillness heartbeats so stillMs counts up smoothly in the UI.
  setInterval(() => {
    const state = visionStore.getState();
    const payload = JSON.stringify({
      type: "state",
      state: { ...state, imageBase64: null },
    });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }, 200);

  wss.on("connection", (socket) => {
    sendState(socket, visionStore.getState());
    const latest = frameStore.getFrame();
    if (latest) {
      socket.send(latest);
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) {
          return;
        }
        frameStore.setFrame(frame);
        broadcast(wss, frame, socket);
        return;
      }

      const text = typeof data === "string" ? data : data.toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return;
      }

      // Browser hello / ignore non-ingest messages.
      if (
        body &&
        typeof body === "object" &&
        "type" in body &&
        (body as { type: string }).type === "hello"
      ) {
        sendState(socket, visionStore.getState());
        return;
      }

      const parsed = IngestPayloadSchema.safeParse(body);
      if (!parsed.success) {
        return;
      }

      const state = visionStore.ingest(parsed.data);
      const payload = JSON.stringify({
        type: "state",
        state: { ...state, imageBase64: null },
      });
      broadcast(wss, payload);
    });
  });

  wss.on("error", (err) => {
    console.error("[vision-ws] error", err);
  });
}

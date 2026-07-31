import { Buffer } from "node:buffer";
import { WebSocketServer, type WebSocket } from "ws";
import {
  IngestPayloadSchema,
  OFFER_ELIGIBLE_MS,
  type EpaperCommand,
  type OfferState,
  type PanelState,
} from "@repo/shared";
import { getFrameStore } from "@/lib/frame-store";
import { getOfferStore, type OfferSnapshot } from "@/lib/offer-store";
import { getVisionStore } from "@/lib/store";

const WS_PORT = Number(process.env.VISION_WS_PORT ?? 3001);

type ClientRole = "browser" | "epaper" | "camera" | "unknown";

type TrackedSocket = WebSocket & { __role?: ClientRole };

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

function broadcastOfferSnapshot(wss: WebSocketServer, snapshot: OfferSnapshot) {
  const offerPayload = JSON.stringify({ type: "offer", offer: snapshot.offer });
  const epaperPayload = JSON.stringify(snapshot.epaper);

  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    const tracked = client as TrackedSocket;
    if (tracked.__role === "epaper") {
      client.send(epaperPayload);
    } else {
      // Browsers, cameras, and unknown clients get offer state (cameras ignore it).
      client.send(offerPayload);
    }
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

function sendOffer(client: WebSocket, offer: OfferState) {
  if (client.readyState !== client.OPEN) return;
  client.send(JSON.stringify({ type: "offer", offer }));
}

function sendEpaper(client: WebSocket, epaper: EpaperCommand) {
  if (client.readyState !== client.OPEN) return;
  client.send(JSON.stringify(epaper));
}

export function startVisionWsHub() {
  if (globalThis.__visionMenuWsHubStarted) {
    return;
  }
  globalThis.__visionMenuWsHubStarted = true;

  const frameStore = getFrameStore();
  const visionStore = getVisionStore();
  const offerStore = getOfferStore();

  const wss = new WebSocketServer({
    host: "0.0.0.0",
    port: WS_PORT,
    perMessageDeflate: false,
  });

  console.log(`[vision-ws] listening on ws://0.0.0.0:${WS_PORT}`);

  let presentSince: number | null = null;
  let lastHumanPresent = false;

  offerStore.subscribe((snapshot) => {
    broadcastOfferSnapshot(wss, snapshot);
  });

  // Push stillness heartbeats so stillMs counts up smoothly in the UI.
  // Also drives offer eligibility from continuous vision presence.
  setInterval(() => {
    const state = visionStore.getState();
    const now = Date.now();

    if (state.humanPresent) {
      if (!lastHumanPresent) {
        presentSince = now;
        lastHumanPresent = true;
      }
      if (
        presentSince !== null &&
        now - presentSince >= OFFER_ELIGIBLE_MS &&
        offerStore.getOffer().phase === "idle"
      ) {
        offerStore.markEligible(now);
      }
    } else if (lastHumanPresent) {
      lastHumanPresent = false;
      presentSince = null;
      offerStore.setPresence(false, now);
    }

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
    const tracked = socket as TrackedSocket;
    tracked.__role = "unknown";

    sendState(socket, visionStore.getState());
    sendOffer(socket, offerStore.getOffer());
    const latest = frameStore.getFrame();
    if (latest) {
      socket.send(latest);
    }

    socket.on("message", async (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) {
          return;
        }
        tracked.__role = "camera";
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

      if (body && typeof body === "object" && "type" in body) {
        const msg = body as { type: string; role?: string };

        if (msg.type === "hello") {
          const role = msg.role;
          if (role === "browser" || role === "epaper" || role === "camera") {
            tracked.__role = role;
          }
          sendState(socket, visionStore.getState());
          sendOffer(socket, offerStore.getOffer());
          if (tracked.__role === "epaper") {
            sendEpaper(socket, offerStore.getEpaperCommand());
          }
          return;
        }

        if (msg.type === "claim_offer") {
          if (tracked.__role === "unknown") tracked.__role = "browser";
          try {
            await offerStore.claim();
          } catch (err) {
            console.error("[vision-ws] claim_offer failed", err);
          }
          return;
        }

        if (msg.type === "dismiss_offer") {
          if (tracked.__role === "unknown") tracked.__role = "browser";
          offerStore.dismiss();
          return;
        }
      }

      const parsed = IngestPayloadSchema.safeParse(body);
      if (!parsed.success) {
        return;
      }

      tracked.__role = "camera";
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

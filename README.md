# Vision Menu

Monorepo for a **XIAO Vision AI Camera** + **Next.js** web panel + **EE04 ePaper** counter display. The camera runs SenseCraft person detection on-device; the web backend computes **stillness**, offers a guest promo after sustained presence, and pushes the claimed code + QR to the ePaper for one minute.

## Architecture

```
Grove Vision AI V2  --I2C/SSCMA-->  XIAO ESP32-C3  --WebSocket-->  Next.js ws-hub :3001
                                                                      |
                                                               Stillness + offer engine
                                                                      |
                    +--------------------------+----------------------+
                    |                          |                      |
              WS state/frames            WS offer              WS epaper cmd
                    |                          |                      |
               Web panel                  claim_offer           XIAO EE04 ePaper
                                                         (QR + code for 60s → welcome)
```

| Path | Role |
|------|------|
| `apps/web` | Next.js panel + WS hub + offer API |
| `packages/shared` | Shared Zod schemas / types |
| `firmware/xiao-vision` | PlatformIO firmware for ESP32-C3 |
| `firmware/xiao-epaper` | EE04 + 5.83" ePaper promo / welcome display |

## Guest offer flow

1. Vision streams detections over WebSocket.
2. After ~5s continuous human presence, the hub marks the offer **prompt**-ready and the web panel asks to claim.
3. “Show my offer” (or `POST /api/offer`) generates `VISION-{10–20}OFF`, a QR matrix, and pushes `{ type: "epaper", mode: "promo", ... }` to connected ePaper clients.
4. After **60 seconds** the hub (and the device’s local fallback) return the ePaper to a **welcome** message.

## Quick start (web)

```bash
pnpm install
pnpm --filter @repo/shared build
pnpm --filter web dev
```

Open [http://localhost:3000](http://localhost:3000).

### Simulate a camera (no hardware)

```bash
# Moving person (menu stays locked)
curl -s -X POST http://localhost:3000/api/ingest \
  -H 'content-type: application/json' \
  -d '{"deviceId":"sim","ts":'"$(($(date +%s%3N)))"',"width":240,"height":240,"boxes":[{"target":0,"score":0.9,"x":40,"y":40,"w":80,"h":120}]}'

# Hold still: POST the same box several times over ~3s
for i in 1 2 3 4 5 6 7 8; do
  curl -s -X POST http://localhost:3000/api/ingest \
    -H 'content-type: application/json' \
    -d '{"deviceId":"sim","ts":'"$(($(date +%s%3N)))"',"width":240,"height":240,"boxes":[{"target":0,"score":0.92,"x":100,"y":80,"w":70,"h":130}]}'
  sleep 0.35
done
```

### Simulate claiming an offer (pushes to ePaper)

```bash
# Optional: mark eligible without waiting for vision
curl -s -X POST http://localhost:3000/api/offer \
  -H 'content-type: application/json' \
  -d '{"action":"eligible"}'

# Claim — generates code + QR and broadcasts to ePaper clients
curl -s -X POST http://localhost:3000/api/offer \
  -H 'content-type: application/json' \
  -d '{}'

# Inspect current offer / ePaper command
curl -s http://localhost:3000/api/offer | jq .
```

## Hardware setup

### Vision camera

1. In [SenseCraft AI](https://sensecraft.seeed.cc/ai/model), deploy a **Person Detection** model to the Grove Vision AI V2.
2. Configure firmware secrets:

```bash
cp firmware/xiao-vision/include/secrets.h.example firmware/xiao-vision/include/secrets.h
```

Set Wi-Fi credentials and `WS_HOST` to your computer’s LAN IP (hub port `3001`).

3. Flash:

```bash
cd firmware/xiao-vision
pio run -t upload && pio device monitor
```

See [firmware/xiao-vision/README.md](firmware/xiao-vision/README.md).

### Counter ePaper

```bash
cp firmware/xiao-epaper/include/secrets.h.example firmware/xiao-epaper/include/secrets.h
# Same Wi-Fi + WS_HOST as the vision board
cd firmware/xiao-epaper
pio run -t upload && pio device monitor
```

See [firmware/xiao-epaper/README.md](firmware/xiao-epaper/README.md).

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest` | Camera detection payload (`IngestPayload`) |
| `GET` | `/api/state` | Latest `PanelState` snapshot |
| `GET` | `/api/events` | SSE stream of `PanelState` |
| `GET` | `/api/offer` | Current offer + ePaper command snapshot |
| `POST` | `/api/offer` | Claim promo (`{}`), or `{ "action": "eligible" \| "dismiss" \| "welcome" }` |

Stillness is evaluated server-side from bounding-box motion. Guest offer eligibility uses continuous `humanPresent` (~5s). Live UI + devices use the WebSocket hub on port **3001**.

## Notes

- v1 keeps state **in-memory** (fine for a single `next dev` / single Node process on a LAN). Multi-instance production needs a shared store (e.g. Redis).
- Do not expose `/api/ingest` or `/api/offer` to the public internet without authentication.
- MQTT / SenseCraft cloud output is a possible later transport; WebSocket is the live path.

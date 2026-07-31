# Vision Menu

Monorepo for a **XIAO Vision AI Camera** + **Next.js** web panel. The camera runs SenseCraft person detection on-device; the web backend computes **stillness** and unlocks a digital menu when someone stands still in frame.

## Architecture

```
Grove Vision AI V2  --I2C/SSCMA-->  XIAO ESP32-C3  --HTTP POST-->  Next.js /api/ingest
                                                                      |
                                                               Stillness engine
                                                                      |
                                                         SSE /api/events --> Web panel
```

| Path | Role |
|------|------|
| `apps/web` | Next.js panel (dashboard + still-unlocked menu) |
| `packages/shared` | Shared Zod schemas / types |
| `firmware/xiao-vision` | PlatformIO firmware for ESP32-C3 |
| `firmware/xiao-epaper` | EE04 + 5.83" ePaper hardware smoke-test demo |

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

## Hardware setup

1. In [SenseCraft AI](https://sensecraft.seeed.cc/ai/model), deploy a **Person Detection** model to the Grove Vision AI V2 (device: XIAO Vision AI Camera / Grove Vision AI V2).
2. Configure firmware secrets:

```bash
cp firmware/xiao-vision/include/secrets.h.example firmware/xiao-vision/include/secrets.h
```

Set Wi-Fi credentials and `INGEST_URL` to your computer’s LAN IP, e.g. `http://192.168.1.42:3000/api/ingest`.

3. Flash:

```bash
cd firmware/xiao-vision
pio run -t upload && pio device monitor
```

See [firmware/xiao-vision/README.md](firmware/xiao-vision/README.md) for details.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest` | Camera detection payload (`IngestPayload`) |
| `GET` | `/api/state` | Latest `PanelState` snapshot |
| `GET` | `/api/events` | SSE stream of `PanelState` |

Stillness is evaluated server-side from a ~2s sliding window of bounding-box centroids/areas. The menu unlocks after ~1s of continuous stillness.

## Notes

- v1 keeps state **in-memory** (fine for a single `next dev` / single Node process on a LAN). Multi-instance production needs a shared store (e.g. Redis).
- Do not expose `/api/ingest` to the public internet without authentication.
- MQTT / SenseCraft cloud output is a possible later transport; HTTP is the v1 path.

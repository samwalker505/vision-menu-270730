# Vision Menu firmware (XIAO Vision AI Camera)

Arduino / PlatformIO sketch for the **XIAO ESP32-C3** on the XIAO Vision AI Camera. It reads person detections from the **Grove Vision AI V2** via SSCMA and POSTs JSON to the Next.js ingest API.

## Prerequisites

1. Deploy a **Person Detection** model to Grove Vision AI V2 via [SenseCraft AI](https://sensecraft.seeed.cc/ai/model).
2. Install [PlatformIO](https://platformio.org/) (CLI or VS Code extension).
3. Next.js panel running on your LAN (`pnpm --filter web dev`).

## Configure

```bash
cp include/secrets.h.example include/secrets.h
```

Edit `include/secrets.h`:

- `WIFI_SSID` / `WIFI_PASSWORD`
- `INGEST_URL` — e.g. `http://192.168.1.42:3000/api/ingest` (use your computer's LAN IP)
- `DEVICE_ID` — unique camera name

## Build & flash

```bash
cd firmware/xiao-vision
pio run -t upload
pio device monitor
```

## Payload

```json
{
  "deviceId": "xiao-vision-01",
  "ts": 123456,
  "width": 240,
  "height": 240,
  "boxes": [{ "target": 0, "score": 82.5, "x": 40, "y": 20, "w": 80, "h": 140 }],
  "imageBase64": optional JPEG every ~1.5s
}
```

Scores may be 0–100 (SenseCraft); the web backend normalizes to 0–1.

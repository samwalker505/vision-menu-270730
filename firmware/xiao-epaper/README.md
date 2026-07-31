# EE04 ePaper — Vision Menu promo display

Firmware for:

- **XIAO ePaper Display Board EE04** (ESP32-S3)
- **5.83" monochrome ePaper** — 648×480, SPI, UC8179

Connects to the same WebSocket hub as the vision camera and web panel (`VISION_WS_PORT`, default `3001`).

## Behavior

| Mode | When | Screen |
| --- | --- | --- |
| Welcome | Boot / after promo expires | “Welcome · Vision Menu” |
| Promo | Panel guest claim / `POST /api/offer` | Discount %, code, QR — ~60 seconds |

Flow:

1. Vision detects a guest → hub marks offer eligible after ~5s presence.
2. Web panel shows “Show my offer”.
3. On claim, the hub generates `VISION-{pct}OFF` + a packed QR matrix and pushes `{ type: "epaper", mode: "promo", ... }` to this device.
4. After 60s the hub pushes `mode: "welcome"` (device also has a local 60s fallback).

## Setup

```bash
cp include/secrets.h.example include/secrets.h
# Edit WIFI_SSID, WIFI_PASSWORD, WS_HOST (LAN IP of the Next.js host)
```

```bash
cd firmware/xiao-epaper
pio run -t upload
pio device monitor
```

Board target: `seeed_xiao_esp32s3` · monitor 115200.

## Hardware checklist

1. Seat the 5.83" panel FPC fully in the EE04 connector.
2. Power the EE04 over USB-C (or battery with the board power switch on).
3. Same Wi-Fi LAN as the machine running `pnpm --filter web dev`.

`include/driver.h` is the Seeed GFX config for this combo (`BOARD_SCREEN_COMBO 503`).

## Library

Uses [Seeed_GFX](https://github.com/Seeed-Studio/Seeed_GFX), ArduinoJson, and WebSockets via PlatformIO `lib_deps`.

## Docs

- [EE04 PlatformIO cookbook](https://wiki.seeedstudio.com/ee04_with_platformio/)
- [EE04 + EEZ Studio (5.83" notes)](https://wiki.seeedstudio.com/epaper_ee04_eezstudio/)

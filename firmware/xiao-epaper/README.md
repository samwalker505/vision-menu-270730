# EE04 ePaper hardware demo

Smoke-test firmware for:

- **XIAO ePaper Display Board EE04** (ESP32-S3)
- **5.83" monochrome ePaper** — 648×480, SPI, UC8179

If the hardware is wired and powered correctly you should see a test pattern on the panel and PASS lines on Serial.

## Hardware checklist

1. Seat the 5.83" panel FPC fully in the EE04 connector (contacts orientation per Seeed wiki).
2. Power the EE04 over USB-C (or battery with the board power switch on).
3. Connect USB to the host for flash + Serial.

## Build & flash

```bash
cd firmware/xiao-epaper
pio run -t upload
pio device monitor
```

Board target: `seeed_xiao_esp32s3` · monitor 115200.

## What the demo verifies

| Check | Expected |
| --- | --- |
| Panel init | Serial: `[PASS] Panel size matches 648x480` |
| SPI / refresh | Bordered pattern, corner shapes, “EE04 HW CHECK” text |
| Buttons KEY0/1/2 (GPIO 2/3/5) | Serial press/release + on-screen press counter |
| Battery ADC (A0 / enable GPIO6) | Voltage printed every 5s |

`include/driver.h` is the Seeed GFX config for this combo:

```cpp
#define BOARD_SCREEN_COMBO 503 // 5.83" mono UC8179
#define USE_XIAO_EPAPER_DISPLAY_BOARD_EE04
```

Regenerate from the [Seeed GFX Configuration Tool](https://seeed-studio.github.io/Seeed_GFX/) if you swap screens.

## Library

Uses [Seeed_GFX](https://github.com/Seeed-Studio/Seeed_GFX) via PlatformIO `lib_deps` (do not also install plain `TFT_eSPI` in this env).

## Docs

- [EE04 PlatformIO cookbook](https://wiki.seeedstudio.com/ee04_with_platformio/)
- [EE04 + EEZ Studio (5.83" notes)](https://wiki.seeedstudio.com/epaper_ee04_eezstudio/)

#include <Arduino.h>
#include <Seeed_Arduino_SSCMA.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <mbedtls/base64.h>

#include "secrets.h"

#ifndef VISION_MENU_SECRETS_H
#error "Copy include/secrets.h.example to src/secrets.h and configure Wi-Fi + WS_HOST"
#endif

SSCMA AI;
WebSocketsClient webSocket;

static const int FRAME_WIDTH = 240;
static const int FRAME_HEIGHT = 240;

static const uint8_t MIN_SCORE = 25; // percent; also accepts 0–1 scores from some face models

bool scorePasses(float score) {
  // SenseCraft may report confidence as 0–100 or 0–1 depending on model.
  if (score > 1.0f) {
    return score >= static_cast<float>(MIN_SCORE);
  }
  return score >= static_cast<float>(MIN_SCORE) / 100.0f;
}
static const uint32_t INVOKE_INTERVAL_MS = 80;
static const uint32_t IMAGE_INTERVAL_MS = 300;
static const uint32_t WIFI_RETRY_MS = 5000;

static const size_t JPEG_BUF_SIZE = 16 * 1024;
static uint8_t jpegBuf[JPEG_BUF_SIZE];

static uint32_t lastInvokeMs = 0;
static uint32_t lastImageMs = 0;
static uint32_t lastWifiAttemptMs = 0;
static volatile bool wsConnected = false;
static bool wsStarted = false;

bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  uint32_t now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_MS) {
    return false;
  }
  lastWifiAttemptMs = now;
  wsConnected = false;

  Serial.printf("Connecting to Wi-Fi SSID=%s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Wi-Fi OK, IP=%s\n", WiFi.localIP().toString().c_str());
    return true;
  }

  Serial.println("Wi-Fi failed");
  return false;
}

void ensureWs() {
  if (wsStarted) {
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  Serial.printf("WS begin %s:%u\n", WS_HOST, WS_PORT);
  webSocket.begin(WS_HOST, WS_PORT, "/");
  webSocket.onEvent([](WStype_t type, uint8_t *, size_t) {
    switch (type) {
    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("WS disconnected");
      break;
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("WS connected");
      break;
    case WStype_ERROR:
      Serial.println("WS error");
      break;
    default:
      break;
    }
  });
  webSocket.setReconnectInterval(3000);
  wsStarted = true;
}

bool decodeJpegBase64(const String &b64, size_t &outLen) {
  size_t olen = 0;
  int ret = mbedtls_base64_decode(
      jpegBuf, JPEG_BUF_SIZE, &olen,
      reinterpret_cast<const unsigned char *>(b64.c_str()), b64.length());
  if (ret != 0 || olen < 4) {
    return false;
  }
  if (jpegBuf[0] != 0xFF || jpegBuf[1] != 0xD8) {
    return false;
  }
  outLen = olen;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("Vision Menu firmware starting (WebSocket)");

  if (!AI.begin()) {
    Serial.println("SSCMA begin failed — check Grove Vision AI V2 connection");
  } else {
    Serial.println("SSCMA ready");
  }

  ensureWifi();
  delay(300);
  ensureWs();
}

void loop() {
  if (wsStarted) {
    webSocket.loop();
  }

  if (!ensureWifi()) {
    delay(200);
    return;
  }

  ensureWs();
  if (!wsConnected) {
    delay(40);
    return;
  }

  uint32_t now = millis();
  if (now - lastInvokeMs < INVOKE_INTERVAL_MS) {
    delay(2);
    return;
  }
  lastInvokeMs = now;

  // Always DIFFERED=false so empty (no-face) frames still emit events / JPEGs.
  // show=true → include JPEG; show=false → boxes only.
  bool wantImage = (now - lastImageMs) >= IMAGE_INTERVAL_MS;
  AI.boxes().clear();
  int invokeRc = AI.invoke(1, false, wantImage);
  if (invokeRc != 0 && wantImage) {
    // Fallback: results-only if the image-sized reply timed out.
    invokeRc = AI.invoke(1, false, false);
    wantImage = false;
  }
  if (invokeRc != 0) {
    Serial.println("invoke failed");
    delay(20);
    return;
  }

  if (wantImage) {
    // Advance cadence even on empty/decode failure so we don't stall the stream.
    lastImageMs = millis();
    if (AI.last_image().length() > 0) {
      size_t jpegLen = 0;
      if (decodeJpegBase64(AI.last_image(), jpegLen)) {
        if (!webSocket.sendBIN(jpegBuf, jpegLen)) {
          lastImageMs = millis() - IMAGE_INTERVAL_MS + 100;
        }
      } else {
        Serial.println("JPEG base64 decode failed");
      }
    }
  }

  String boxesJson = "[";
  bool first = true;
  size_t kept = 0;
  for (size_t i = 0; i < AI.boxes().size(); i++) {
    const boxes_t &box = AI.boxes()[i];
    if (!scorePasses(box.score)) {
      continue;
    }
    if (!first) {
      boxesJson += ",";
    }
    first = false;
    kept++;
    // SenseCraft boxes are center-format (cx, cy, w, h) — convert to top-left for the panel.
    const float x = box.x - box.w / 2.0f;
    const float y = box.y - box.h / 2.0f;
    boxesJson += "{";
    boxesJson += "\"target\":" + String(box.target) + ",";
    boxesJson += "\"score\":" + String(box.score) + ",";
    boxesJson += "\"x\":" + String(x) + ",";
    boxesJson += "\"y\":" + String(y) + ",";
    boxesJson += "\"w\":" + String(box.w) + ",";
    boxesJson += "\"h\":" + String(box.h);
    boxesJson += "}";
  }
  boxesJson += "]";

  String payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"ts\":" + String((unsigned long)now) + ",";
  payload += "\"width\":" + String(FRAME_WIDTH) + ",";
  payload += "\"height\":" + String(FRAME_HEIGHT) + ",";
  payload += "\"boxes\":" + boxesJson;
  payload += "}";

  if (!webSocket.sendTXT(payload)) {
    Serial.println("WS ingest send failed");
  } else {
    static uint32_t lastBoxLogMs = 0;
    if (now - lastBoxLogMs > 2000) {
      lastBoxLogMs = now;
      Serial.printf("WS ingest kept=%u raw=%u\n",
                    (unsigned)kept,
                    (unsigned)AI.boxes().size());
    }
  }
}

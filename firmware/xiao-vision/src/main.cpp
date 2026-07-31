#include <Arduino.h>
#include <HTTPClient.h>
#include <Seeed_Arduino_SSCMA.h>
#include <WiFi.h>

#include "secrets.h"

#ifndef WIFI_SSID
#error "Copy include/secrets.h.example to include/secrets.h and configure Wi-Fi + INGEST_URL"
#endif

SSCMA AI;

// Frame size used by SenseCraft person models on Grove Vision AI V2 (typical).
static const int FRAME_WIDTH = 240;
static const int FRAME_HEIGHT = 240;

static const uint8_t MIN_SCORE = 50; // SenseCraft score is 0–100
static const uint32_t INVOKE_INTERVAL_MS = 400;
static const uint32_t IMAGE_INTERVAL_MS = 1500;
static const uint32_t WIFI_RETRY_MS = 5000;

static uint32_t lastInvokeMs = 0;
static uint32_t lastImageMs = 0;
static uint32_t lastWifiAttemptMs = 0;

bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  uint32_t now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_MS) {
    return false;
  }
  lastWifiAttemptMs = now;

  Serial.printf("Connecting to Wi-Fi SSID=%s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
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

String escapeJson(const String &input) {
  String out;
  out.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); i++) {
    char c = input[i];
    if (c == '\\' || c == '"') {
      out += '\\';
      out += c;
    } else if ((uint8_t)c < 0x20) {
      // skip other control chars
      continue;
    } else {
      out += c;
    }
  }
  return out;
}

bool postIngest(const String &payload) {
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(INGEST_URL)) {
    Serial.println("HTTP begin failed");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  int code = http.POST(payload);
  String response = http.getString();
  http.end();

  Serial.printf("Ingest HTTP %d (%u bytes)\n", code, (unsigned)payload.length());
  if (code < 200 || code >= 300) {
    Serial.println(response);
    return false;
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("Vision Menu firmware starting");

  // Default I2C to Grove Vision AI V2 on the XIAO Vision AI Camera
  if (!AI.begin()) {
    Serial.println("SSCMA begin failed — check Grove Vision AI V2 connection");
  } else {
    Serial.println("SSCMA ready");
  }

  ensureWifi();
}

void loop() {
  if (!ensureWifi()) {
    delay(500);
    return;
  }

  uint32_t now = millis();
  if (now - lastInvokeMs < INVOKE_INTERVAL_MS) {
    delay(10);
    return;
  }
  lastInvokeMs = now;

  bool wantImage = (now - lastImageMs) >= IMAGE_INTERVAL_MS;
  // invoke(times, filter, show) — show=true includes JPEG in last_image()
  if (AI.invoke(1, false, wantImage) != 0) {
    Serial.println("invoke failed");
    delay(200);
    return;
  }

  if (wantImage && AI.last_image().length() > 0) {
    lastImageMs = now;
  }

  String boxesJson = "[";
  bool first = true;
  for (size_t i = 0; i < AI.boxes().size(); i++) {
    const boxes_t &box = AI.boxes()[i];
    if (box.score < MIN_SCORE) {
      continue;
    }
    if (!first) {
      boxesJson += ",";
    }
    first = false;
    boxesJson += "{";
    boxesJson += "\"target\":" + String(box.target) + ",";
    boxesJson += "\"score\":" + String(box.score) + ",";
    boxesJson += "\"x\":" + String(box.x) + ",";
    boxesJson += "\"y\":" + String(box.y) + ",";
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

  if (wantImage && AI.last_image().length() > 0) {
    payload += ",\"imageBase64\":\"" + escapeJson(AI.last_image()) + "\"";
  }

  payload += "}";

  postIngest(payload);
}

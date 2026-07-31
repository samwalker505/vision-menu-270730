/**
 * EE04 + 5.83" ePaper — Vision Menu promo display.
 *
 * Connects to the same WebSocket hub as the vision camera / web panel.
 * Default screen: welcome message.
 * On { type:"epaper", mode:"promo", ... }: show discount code + QR for ~60s,
 * then return to welcome (server also pushes mode:"welcome").
 *
 * Flash:
 *   cp include/secrets.h.example include/secrets.h   # edit Wi-Fi + WS_HOST
 *   cd firmware/xiao-epaper
 *   pio run -t upload && pio device monitor
 */

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <mbedtls/base64.h>

#include "secrets.h"

#ifndef EPAPER_MENU_SECRETS_H
#error "Copy include/secrets.h.example to include/secrets.h and configure Wi-Fi + WS_HOST"
#endif

#ifdef EPAPER_ENABLE
EPaper epaper;
#endif

WebSocketsClient webSocket;

static const uint32_t WIFI_RETRY_MS = 5000;
static const uint32_t PROMO_FALLBACK_MS = 60UL * 1000UL;
static const int QR_MAX_SIZE = 64;
static const size_t QR_BYTES_MAX = (QR_MAX_SIZE * QR_MAX_SIZE + 7) / 8;

static uint32_t lastWifiAttemptMs = 0;
static volatile bool wsConnected = false;
static bool wsStarted = false;
static bool displayOk = false;

enum class ScreenMode : uint8_t { Welcome, Promo };
static ScreenMode screenMode = ScreenMode::Welcome;
static uint32_t promoStartedMs = 0;
static uint32_t promoExpiresAtMs = 0; // millis() deadline; 0 = use PROMO_FALLBACK_MS

static char promoCode[32] = "";
static int promoDiscountPct = 0;
static int qrSize = 0;
static uint8_t qrBytes[QR_BYTES_MAX];
static size_t qrByteLen = 0;
static bool pendingRedraw = false;

static bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  const uint32_t now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_MS) {
    return false;
  }
  lastWifiAttemptMs = now;
  wsConnected = false;

  Serial.printf("Connecting to Wi-Fi SSID=%s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const uint32_t start = millis();
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

static bool qrModuleAt(int row, int col) {
  if (row < 0 || col < 0 || row >= qrSize || col >= qrSize || qrByteLen == 0) {
    return false;
  }
  const int bitIndex = row * qrSize + col;
  const int byteIndex = bitIndex >> 3;
  if (byteIndex < 0 || static_cast<size_t>(byteIndex) >= qrByteLen) {
    return false;
  }
  return (qrBytes[byteIndex] & (0x80 >> (bitIndex & 7))) != 0;
}

#ifdef EPAPER_ENABLE
static void drawWelcome() {
  const int w = epaper.width();
  const int h = epaper.height();

  epaper.fillScreen(TFT_WHITE);
  epaper.drawRect(8, 8, w - 16, h - 16, TFT_BLACK);

  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.setTextSize(4);
  epaper.setCursor(48, 90);
  epaper.print("Welcome");

  epaper.setTextSize(3);
  epaper.setCursor(48, 170);
  epaper.print("Vision Menu");

  epaper.setTextSize(2);
  epaper.setCursor(48, 250);
  epaper.print("Stand still at the camera");
  epaper.setCursor(48, 286);
  epaper.print("for a guest discount offer.");

  epaper.setCursor(48, h - 64);
  if (wsConnected) {
    epaper.print("Counter display online");
  } else {
    epaper.print("Connecting...");
  }

  epaper.update();
}

static void drawPromo() {
  const int w = epaper.width();
  const int h = epaper.height();

  epaper.fillScreen(TFT_WHITE);
  epaper.drawRect(8, 8, w - 16, h - 16, TFT_BLACK);

  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.setTextSize(4);
  epaper.setCursor(40, 28);
  epaper.printf("%d%% OFF", promoDiscountPct);

  epaper.setTextSize(2);
  epaper.setCursor(40, 92);
  epaper.print("Show this code at the counter");

  epaper.setTextSize(3);
  epaper.setCursor(40, 128);
  epaper.print(promoCode);

  // QR block — centered in lower area
  if (qrSize > 0) {
    const int maxDim = min(w - 80, h - 220);
    const int modulePx = max(2, maxDim / qrSize);
    const int qrPx = modulePx * qrSize;
    const int originX = (w - qrPx) / 2;
    const int originY = 180;

    // Quiet zone
    epaper.fillRect(originX - 8, originY - 8, qrPx + 16, qrPx + 16, TFT_WHITE);
    epaper.drawRect(originX - 8, originY - 8, qrPx + 16, qrPx + 16, TFT_BLACK);

    for (int row = 0; row < qrSize; row++) {
      for (int col = 0; col < qrSize; col++) {
        if (qrModuleAt(row, col)) {
          epaper.fillRect(originX + col * modulePx, originY + row * modulePx,
                          modulePx, modulePx, TFT_BLACK);
        }
      }
    }
  } else {
    epaper.setTextSize(2);
    epaper.setCursor(40, 220);
    epaper.print("(QR unavailable — use code)");
  }

  epaper.setTextSize(2);
  epaper.setCursor(40, h - 56);
  epaper.print("Display clears after 1 minute");

  epaper.update();
}

static void applyScreen() {
  if (!displayOk) return;
  if (screenMode == ScreenMode::Promo) {
    drawPromo();
  } else {
    drawWelcome();
  }
}
#endif

static void showWelcome() {
  screenMode = ScreenMode::Welcome;
  promoStartedMs = 0;
  promoExpiresAtMs = 0;
  promoCode[0] = '\0';
  promoDiscountPct = 0;
  qrSize = 0;
  qrByteLen = 0;
  pendingRedraw = true;
  Serial.println("Screen -> welcome");
}

static bool decodeQrModules(const char *b64, int size) {
  if (size <= 0 || size > QR_MAX_SIZE || b64 == nullptr) {
    return false;
  }
  const size_t need = static_cast<size_t>((size * size + 7) / 8);
  if (need > QR_BYTES_MAX) {
    return false;
  }

  size_t olen = 0;
  const int ret = mbedtls_base64_decode(
      qrBytes, QR_BYTES_MAX, &olen,
      reinterpret_cast<const unsigned char *>(b64), strlen(b64));
  if (ret != 0 || olen < need) {
    Serial.printf("QR base64 decode failed ret=%d olen=%u need=%u\n", ret,
                  static_cast<unsigned>(olen), static_cast<unsigned>(need));
    return false;
  }

  qrSize = size;
  qrByteLen = olen;
  return true;
}

static void handleEpaperJson(JsonDocument &doc) {
  const char *type = doc["type"] | "";
  if (strcmp(type, "epaper") != 0) {
    return;
  }

  const char *mode = doc["mode"] | "";
  if (strcmp(mode, "welcome") == 0) {
    showWelcome();
    return;
  }

  if (strcmp(mode, "promo") != 0) {
    return;
  }

  const char *code = doc["code"] | "";
  const int pct = doc["discountPct"] | 0;
  if (code[0] == '\0' || pct < 10) {
    Serial.println("Ignoring promo with missing code/pct");
    return;
  }

  strncpy(promoCode, code, sizeof(promoCode) - 1);
  promoCode[sizeof(promoCode) - 1] = '\0';
  promoDiscountPct = pct;

  qrSize = 0;
  qrByteLen = 0;
  JsonObjectConst qr = doc["qr"].as<JsonObjectConst>();
  if (!qr.isNull()) {
    const int size = qr["size"] | 0;
    const char *modulesB64 = qr["modulesB64"] | "";
    if (!decodeQrModules(modulesB64, size)) {
      Serial.println("Promo QR decode failed — showing code only");
    }
  }

  screenMode = ScreenMode::Promo;
  promoStartedMs = millis();
  // Prefer server expiresAt if it looks like an epoch ms in the near future.
  const uint64_t expiresAt = doc["expiresAt"] | 0ULL;
  const uint64_t wallNow = static_cast<uint64_t>(millis()); // device has no RTC; use local fallback
  (void)expiresAt;
  (void)wallNow;
  promoExpiresAtMs = promoStartedMs + PROMO_FALLBACK_MS;
  pendingRedraw = true;
  Serial.printf("Screen -> promo %s (%d%%) qr=%d\n", promoCode, promoDiscountPct,
                qrSize);
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
  case WStype_DISCONNECTED:
    wsConnected = false;
    Serial.println("WS disconnected");
    pendingRedraw = true;
    break;
  case WStype_CONNECTED:
    wsConnected = true;
    Serial.println("WS connected");
    webSocket.sendTXT("{\"type\":\"hello\",\"role\":\"epaper\"}");
    pendingRedraw = true;
    break;
  case WStype_TEXT: {
    JsonDocument doc;
    const DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
      Serial.printf("JSON parse error: %s\n", err.c_str());
      break;
    }
    handleEpaperJson(doc);
    break;
  }
  case WStype_ERROR:
    Serial.println("WS error");
    break;
  default:
    break;
  }
}

static void ensureWs() {
  if (wsStarted) {
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  Serial.printf("WS begin %s:%u\n", WS_HOST, WS_PORT);
  webSocket.begin(WS_HOST, WS_PORT, "/");
  webSocket.onEvent(onWsEvent);
  webSocket.setReconnectInterval(3000);
  wsStarted = true;
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println();
  Serial.println("========================================");
  Serial.println(" EE04 ePaper — Vision Menu promo display");
  Serial.println("========================================");

#ifndef EPAPER_ENABLE
  Serial.println("[FAIL] EPAPER_ENABLE is not defined.");
  Serial.println("Check include/driver.h (BOARD_SCREEN_COMBO 503 + EE04).");
  return;
#else
  Serial.println("Initializing ePaper (UC8179 / 5.83\")...");
  epaper.begin();

  const int w = epaper.width();
  const int h = epaper.height();
  Serial.printf("Reported size: %d x %d\n", w, h);

  displayOk = (w == 648 && h == 480);
  if (displayOk) {
    Serial.println("[PASS] Panel size matches 648x480");
  } else if (w > 0 && h > 0) {
    Serial.println("[WARN] Panel responded but size != 648x480");
    displayOk = true;
  } else {
    Serial.println("[FAIL] Panel size is 0 — check ribbon cable and power");
  }

  showWelcome();
  applyScreen();
  pendingRedraw = false;

  ensureWifi();
  delay(300);
  ensureWs();
#endif
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

  // Local fallback: leave promo after 1 minute even if welcome push is missed.
  if (screenMode == ScreenMode::Promo && promoStartedMs > 0) {
    const uint32_t deadline =
        promoExpiresAtMs != 0 ? promoExpiresAtMs : (promoStartedMs + PROMO_FALLBACK_MS);
    if (static_cast<int32_t>(millis() - deadline) >= 0) {
      showWelcome();
    }
  }

#ifdef EPAPER_ENABLE
  if (pendingRedraw && displayOk) {
    pendingRedraw = false;
    applyScreen();
  }
#endif

  delay(20);
}

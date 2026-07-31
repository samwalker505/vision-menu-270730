/**
 * EE04 + 5.83" ePaper hardware smoke test.
 *
 * What "working" looks like:
 *  - Serial prints a PASS banner and measured panel size (expect 648x480)
 *  - Panel shows a bordered test pattern with shapes + labels
 *  - KEY0 / KEY1 / KEY2 presses print on Serial and bump an on-screen counter
 *  - Battery ADC (if powered / battery attached) prints periodically
 *
 * Flash:
 *   cd firmware/xiao-epaper
 *   pio run -t upload
 *   pio device monitor
 */

#include <Arduino.h>
#include <TFT_eSPI.h>

#ifdef EPAPER_ENABLE
EPaper epaper;
#endif

// EE04 user buttons (active-low)
static const int BUTTON_KEY0 = 2;  // GPIO2
static const int BUTTON_KEY1 = 3;  // GPIO3
static const int BUTTON_KEY2 = 5;  // GPIO5

// Battery sense
static const int BATTERY_ADC = A0;  // GPIO1
static const int ADC_EN = 6;        // GPIO6
static const float VOLTAGE_DIVIDER_RATIO = 2.0f;

static bool lastKey0 = HIGH;
static bool lastKey1 = HIGH;
static bool lastKey2 = HIGH;
static uint32_t pressCount = 0;
static uint32_t lastBatteryMs = 0;
static bool displayOk = false;

static float readBatteryVoltage() {
  int sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(BATTERY_ADC);
    delay(2);
  }
  const float adcValue = sum / 10.0f;
  return (adcValue / 4095.0f) * 3.3f * VOLTAGE_DIVIDER_RATIO;
}

#ifdef EPAPER_ENABLE
static void drawHardwareTestPattern(const char *note) {
  const int w = epaper.width();
  const int h = epaper.height();

  epaper.fillScreen(TFT_WHITE);

  // Outer frame — confirms SPI + full panel write
  epaper.drawRect(2, 2, w - 4, h - 4, TFT_BLACK);
  epaper.drawRect(6, 6, w - 12, h - 12, TFT_BLACK);

  // Corner markers
  epaper.fillRect(12, 12, 28, 28, TFT_BLACK);
  epaper.fillCircle(w - 26, 26, 14, TFT_BLACK);
  epaper.fillTriangle(12, h - 12, 40, h - 40, 40, h - 12, TFT_BLACK);
  epaper.fillCircle(w - 26, h - 26, 14, TFT_BLACK);

  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.setTextSize(3);
  epaper.setCursor(56, 24);
  epaper.print("EE04 HW CHECK");

  epaper.setTextSize(2);
  epaper.setCursor(56, 70);
  epaper.printf("Panel %dx%d (expect 648x480)", w, h);

  epaper.setCursor(56, 104);
  epaper.print(displayOk ? "STATUS: PASS - display responds" : "STATUS: FAIL");

  epaper.setCursor(56, 138);
  epaper.print("Press KEY0 / KEY1 / KEY2");

  // Horizontal size ladders
  for (int i = 0; i < 5; i++) {
    const int y = 190 + i * 36;
    epaper.drawLine(56, y, w - 56, y, TFT_BLACK);
    epaper.setTextSize(i + 1);
    epaper.setCursor(56, y + 6);
    epaper.printf("Hello EE04  size=%d", i + 1);
  }

  epaper.setTextSize(2);
  epaper.setCursor(56, h - 72);
  epaper.printf("Button presses: %lu", static_cast<unsigned long>(pressCount));

  epaper.setCursor(56, h - 44);
  epaper.print(note);

  epaper.update();
}
#endif

static void handleButton(int pin, bool &lastState, const char *name) {
  const bool state = digitalRead(pin);
  if (state == lastState) return;

  if (state == LOW) {
    pressCount += 1;
    Serial.printf("[PASS] %s pressed (count=%lu)\n", name,
                  static_cast<unsigned long>(pressCount));
#ifdef EPAPER_ENABLE
    if (displayOk) {
      char note[48];
      snprintf(note, sizeof(note), "Last: %s", name);
      drawHardwareTestPattern(note);
    }
#endif
  } else {
    Serial.printf("%s released\n", name);
  }

  lastState = state;
  delay(40);
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println();
  Serial.println("========================================");
  Serial.println(" EE04 + 5.83\" ePaper hardware demo");
  Serial.println("========================================");

  pinMode(BUTTON_KEY0, INPUT_PULLUP);
  pinMode(BUTTON_KEY1, INPUT_PULLUP);
  pinMode(BUTTON_KEY2, INPUT_PULLUP);
  lastKey0 = digitalRead(BUTTON_KEY0);
  lastKey1 = digitalRead(BUTTON_KEY1);
  lastKey2 = digitalRead(BUTTON_KEY2);

  analogReadResolution(12);
  pinMode(BATTERY_ADC, INPUT);
  pinMode(ADC_EN, OUTPUT);
  digitalWrite(ADC_EN, HIGH);

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
    Serial.println("       Confirm FPC orientation / BOARD_SCREEN_COMBO=503");
    displayOk = true;  // still draw — useful for wrong-combo debugging
  } else {
    Serial.println("[FAIL] Panel size is 0 — check ribbon cable and power");
  }

  if (displayOk) {
    drawHardwareTestPattern("Initial refresh OK");
    Serial.println("[PASS] Test pattern sent — look at the ePaper");
  }

  Serial.println();
  Serial.println("Next checks:");
  Serial.println("  1) Shapes/text visible on panel");
  Serial.println("  2) Press KEY0/KEY1/KEY2 — Serial + screen update");
  Serial.println("  3) Battery voltage line below (USB-only may read odd)");
  Serial.println();
#endif
}

void loop() {
  handleButton(BUTTON_KEY0, lastKey0, "KEY0");
  handleButton(BUTTON_KEY1, lastKey1, "KEY1");
  handleButton(BUTTON_KEY2, lastKey2, "KEY2");

  const uint32_t now = millis();
  if (now - lastBatteryMs >= 5000) {
    lastBatteryMs = now;
    const float v = readBatteryVoltage();
    Serial.printf("Battery ADC: %.2f V\n", v);
  }

  delay(10);
}

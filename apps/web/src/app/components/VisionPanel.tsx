"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_PANEL_STATE,
  PLACEHOLDER_MENU,
  type PanelState,
} from "@repo/shared";

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatAge(updatedAt: number, now: number): string {
  if (!updatedAt) return "waiting";
  const sec = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (sec < 1) return "just now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

export function VisionPanel() {
  const [state, setState] = useState<PanelState>(DEFAULT_PANEL_STATE);
  const [now, setNow] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const hydrate = async () => {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as PanelState;
        if (!cancelled) setState(data);
      } catch {
        // ignore; SSE / poll will retry
      }
    };

    const startPoll = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        void hydrate();
      }, 1500);
    };

    void hydrate();

    try {
      source = new EventSource("/api/events");
      source.onopen = () => {
        if (!cancelled) setConnected(true);
      };
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as PanelState;
          if (!cancelled) {
            setState(data);
            setConnected(true);
          }
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => {
        if (!cancelled) setConnected(false);
        source?.close();
        startPoll();
      };
    } catch {
      startPoll();
    }

    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
      clearInterval(clock);
    };
  }, []);

  const imageSrc = state.imageBase64
    ? state.imageBase64.startsWith("data:")
      ? state.imageBase64
      : `data:image/jpeg;base64,${state.imageBase64}`
    : null;

  return (
    <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-10 px-5 py-10 sm:px-8 lg:px-10">
      <header className="animate-fade-up flex flex-col gap-3">
        <p
          className="text-sm font-medium tracking-[0.22em] uppercase"
          style={{ color: "var(--accent)" }}
        >
          XIAO Vision AI
        </p>
        <h1
          className="text-5xl leading-none tracking-tight sm:text-6xl"
          style={{ fontFamily: "var(--font-display)", color: "var(--ink)" }}
        >
          Vision Menu
        </h1>
        <p className="max-w-xl text-base sm:text-lg" style={{ color: "var(--ink-soft)" }}>
          Stand still in frame to unlock today&apos;s menu. Live presence and stillness
          are computed from the camera stream.
        </p>
        <div className="flex items-center gap-3 text-sm" style={{ color: "var(--ink-soft)" }}>
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? "animate-pulse-glow" : ""}`}
            style={{ background: connected ? "var(--accent-bright)" : "var(--locked)" }}
            aria-hidden
          />
          {connected ? "Live" : "Reconnecting"}
          <span aria-hidden>·</span>
          <span>Updated {formatAge(state.updatedAt, now)}</span>
          {state.deviceId ? (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono text-xs">{state.deviceId}</span>
            </>
          ) : null}
        </div>
      </header>

      <section
        className="animate-fade-up grid gap-8 lg:grid-cols-[1.1fr_0.9fr]"
        style={{ animationDelay: "80ms" }}
        aria-label="Camera status"
      >
        <div className="overflow-hidden rounded-sm" style={{ background: "var(--bg-deep)" }}>
          <div className="relative aspect-[4/3] w-full">
            {imageSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageSrc}
                alt="Latest frame from Vision AI Camera"
                className="h-full w-full object-cover"
              />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center px-8 text-center text-sm"
                style={{ color: "rgba(231, 243, 238, 0.7)" }}
              >
                Waiting for the first frame from the camera…
              </div>
            )}
            {state.primaryBox && state.width > 0 && state.height > 0 ? (
              <div
                className="pointer-events-none absolute border-2"
                style={{
                  borderColor: state.isStill ? "var(--accent-bright)" : "rgba(255,255,255,0.85)",
                  left: `${(state.primaryBox.x / state.width) * 100}%`,
                  top: `${(state.primaryBox.y / state.height) * 100}%`,
                  width: `${(state.primaryBox.w / state.width) * 100}%`,
                  height: `${(state.primaryBox.h / state.height) * 100}%`,
                }}
              />
            ) : null}
          </div>
        </div>

        <div className="flex flex-col justify-center gap-6">
          <StatusRow
            label="Human in frame"
            value={state.humanPresent ? "Detected" : "None"}
            active={state.humanPresent}
          />
          <StatusRow
            label="Standing still"
            value={state.isStill ? `Yes · ${Math.round(state.stillMs / 100) / 10}s` : "No"}
            active={state.isStill}
          />
          <StatusRow
            label="Confidence"
            value={state.humanPresent ? formatConfidence(state.confidence) : "—"}
            active={state.confidence >= 0.5}
          />
          <StatusRow
            label="Menu"
            value={state.menuUnlocked ? "Unlocked" : "Locked — stand still"}
            active={state.menuUnlocked}
          />
        </div>
      </section>

      <section
        className="animate-fade-up"
        style={{ animationDelay: "160ms" }}
        aria-label="Digital menu"
      >
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h2
              className="text-3xl tracking-tight sm:text-4xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Today&apos;s Menu
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--ink-soft)" }}>
              {state.menuUnlocked
                ? "Unlocked by stillness — browse and order at the counter."
                : "Hold still in the camera frame to reveal the menu."}
            </p>
          </div>
        </div>

        {!state.menuUnlocked ? (
          <div
            className="flex min-h-48 items-center justify-center border border-dashed px-6 py-10 text-center"
            style={{ borderColor: "var(--line)", color: "var(--locked)" }}
          >
            Menu locked until a person stands still in frame.
          </div>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2">
            {PLACEHOLDER_MENU.map((item, index) => (
              <li
                key={item.id}
                className="animate-unlock border-t pt-4"
                style={{
                  borderColor: "var(--line)",
                  animationDelay: `${index * 70}ms`,
                }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3
                    className="text-xl"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {item.name}
                  </h3>
                  <span className="font-medium" style={{ color: "var(--accent)" }}>
                    {item.price}
                  </span>
                </div>
                <p className="mt-1 text-sm" style={{ color: "var(--ink-soft)" }}>
                  {item.description}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusRow({
  label,
  value,
  active,
}: {
  label: string;
  value: string;
  active: boolean;
}) {
  return (
    <div className="border-b pb-4" style={{ borderColor: "var(--line)" }}>
      <div className="text-xs tracking-[0.18em] uppercase" style={{ color: "var(--ink-soft)" }}>
        {label}
      </div>
      <div
        className="mt-1 text-2xl"
        style={{
          fontFamily: "var(--font-display)",
          color: active ? "var(--accent)" : "var(--ink)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

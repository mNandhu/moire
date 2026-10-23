/**
 * Number and time formatters, one home. The duration styles differ on purpose
 * (each reads in its own place), so each keeps its own name:
 *   formatDuration  "45 s", "3 min", "1 h 5 min"   AI job progress
 *   roughDuration   "7 min", "2.4 h"               onboarding estimates, rough
 *   durationWords   "8.4s", "1m 05s", "1h 02m"     how long a batch ran
 *   etaShort        "45s", "2m 30s", "1h 20m"      rounded estimates ("about ...")
 *   clockText       "0:07", "1:02:03"              timers and countdowns
 * Pure.
 */

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "45 s", "3 min", "1 h 5 min". */
export function formatDuration(s: number): string {
  const sec = Math.max(0, Math.round(s));
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "7 min", "2.4 h": rough on purpose, the rates are someone else's hardware. */
export function roughDuration(seconds: number): string {
  if (seconds < 90 * 60) return `${Math.max(1, Math.round(seconds / 60))} min`;
  return `${(seconds / 3600).toFixed(1).replace(/\.0$/, "")} h`;
}

/** "8.4s", "42s", "1m 05s", "1h 02m". Pure. */
export function durationWords(seconds: number): string {
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Seconds rounded as shown. */
export function roundEta(seconds: number): number {
  const s = Math.max(0, seconds);
  if (s < 60) return Math.max(5, Math.round(s / 5) * 5);
  if (s < 600) return Math.round(s / 10) * 10;
  return Math.round(s / 60) * 60;
}

/** "45s", "2m 30s", "14m", "1h 20m": a rounded duration without "about". */
export function etaShort(seconds: number): string {
  const s = roundEta(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** "about 2m 30s". */
export const etaLabel = (seconds: number) => `about ${etaShort(seconds)}`;

/**
 * "0:07", "2:30", "1:02:03": seconds as a timer shows them. `mode` is how a
 * fraction falls: "floor" for a clock counting up (it ticks once a second has
 * passed), "round" for a countdown, "ceil" for time left that should not
 * read zero while any remains. Negative is 0:00. Pure.
 */
export function clockText(seconds: number, mode: "floor" | "round" | "ceil" = "floor"): string {
  const s = Math.max(0, Math[mode](seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

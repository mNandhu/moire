import { useEffect } from "react";

/**
 * Keyboard reference for the gallery, opened with `?`.
 *
 * The triage shortcuts (0-5 to score, X to quarantine, arrows to move) are the
 * fastest way to use this app and were entirely undiscoverable — nothing on
 * screen mentioned them, so the feature effectively didn't exist for anyone who
 * hadn't read the source.
 */
const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Navigate",
    keys: [
      ["← → ↑ ↓", "Move between tiles"],
      ["Enter", "Open the focused image"],
      ["Esc", "Back out of whatever is open"],
      ["PgUp / PgDn", "Scroll a page"],
      ["Home / End", "Jump to start or end"],
    ],
  },
  {
    title: "Triage",
    keys: [
      ["0 – 5", "Score the focused image"],
      ["X / Del", "Quarantine (or restore) it"],
    ],
  },
  {
    title: "Select",
    keys: [
      ["S", "Toggle selection mode"],
      ["Click a tile", "Add or remove it, while in the mode"],
      ["Esc", "Leave selection mode"],
    ],
  },
  {
    title: "View",
    keys: [
      ["+ / -", "Larger / smaller thumbnails"],
      ["/", "Focus the tag search"],
      ["?", "This help"],
    ],
  },
];

export function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm motion-safe:animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-line-strong bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="text-lg font-bold tracking-tight">Keyboard shortcuts</h2>
          <span className="text-xs text-faint">Esc to close</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="text-2xs font-semibold uppercase tracking-wider text-faint mb-2">
                {g.title}
              </div>
              <dl className="space-y-1.5">
                {g.keys.map(([key, desc]) => (
                  <div key={key} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0">
                      <kbd className="px-1.5 py-0.5 rounded bg-raised border border-line-strong text-2xs font-mono text-neutral-200">
                        {key}
                      </kbd>
                    </dt>
                    <dd className="text-sm text-neutral-400 text-right">{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

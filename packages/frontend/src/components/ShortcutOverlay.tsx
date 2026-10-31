import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Dialog } from "./ui/Dialog";
import { useHotkeys } from "../hooks/useHotkeys";
import { EVERYWHERE, OPEN_SHORTCUTS_EVENT, shortcutGroups } from "../lib/shortcuts";

/**
 * Keyboard reference, opened with `?` on any page (lib/shortcuts.ts holds the
 * keys). Mounted once at the root, so an image opened by link has it too. A
 * Dialog, so the keys it lists don't act on the page under it while it's open.
 */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useHotkeys(
    [
      {
        ...EVERYWHERE.help,
        run: (e) => {
          // Not over another dialog (a confirm, a rename): one modal at a time.
          // Its own `?` closes it (below).
          if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
          e.preventDefault();
          setOpen(true);
        },
      },
    ],
    { overlay: "ignore" },
  );
  // `?` again closes it. The Dialog keeps keys from inside it off the
  // window, so this listens at the document, on the way down.
  useHotkeys(
    [
      {
        ...EVERYWHERE.help,
        mods: "any",
        run: (e) => {
          if (!document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')) return;
          e.preventDefault();
          setOpen(false);
        },
      },
    ],
    { capture: true, fields: true, overlay: "ignore" },
  );
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
  }, []);

  return <ShortcutOverlay open={open} onClose={() => setOpen(false)} pathname={pathname} />;
}

function ShortcutOverlay({ open, onClose, pathname }: { open: boolean; onClose: () => void; pathname: string }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel="Keyboard shortcuts"
      className="max-w-2xl rounded-2xl border-line-strong bg-surface p-6"
    >
      <div>
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="text-lg font-bold tracking-tight">Keyboard shortcuts</h2>
          <span className="text-xs text-faint">Esc to close</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
          {shortcutGroups(pathname).map((g) => (
            <div key={g.title}>
              <div className="text-2xs font-semibold uppercase tracking-wider text-faint mb-2">{g.title}</div>
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
    </Dialog>
  );
}

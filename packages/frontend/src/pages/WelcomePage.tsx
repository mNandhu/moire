import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { writeLocalPref } from "../lib/localPref";
import { Check } from "lucide-react";
import { Button } from "../components/ui/Button";
import { MoireMark } from "../components/ui/Logo";
import { RingBackground } from "../components/onboarding/RingBackground";
import { FoldersStep, folderSummary, type FolderEntry } from "../components/onboarding/FoldersStep";
import { ComfyStep, comfySummary, type ComfyState, type WorkflowRead } from "../components/onboarding/ComfyStep";
import { TaggingStep } from "../components/onboarding/TaggingStep";
import { Dot } from "../components/onboarding/parts";
import { errorText } from "../lib/api";
import { cn } from "../lib/cn";
import { getSettings } from "../lib/generate";
import { discoverLibraries } from "../lib/libraryPlan";
import {
  ONBOARDING_KEY,
  SHORTCUT_HINT_KEY,
  fetchOnboarding,
  isRemote,
  librariesToAdd,
  planLibrarySync,
  putOnboarding,
  sourceTotals,
  type OnboardingInfo,
  type OnboardingStatus,
} from "../lib/onboarding";
import { LIBRARIES_KEY, SCAN_POLL_MS, useLibraries, useLibraryWrites } from "../lib/libraries";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const STEPS = [
  { id: "folders", title: "Image folders", optional: false },
  { id: "comfy", title: "ComfyUI", optional: true },
  { id: "tagging", title: "AI tagging", optional: true },
] as const;

/**
 * What a fresh install opens on: a landing page (logo, one line, Set up or
 * Skip), then a short setup with the steps listed on the left. Skipping at
 * any point opens the gallery with whatever was set so far.
 */
export default function WelcomePage() {
  useDocumentTitle("Welcome");
  const { data: info } = useQuery({ queryKey: ONBOARDING_KEY, queryFn: ({ signal }) => fetchOnboarding(signal) });
  const [view, setView] = useState<"landing" | "setup">("landing");
  const qc = useQueryClient();
  const navigate = useNavigate();

  const leave = async (status: OnboardingStatus) => {
    try {
      await putOnboarding(status);
    } catch {
      /* the gallery still opens; the welcome page returns next time */
    }
    // Storage blocked: no hint.
    writeLocalPref(SHORTCUT_HINT_KEY, "1");
    qc.setQueryData<OnboardingInfo | undefined>(ONBOARDING_KEY, (d) => (d ? { ...d, status } : d));
    void qc.invalidateQueries({ queryKey: LIBRARIES_KEY });
    navigate("/", { replace: true });
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-canvas text-[14px] text-neutral-100">
      <RingBackground mode={view} />
      {view === "landing" ? (
        <Landing info={info} onStart={() => setView("setup")} onSkip={() => void leave("skipped")} />
      ) : (
        <Setup info={info} onLeave={(s) => void leave(s)} />
      )}
    </div>
  );
}

function DataNote({ info }: { info: OnboardingInfo | undefined }) {
  if (!info) return null;
  return (
    <>
      Everything stays on {isRemote(window.location.hostname) ? <code>{info.host}</code> : "this computer"}, in{" "}
      <code className="break-all">{info.data_dir}</code>
    </>
  );
}

function Landing({
  info,
  onStart,
  onSkip,
}: {
  info: OnboardingInfo | undefined;
  onStart: () => void;
  onSkip: () => void;
}) {
  return (
    <section className="absolute inset-0 grid place-items-center p-6 text-center" aria-labelledby="h-land">
      <div className="grid animate-fade-in justify-items-center">
        <div className="mb-3.5 flex items-center gap-[clamp(12px,1.6vw,20px)]">
          <MoireMark size={68} className="h-auto w-[clamp(44px,6.4vw,68px)] [stroke-width:1.3]" />
          <h1 id="h-land" className="text-[clamp(40px,6vw,64px)] font-semibold leading-none tracking-[-0.03em]">
            Moiré
          </h1>
        </div>
        <p className="mb-8 max-w-[36ch] text-base leading-normal text-muted">A library for the images you generate.</p>
        <div className="flex flex-wrap justify-center gap-2.5">
          <Button variant="primary" className="h-[42px] px-[18px]" autoFocus onClick={onStart}>
            Set up Moiré
          </Button>
          <Button variant="ghost" className="h-[42px] px-[18px]" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-5 px-6 text-xs text-faint [&_code]:text-[11.5px] [&_code]:text-muted">
        {info && <>Version {info.version} · </>}
        <DataNote info={info} />
      </div>
    </section>
  );
}

function Setup({ info, onLeave }: { info: OnboardingInfo | undefined; onLeave: (s: OnboardingStatus) => void }) {
  const writes = useLibraryWrites();
  const [at, setAt] = useState(0);
  const [reached, setReached] = useState(0);

  // Step 1
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [split, setSplit] = useState(false);
  // Libraries Continue created so far, by path: going back and changing the
  // list creates or removes only the difference.
  const [created, setCreated] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const splitRun = useRef(0);

  // Step 2
  const [comfy, setComfy] = useState<ComfyState>({ address: "", phase: "idle" });
  const [workflows, setWorkflows] = useState<WorkflowRead | null>(null);
  useEffect(() => {
    let live = true;
    getSettings()
      .then((s) => live && setComfy((c) => (c.address ? c : { address: s.address || "127.0.0.1:8188", phase: "idle" })))
      .catch(() => live && setComfy((c) => (c.address ? c : { address: "127.0.0.1:8188", phase: "idle" })));
    return () => {
      live = false;
    };
  }, []);

  const totals = folders.map((f) => sourceTotals(f.source));
  const images = totals.reduce((n, t) => n + t.images, 0);
  const capped = totals.some((t) => t.capped);
  const counting = folders.some((f) => f.counting);

  const onSplit = (on: boolean) => {
    setSplit(on);
    if (!folders.length) return;
    // Recount every listed folder for the new mode.
    const run = ++splitRun.current;
    const paths = folders.map((f) => f.source.path);
    setFolders((prev) => prev.map((f) => ({ ...f, counting: true })));
    discoverLibraries(paths, on)
      .then(({ sources }) => {
        if (run !== splitRun.current) return;
        const byPath = new Map(sources.map((s) => [s.path, s]));
        setFolders((prev) => prev.map((f) => ({ source: byPath.get(f.source.path) ?? f.source })));
      })
      .catch(() => {
        if (run === splitRun.current) setFolders((prev) => prev.map((f) => ({ source: f.source })));
      });
  };

  const go = (i: number) => {
    setAt(i);
    setReached((r) => Math.max(r, i));
  };

  /** Make the libraries match the list: create what's new, remove what was
   * created on an earlier Continue and has since left the list. */
  const createLibraries = async (): Promise<boolean> => {
    const { remove, add } = planLibrarySync(created, librariesToAdd(folders.map((f) => f.source)));
    const next = { ...created };
    const failed: string[] = [];
    setCreating(true);
    setCreateError(null);
    for (const [path, id] of remove) {
      try {
        await writes.remove(id);
        delete next[path];
      } catch (e) {
        failed.push(`${path}: ${errorText(e)}`);
      }
    }
    const added = await writes.createMany(add);
    Object.assign(next, added.created);
    for (const f of added.failed) failed.push(`${f.path}: ${f.error}`);
    setCreated(next);
    setCreating(false);
    if (failed.length) setCreateError(failed.join("\n"));
    return failed.length === 0;
  };

  /** Jump to a step from the list. Leaving the folders step forward syncs
   * the libraries first, the same as Continue does. */
  const goTo = async (i: number) => {
    if (i === at) return;
    if (at === 0 && i > 0) {
      if (!folders.length || counting) return;
      if (!(await createLibraries())) return;
    }
    setAt(i);
  };

  const next = async () => {
    if (at === 0) {
      if (await createLibraries()) go(1);
    } else if (at === 1) go(2);
    else onLeave("done");
  };

  const summaries = [
    folderSummary(folders, split),
    reached < 1 ? "Optional" : comfySummary(comfy, workflows),
    reached < 2 ? "Optional" : "Off",
  ];

  const nextLabel =
    at === 0
      ? creating
        ? "Adding…"
        : folders.length
          ? "Continue"
          : "Add a folder to continue"
      : at === 1
        ? comfy.phase === "connected" || workflows?.items.length
          ? "Continue"
          : "Skip"
        : "Open Moiré";

  return (
    <div className="absolute inset-0 grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-1">
      <nav
        aria-label="Setup steps"
        className="relative z-[2] flex flex-col border-b border-line bg-sunken px-4 pb-2.5 pt-3.5 md:border-b-0 md:border-r md:pb-5 md:pt-[22px]"
      >
        <div className="flex items-center gap-2.5 px-2 text-[15px] font-semibold">
          <MoireMark size={24} />
          Moiré
        </div>
        <h1 className="mx-2 mb-2.5 mt-7 hidden text-[13px] font-medium tracking-[0.02em] text-faint md:block">
          Set up Moiré
        </h1>
        <ol className="mt-3 grid auto-cols-fr grid-flow-col gap-0.5 md:mt-0 md:grid-flow-row">
          {STEPS.map((s, i) => {
            const current = i === at;
            const done = i < reached && !current;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={i > reached || creating}
                  aria-current={current ? "step" : undefined}
                  onClick={() => void goTo(i)}
                  className={cn(
                    "grid w-full grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 rounded-lg p-1.5 text-left text-muted md:px-2 md:py-2.5",
                    "enabled:hover:bg-surface enabled:hover:text-neutral-100 disabled:opacity-55",
                    current && "bg-raised text-neutral-100",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-[22px] w-[22px] place-items-center rounded-full border-[1.5px] text-[11px] tabular-nums",
                      done
                        ? "border-brand-600 bg-brand-600 text-white"
                        : current
                          ? "border-brand-400 text-brand-300"
                          : "border-line-strong text-faint",
                    )}
                  >
                    {done ? <Check size={11} strokeWidth={3.2} /> : i + 1}
                  </span>
                  <span className="min-w-0">
                    <b className="block truncate text-[13px] font-medium leading-[22px] md:text-sm">{s.title}</b>
                    <small className="mt-px hidden truncate text-xs text-faint md:block">{summaries[i]}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-auto hidden gap-2.5 px-2 text-xs leading-normal text-faint md:grid [&_code]:text-[11.5px] [&_code]:text-muted">
          <span>
            <DataNote info={info} />.
          </span>
          <button
            type="button"
            onClick={() => onLeave("skipped")}
            className="justify-self-start py-0.5 text-[12.5px] text-muted underline decoration-line-strong underline-offset-[3px] hover:text-neutral-100"
          >
            Skip setup
          </button>
        </div>
      </nav>

      <div className="relative z-[1] flex min-h-0 min-w-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-7 md:pl-[clamp(24px,5vw,72px)] md:pt-14">
          {at === 0 && (
            <FoldersStep
              folders={folders}
              setFolders={setFolders}
              split={split}
              onSplit={onSplit}
              remoteHost={info && isRemote(window.location.hostname) ? info.host : null}
              locked={creating}
            />
          )}
          {at === 1 && (
            <ComfyStep comfy={comfy} setComfy={setComfy} workflows={workflows} setWorkflows={setWorkflows} />
          )}
          {at === 2 && <TaggingStep images={images} capped={capped} checkout={info?.checkout ?? false} />}
          {at === 0 && createError && (
            <p role="alert" className="mt-4 max-w-[620px] whitespace-pre-wrap text-[13px] text-red-300">
              Some folders couldn't be added:
              {"\n"}
              {createError}
            </p>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line bg-canvas/90 px-6 py-3.5 backdrop-blur-md md:pl-[clamp(24px,5vw,72px)]">
          <ScanProgress ids={Object.values(created)} />
          <div className="ml-auto flex gap-2">
            {at > 0 && (
              <Button variant="ghost" onClick={() => setAt(at - 1)}>
                Back
              </Button>
            )}
            <Button
              variant="primary"
              disabled={(at === 0 && (!folders.length || counting)) || creating}
              onClick={() => void next()}
            >
              {nextLabel}
            </Button>
          </div>
          <button
            type="button"
            onClick={() => onLeave("skipped")}
            className="w-full text-center text-[12.5px] text-muted underline decoration-line-strong underline-offset-[3px] md:hidden"
          >
            Skip setup
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Scan progress of the libraries setup created. */
function ScanProgress({ ids }: { ids: string[] }) {
  // Polls on its own while setup is open: a library just created may not
  // read as scanning yet, which would stop the list's usual poll.
  const { data: libraries } = useLibraries({ idleMs: ids.length ? SCAN_POLL_MS : false });
  const mine = useMemo(() => (libraries ?? []).filter((l) => ids.includes(l._id)), [libraries, ids]);
  if (!mine.length) return <span />;
  const scanning = mine.some((l) => l.scanning);
  const total = mine.reduce((n, l) => n + (l.scan_total ?? 0), 0);
  const done = mine.reduce((n, l) => n + (l.scan_done ?? 0), 0);
  const indexed = mine.reduce((n, l) => n + (l.indexed_count ?? 0), 0);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2.5 text-[13px] tabular-nums text-muted" role="status">
      <Dot tone={scanning ? "busy" : "ok"} />
      {scanning ? (
        <>
          <span>{total ? `Scanning ${done.toLocaleString()} of ${total.toLocaleString()}` : "Scanning…"}</span>
          {total > 0 && (
            <span className="h-[3px] w-20 overflow-hidden rounded-sm bg-line md:w-36">
              <i
                className="block h-full bg-brand-400 transition-[width] duration-300"
                style={{ width: `${Math.min(100, (done / total) * 100)}%` }}
              />
            </span>
          )}
        </>
      ) : (
        <span>{indexed.toLocaleString()} images indexed</span>
      )}
    </div>
  );
}

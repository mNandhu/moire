import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { Section } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { ProgressBar } from "../components/ui/ProgressBar";
import { Switch } from "../components/ui/Switch";
import { Tooltip } from "../components/ui/Tooltip";
import {
  aboutDuration,
  coveragePct,
  isActiveJob,
  isStatusBusy,
  libraryCoverageRows,
  taggingSeconds,
  type AiEstimate,
  type AiLibraryCoverage,
} from "../lib/ai";
import { cn } from "../lib/cn";
import { libraryPageHref, useAiCoverage, useLibraries } from "../lib/queries";
import { AiControllerProvider, useAiController } from "../hooks/useAiController";
import { ModelStatusLine } from "../components/ai/ModelStatus";
import { ActiveJob, RecentJobs, ResetAiTags } from "../components/ai/AiJobs";

/** A thin AI-coverage bar shared by the global stat and per-library rows. */
function CoverageBar({ tagged, total }: { tagged: number; total: number }) {
  return <ProgressBar value={coveragePct(tagged, total)} />;
}

// PROTOTYPE: the run control in three versions, picked with ?variant= and the
// yellow chip. Delete the chip and the losers once one is chosen.
const VARIANTS = [
  { id: "all", name: "Tag all" },
  { id: "split", name: "Tag all + newest menu" },
  { id: "chips", name: "Amount chips" },
] as const;
type VariantId = (typeof VARIANTS)[number]["id"];

function useVariant(): [VariantId, (v: VariantId) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("variant");
  const id = VARIANTS.some((v) => v.id === raw) ? (raw as VariantId) : "all";
  const set = (v: VariantId) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("variant", v);
        return next;
      },
      { replace: true },
    );
  return [id, set];
}

function VariantChip() {
  const [id, set] = useVariant();
  const i = VARIANTS.findIndex((v) => v.id === id);
  const step = (d: number) => set(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length].id);
  return (
    <div className="fixed left-1/2 top-16 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-yellow-300 px-1.5 py-1 text-xs font-medium text-neutral-900 shadow-lg">
      <button type="button" aria-label="Previous variant" className="rounded-full p-1 hover:bg-yellow-200" onClick={() => step(-1)}>
        <ChevronLeft size={14} />
      </button>
      <span className="min-w-[11rem] text-center tabular-nums">
        {i + 1}/{VARIANTS.length} · {VARIANTS[i].name}
      </span>
      <button type="button" aria-label="Next variant" className="rounded-full p-1 hover:bg-yellow-200" onClick={() => step(1)}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

const DEVICE = { cpu: "CPU", gpu: "GPU" } as const;

/** "about 22 min", with how it was worked out when this computer hasn't
 * measured a run yet. */
function Estimate({ images, est, device = false }: { images: number; est: AiEstimate | undefined; device?: boolean }) {
  const secs = taggingSeconds(images, est);
  if (secs == null || !est) return null;
  const text = `${aboutDuration(secs)}${device ? ` on the ${DEVICE[est.device]}` : ""}`;
  if (est.measured) return <span>{text}</span>;
  return (
    <Tooltip content={`From a typical ${DEVICE[est.device]} speed. Your first long run measures this computer.`}>
      <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-[3px]">{text}</span>
    </Tooltip>
  );
}

const NEWEST = [100, 1000];

/** Start a run over the images without AI tags: the whole backlog by default. */
function RunControl({ remaining, est }: { remaining: number; est: AiEstimate | undefined }) {
  const [variant] = useVariant();
  const { running, runUntagged } = useAiController();
  const [amount, setAmount] = useState<number | null>(null);
  const newest = NEWEST.filter((n) => n < remaining);
  const tagAll = (
    <Button variant="primary" onClick={() => void runUntagged()} disabled={running}>
      <Sparkles size={16} />
      Tag all {remaining.toLocaleString()} {remaining === 1 ? "image" : "images"}
    </Button>
  );
  const time = (
    <span className="text-sm text-muted tabular-nums">
      <Estimate images={remaining} est={est} device />
    </span>
  );

  if (variant === "split") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-px">
          {tagAll}
          {newest.length > 0 && (
            <DropdownMenu
              aria-label="Tag fewer"
              variant="primary"
              icon={<ChevronDown size={16} />}
              items={newest.map((n) => {
                const secs = taggingSeconds(n, est);
                return {
                  label: `Tag the newest ${n.toLocaleString()}`,
                  hint: secs != null ? <span className="tabular-nums text-faint">{aboutDuration(secs)}</span> : undefined,
                  onClick: () => void runUntagged(undefined, n),
                };
              })}
            />
          )}
        </div>
        {time}
      </div>
    );
  }

  if (variant === "chips") {
    const chosen = amount != null && amount < remaining ? amount : null;
    const count = chosen ?? remaining;
    const options = [...newest.map((n) => ({ n, label: n.toLocaleString() })), { n: null, label: "All" }];
    return (
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="How many to tag" className="flex rounded-lg border border-line bg-sunken p-0.5">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={chosen === o.n}
              onClick={() => setAmount(o.n)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs tabular-nums text-muted hover:text-neutral-100",
                chosen === o.n && "bg-raised text-neutral-100",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <Button variant="primary" onClick={() => void runUntagged(undefined, chosen)} disabled={running}>
          <Sparkles size={16} />
          Tag {chosen == null ? "all " : ""}
          {count.toLocaleString()} {count === 1 ? "image" : "images"}
        </Button>
        <span className="text-sm text-muted tabular-nums">
          <Estimate images={count} est={est} device />
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {tagAll}
      {time}
    </div>
  );
}

/** Tag new images as they arrive, and whatever is left when switched on. */
function AutoTagSwitch() {
  const { autoTag, setAutoTag, running } = useAiController();
  return (
    <label className="ml-auto flex items-center gap-2 text-sm text-muted">
      <Switch on={autoTag} onChange={(on) => !running && void setAutoTag(on)} aria-label="Auto-tag new images" />
      Auto-tag new images
    </label>
  );
}

/**
 * Coverage and the action that changes it, in one place: how much is
 * AI-tagged, the run that tags the rest and how long it takes, the running
 * job, and only when it matters, the model. Counts come from
 * `/api/v1/ai/coverage` (the `has_ai_tags` flag) and poll faster while a
 * job runs.
 */
function TaggingPanel() {
  const { status, latestJob } = useAiController();
  const busy = isStatusBusy(status);
  const { data: cov } = useAiCoverage({ busy });
  const { data: libs } = useLibraries();
  const nameOf = (id: string) => {
    const l = libs?.find((x) => x._id === id);
    return l ? l.name || l.path : id;
  };

  const activeJob = latestJob && isActiveJob(latestJob.status) ? latestJob : null;
  const remaining = cov?.untagged ?? 0;
  const est = status?.estimate;

  return (
    <Section title="Coverage">
      {cov ? (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-end justify-between gap-3">
              <div className="text-3xl font-semibold tabular-nums text-neutral-100">
                {cov.ai_tagged.toLocaleString()}
                <span className="text-lg font-medium text-faint">
                  {" "}
                  / {cov.total.toLocaleString()}
                </span>
              </div>
              <div className="text-sm text-muted tabular-nums">
                {coveragePct(cov.ai_tagged, cov.total)}% AI-tagged
              </div>
            </div>
            <CoverageBar tagged={cov.ai_tagged} total={cov.total} />
          </div>

          <div className="pt-4 border-t border-line space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {activeJob ? (
                <div className="min-w-0 flex-1 basis-80">
                  <ActiveJob job={activeJob} />
                </div>
              ) : remaining === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <CheckCircle2 size={16} className="text-brand-300" />
                  Every image has AI tags.
                </div>
              ) : (
                <RunControl remaining={remaining} est={est} />
              )}
              <AutoTagSwitch />
            </div>
            <ModelStatusLine />
          </div>

          {cov.per_library.length > 1 && (
            <LibraryCoverage perLibrary={cov.per_library} nameOf={nameOf} est={est} />
          )}
        </div>
      ) : (
        <div className="text-sm text-faint">Loading coverage…</div>
      )}
    </Section>
  );
}

const SHOWN = 8;

/**
 * Coverage per library, as a list rather than a bar each: the libraries with
 * images left to tag, most first, each with its own run; the finished ones
 * folded into one line.
 */
function LibraryCoverage({
  perLibrary,
  nameOf,
  est,
}: {
  perLibrary: AiLibraryCoverage[];
  nameOf: (id: string) => string;
  est: AiEstimate | undefined;
}) {
  const { running, runUntagged } = useAiController();
  const [all, setAll] = useState(false);
  const { todo, done } = libraryCoverageRows(perLibrary, nameOf);
  const shown = all ? todo : todo.slice(0, SHOWN);

  return (
    <div className="pt-4 border-t border-line space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium text-neutral-200">Libraries</h4>
        {todo.length > 0 && (
          <span className="text-xs text-faint tabular-nums">
            {todo.length} of {perLibrary.length} not done
          </span>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="divide-y divide-line/60">
          {shown.map((l) => (
            <li
              key={l.library_id}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto_4rem_auto] items-center gap-3 py-1.5"
            >
              <Link
                to={libraryPageHref(l.library_id)}
                className="truncate text-sm text-neutral-300 hover:text-white"
              >
                {l.name}
              </Link>
              <span className="text-xs text-faint tabular-nums">{l.untagged.toLocaleString()} left</span>
              <span className="text-right text-xs text-faint tabular-nums">
                <Estimate images={l.untagged} est={est} />
              </span>
              <ProgressBar value={l.pct} className="h-1" aria-label={`${l.name}: ${l.pct}% AI-tagged`} />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => void runUntagged(l.library_id)}
                disabled={running}
              >
                <Sparkles size={12} /> Tag
              </Button>
            </li>
          ))}
        </ul>
      )}
      {todo.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-xs text-brand-300 hover:text-brand-200"
        >
          {all ? "Show fewer" : `Show all ${todo.length}`}
        </button>
      )}
      {done.length > 0 && (
        <details className="group text-xs text-faint">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-neutral-200">
            <CheckCircle2 size={14} className="text-brand-300" />
            {done.length === 1 ? "1 library" : `${done.length} libraries`} fully tagged
            <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-1.5 leading-relaxed">{done.map((l) => l.name).join(", ")}</p>
        </details>
      )}
    </div>
  );
}

export default function AITaggingPage() {
  return (
    <AiControllerProvider>
      <VariantChip />
      <PageHeader
        title="AI Tagging"
        description="Tag images with a local WD tagger model."
      />
      <PageBody className="space-y-5">
        <TaggingPanel />
        <RecentJobs />
        <ResetAiTags />
      </PageBody>
    </AiControllerProvider>
  );
}

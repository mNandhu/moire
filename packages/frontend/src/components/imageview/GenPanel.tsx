import React, { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Workflow } from "lucide-react";
import { errorText } from "../../lib/api";
import { imageDocKey } from "../../lib/feedCache";
import { galleryHref } from "../../lib/imageFilter";
import { fitLines } from "../../lib/fitLines";
import { useRemix, type RemixInfo } from "../../lib/generate";
import { useToast } from "../Toasts";
import { ResolvePromptDialog } from "../ResolvePromptDialog";
import { RemixButton, WorkflowLine } from "../generate/Remix";
import { BatchStrip } from "./BatchStrip";
import { TAB_ACTION, TabActions } from "./TabActions";

// A small key/value pill for the "Other metadata" row.
function MetaChip({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <span className="px-2 py-1 rounded-md bg-raised border border-line text-xs inline-flex items-center gap-1.5 tabular-nums">
      <span className="text-faint">{label}</span>
      <span className="text-neutral-100">{value}</span>
    </span>
  );
}

function ResourceRow({
  name,
  badge,
  sub,
  to,
}: {
  name: string;
  badge: string;
  sub?: string;
  /** Gallery link showing every image that used this resource. */
  to?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        {to ? (
          <Link
            to={to}
            className="block text-sm text-neutral-100 truncate hover:underline"
            title={`Show all images using ${name}`}
          >
            {name}
          </Link>
        ) : (
          <div className="text-sm text-neutral-100 truncate" title={name}>
            {name}
          </div>
        )}
        {sub && <div className="text-xs text-faint">{sub}</div>}
      </div>
      <span className="shrink-0 text-2xs px-1.5 py-0.5 rounded-md bg-raised border border-line text-muted">
        {badge}
      </span>
    </div>
  );
}

function CopyButton({ text, label }: { text?: string | null; label: string }) {
  const { push } = useToast();
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          push(`${label} copied`, "success");
        } catch (e) {
          push(`Copy failed: ${errorText(e)}`, "error");
        }
      }}
      className="p-1.5 rounded-md text-muted hover:text-white hover:bg-raised transition-colors"
      title={`Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      <Copy size={14} />
    </button>
  );
}

/** The details panel's scroller and the content inside it. */
export const PanelFit = React.createContext<{ scroller: HTMLElement; content: HTMLElement } | null>(null);

// "Show more" (a 16px line) and its top margin.
const TOGGLE_HEIGHT = 20;

/**
 * Prompt / negative-prompt text. With `fit` (the prompt: what most people
 * open an image for), it shows as many lines as fill the panel without making
 * it scroll, so a short panel isn't left empty below a clipped prompt nor a
 * full one pushed into scrolling; past that, "Show more". Otherwise 3 lines.
 */
function PromptBlock({ text, fit = false }: { text: string; fit?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState<number | null>(fit ? null : 3);
  const panel = React.useContext(PanelFit);
  const block = useRef<HTMLDivElement>(null);
  const para = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const box = block.current;
    const p = para.current;
    if (!box || !p || expanded) return;
    const measure = () => {
      // Hidden (the other tab is showing): nothing to measure; keep the clamp.
      if (!p.clientWidth) return;
      const lineHeight = parseFloat(getComputedStyle(p).lineHeight) || 20;
      if (!fit || !panel) {
        setLines(p.scrollHeight > 3 * lineHeight + 1 ? 3 : null);
        return;
      }
      // What the rest of the panel takes, whatever this block shows now.
      // Exact heights, not rounded offsets, and a hair of slack: rounding
      // left a 2px scroll at some panel heights.
      const others = panel.content.getBoundingClientRect().height - box.getBoundingClientRect().height;
      setLines(
        fitLines({
          available: panel.scroller.clientHeight - others - 2,
          lineHeight,
          fullHeight: p.scrollHeight,
          toggleHeight: TOGGLE_HEIGHT,
        }),
      );
    };
    measure();
    // Again when the panel resizes or the content around this block lands or
    // folds (characters, the outfit board, the workflow line, the other tab).
    // Committed at once: the observer runs before the frame paints, a plain
    // update after it, which showed the old clamp pushed down for a frame.
    const ro = new ResizeObserver(() => flushSync(measure));
    // Watch everything beside this block and its ancestors, never the text or
    // its ancestors: a clamp resizes those, and an observed element resized
    // from its own callback is a ResizeObserver loop. Rewatched as children
    // come and go, without re-observing a watched one: that restarts it, and
    // a restart from inside a frame's observer round is a loop too.
    const watched = new Set<Element>();
    const watch = () => {
      if (!panel) return;
      const next = new Set<Element>([panel.scroller]);
      for (let el: Element = box; el !== panel.content && el.parentElement; el = el.parentElement) {
        for (const sib of el.parentElement.children) if (sib !== el) next.add(sib);
      }
      for (const el of watched) if (!next.has(el)) ro.unobserve(el);
      for (const el of next) if (!watched.has(el)) ro.observe(el);
      watched.clear();
      next.forEach((el) => watched.add(el));
    };
    watch();
    const mo = panel ? new MutationObserver(watch) : null;
    mo?.observe(panel!.content, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [text, expanded, fit, panel]);
  const clamped = !expanded && lines != null;
  return (
    <div ref={block}>
      <p
        ref={para}
        className="text-sm text-neutral-300 whitespace-pre-wrap break-words"
        style={
          clamped
            ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }
            : undefined
        }
      >
        {text}
      </p>
      {(clamped || expanded) && (
        // A block, so it takes exactly TOGGLE_HEIGHT, not a taller line box.
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="block mt-1 text-xs text-brand-300 hover:text-brand-200"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// A prompt found by keywords (services/prompt_guess.py), not by following the
// workflow to its sampler.
function GuessedBadge({ onResolve }: { onResolve?: () => void }) {
  return (
    <>
    <span
      className="text-2xs px-1.5 py-0.5 rounded-md border border-amber-400/30 text-amber-300"
      title="Picked by keyword match: the workflow doesn't show where its prompt goes. Resolve it to be certain."
    >
      Guessed
    </span>
    {onResolve && (
      <button type="button" onClick={onResolve} className="text-2xs text-brand-300 hover:text-brand-200">
        Resolve
      </button>
    )}
    </>
  );
}

export function GenPanel({
  imageId,
  gen,
  width,
  height,
  onCopyAll,
  batchScope,
  thumbUrl,
}: {
  imageId: string;
  gen?: import("../../lib/gen").GenMeta | null;
  width?: number;
  height?: number;
  onCopyAll: () => void;
  /** The viewer's filters, less any batch grouping (serializeFiltersForPeek). */
  batchScope: string;
  thumbUrl?: string | null;
}) {
  const { data: remix } = useRemix(imageId, !!gen?.source);
  const [resolving, setResolving] = useState<"prompt" | "negative" | null>(null);
  const qc = useQueryClient();
  // The pin re-reads the workflow's images in the background: look again as it lands.
  const reread = () => {
    for (const ms of [800, 3000]) window.setTimeout(() => void qc.invalidateQueries({ queryKey: imageDocKey(imageId) }), ms);
  };
  if (!gen || !gen.source) return null;
  // Until the read lands (or if it fails), what the image's own data says,
  // so the header doesn't jump.
  const info: RemixInfo = remix ?? {
    image_id: imageId,
    source: gen.source,
    workflow:
      gen.source === "comfyui" && gen.workflow_sig
        ? { family: null, family_name: null, file_name: null, workflow_sig: gen.workflow_sig }
        : null,
    seed: gen.seed ?? null,
    batch: null,
  };
  const editRule = gen.workflow_sig && (
    <Link
      to={`/rules?sig=${encodeURIComponent(gen.workflow_sig)}`}
      className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
      title="Edit this workflow's extraction rule"
    >
      <Workflow size={12} /> Edit rule
    </Link>
  );
  return (
    <section className="px-4 py-4 space-y-4">
      {resolving && <ResolvePromptDialog open onClose={() => setResolving(null)} gen={gen} field={resolving} onSaved={reread} />}
      <TabActions>
        {!info.workflow && editRule}
        <RemixButton info={info} />
        {/* Copy sits last in every tab's actions. */}
        <button
          type="button"
          onClick={onCopyAll}
          className={TAB_ACTION}
          title="Copy all generation data"
          aria-label="Copy all generation data"
        >
          <Copy size={15} />
        </button>
      </TabActions>

      {info.workflow && (
        <div className="space-y-1.5 border-y border-line py-2">
          <WorkflowLine info={info} imageId={imageId} />
          {editRule}
        </div>
      )}

      {(gen.model || !!gen.loras?.length || !!gen.embeddings?.length) && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted">
            Resources used
          </div>
          {gen.model && (
            <ResourceRow
              name={gen.model}
              badge="Checkpoint"
              to={galleryHref({ model: gen.model })}
            />
          )}
          {gen.loras?.map((l) => (
            <ResourceRow
              key={l.name}
              name={l.name}
              badge="LoRA"
              sub={l.strength != null ? `Strength ${l.strength}` : undefined}
              to={galleryHref({ lora: [l.name] })}
            />
          ))}
          {gen.embeddings?.map((e) => (
            <ResourceRow
              key={`${e.name}:${e.negative}`}
              name={e.name}
              badge="Embedding"
              sub={e.negative ? "In the negative prompt" : undefined}
              to={galleryHref({ embedding: [e.name] })}
            />
          ))}
        </div>
      )}

      {gen.prompt && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">Prompt</div>
              <span className="text-2xs uppercase px-1.5 py-0.5 rounded-md bg-raised border border-line text-muted">
                {gen.source}
              </span>
              {gen.guessed?.includes("prompt") && <GuessedBadge onResolve={gen.workflow_sig ? () => setResolving("prompt") : undefined} />}
            </div>
            <CopyButton text={gen.prompt} label="Prompt" />
          </div>
          <PromptBlock text={gen.prompt} fit />
        </div>
      )}

      {gen.negative && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">Negative prompt</div>
              {gen.guessed?.includes("negative") && <GuessedBadge onResolve={gen.workflow_sig ? () => setResolving("negative") : undefined} />}
            </div>
            <CopyButton text={gen.negative} label="Negative prompt" />
          </div>
          <PromptBlock text={gen.negative} />
        </div>
      )}

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">
          Other metadata
        </div>
        <div className="flex flex-wrap gap-1.5">
          <MetaChip label="CFG" value={gen.cfg} />
          <MetaChip label="Steps" value={gen.steps} />
          <MetaChip label="Sampler" value={gen.sampler} />
          <MetaChip label="Seed" value={gen.seed} />
          <MetaChip label="Width" value={width} />
          <MetaChip label="Height" value={height} />
        </div>
      </div>

      {gen.group_id && <BatchStrip groupId={gen.group_id} scope={batchScope} currentId={imageId} currentThumb={thumbUrl} />}
    </section>
  );
}

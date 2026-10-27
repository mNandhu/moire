import React, { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Tooltip } from "../ui/Tooltip";
import { useTagMarks } from "../../hooks/useTagMarks";
import { characterHref, tagHref } from "../../lib/character";
import { splitBoilerplate } from "../../lib/boilerplate";
import { useBoilerplate, useTagFacets } from "../../lib/queries";
import { FACET_LABEL, FACET_TINT, TAG_TINT_CLASS, tagMarkStyle, type Facet } from "../../lib/tagColour";
import { adherenceGroups, formatWeight, tagName, type FlowTag, type TagGroup, type TagKind } from "../../lib/tags";


/** A tag's own page: the character page for a character, else the tag page. */
const tagPageHref = (t: FlowTag) =>
  (t.kind === "character" ? characterHref : tagHref)(tagName(t.raw));

const KIND_TEXT: Record<TagKind, string> = {
  character: "text-brand-300 font-semibold",
  ai: "text-neutral-100",
  manual: "text-emerald-300",
  // Not coloured apart: once AI-tagged, prompt-only tags sit under their own
  // heading, and before that every tag is one. Grey here read as "unsure".
  prompt: "text-neutral-100",
};
const KIND_NOUN: Record<TagKind, string> = {
  character: "Character",
  ai: "AI tag",
  manual: "Your tag",
  prompt: "Prompt tag",
};
const ALSO_TEXT = { manual: "yours", prompt: "in the prompt" } as const;

/** The hover bubble's second line: what the tag is, what else stored the
 * same name, and how sure the tagger was. */
function tagDetail(t: FlowTag): string {
  const parts = [KIND_NOUN[t.kind]];
  if (t.also?.length) parts.push(`also ${t.also.map((k) => ALSO_TEXT[k]).join(" and ")}`);
  if (t.confidence != null) parts.push(`${Math.round(t.confidence * 100)}% confident`);
  if (t.weight != null) parts.push(`prompted at ${formatWeight(t.weight)}`);
  return parts.join(" · ");
}

// One step, not a fade by confidence: a fade made sure tags look half-unsure
// and blurred into everything else drawn lighter. Below this, a tag is dimmed.
const UNSURE_BELOW = 0.5;
const UNSURE_OPACITY = 0.55;
const unsure = (t: FlowTag) => t.confidence != null && t.confidence < UNSURE_BELOW;

// The side panel's background (tailwind `surface`): what a rainbow-outlined
// tag paints inside its border.
const PANEL_GROUND = "#15141c";

// Prompt adherence groups, in reading order. The swatch colours the group's
// share of the summary bar: what the prompt got in brand, what the
// tagger added in a quieter brand, what the prompt missed in amber.
const GROUPS: { id: TagGroup; label: string; swatch: string }[] = [
  { id: "matched", label: "Prompted and seen", swatch: "bg-brand-400" },
  { id: "unprompted", label: "Seen, not prompted", swatch: "bg-brand-400/35" },
  { id: "missed", label: "Prompted, not seen", swatch: "bg-amber-400/80" },
  { id: "mine", label: "Your tags", swatch: "bg-emerald-400/80" },
];

// Tag runs: roomier than body text, so a long list reads as tags, not a wall.
const RUN_TEXT = "text-sm leading-8";

const FACET_ORDER = Object.keys(FACET_LABEL) as Facet[];

// How far a tag outside the picked facet fades.
const UNPICKED_OPACITY = 0.2;

/** A tag group's heading: a quiet caption with its count. With `onPick`,
 * a toggle that fades every other group's tags. */
function GroupHeading({
  label,
  count,
  picked,
  onPick,
}: {
  label: string;
  count: number;
  picked?: boolean;
  onPick?: () => void;
}) {
  const body = (
    <>
      {label}
      <span className="tabular-nums text-line-strong">{count}</span>
    </>
  );
  const cls = "mb-0.5 flex items-baseline gap-1.5 text-2xs uppercase tracking-wide";
  if (!onPick) return <div className={`${cls} text-faint`}>{body}</div>;
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      title={picked ? "Show all tags" : `Pick out the ${label} tags`}
      className={`${cls} ${picked ? "text-neutral-100" : "text-faint hover:text-neutral-200"}`}
    >
      {body}
    </button>
  );
}

/**
 * An image's tags as comma-separated runs, like a prompt: dense, easy to read
 * top to bottom and to copy. With both a prompt and AI tags, they split by
 * prompt adherence (lib/tags.ts adherenceGroups) under a bar of how much of
 * the prompt the tagger saw, and a tint marks each tag's facet (look,
 * outfit, pose...); otherwise by facet, under headings. An unsure AI tag is
 * dimmed one step, and hair and eye tags are outlined in their colour
 * (lib/tagColour.ts). Each tag opens its tag page (a character's, its
 * character page).
 */
export function TagFlow({ tags, trailing }: { tags: FlowTag[]; trailing?: React.ReactNode }) {
  const { data: facets } = useTagFacets();
  const facetOf = useCallback(
    (raw: string): Facet | null => facets?.[tagName(raw).toLowerCase()] ?? null,
    [facets],
  );
  // Boilerplate (Settings) folds into one quiet toggle at the end, so the
  // tags that describe this image lead instead of "masterpiece, best quality".
  const isBoilerplate = useBoilerplate();
  const { kept, boilerplate } = useMemo(
    () => splitBoilerplate(tags, (t) => t.raw, isBoilerplate),
    [tags, isBoilerplate],
  );
  const [showBoilerplate, setShowBoilerplate] = useState(false);
  const groups = useMemo(() => adherenceGroups(kept), [kept]);
  const shown = showBoilerplate ? [...kept, ...boilerplate] : kept;
  // Ungrouped, your own tags are told apart by colour alone: key it.
  const keyMine = !groups && kept.some((t) => t.kind === "manual");
  const marks = useTagMarks();
  // A facet picked from the key or a heading: the other tags fade, so its
  // own stand out where they are.
  const [chosen, setPicked] = useState<Facet | null>(null);
  const pick = (f: Facet) => setPicked((p) => (p === f ? null : f));
  // Only while a tag of it is on show (with its button to undo it): once its
  // last tag goes, or the layout drops the key, nothing stays faded.
  const picked = chosen && shown.some((t) => facetOf(t.raw) === chosen) ? chosen : null;
  const fade = (raw: string) => (picked && facetOf(raw) !== picked ? UNPICKED_OPACITY : 1);
  // Facet groups when there is no prompt/AI split to show; one run if every
  // tag lands in the same one (facets still loading, or all "other").
  const byFacet = useMemo(() => {
    if (groups) return null;
    const out = new Map<Facet | null, FlowTag[]>();
    for (const f of [...FACET_ORDER, null]) out.set(f, []);
    for (const t of kept) out.get(facetOf(t.raw))!.push(t);
    const filled = [...out].filter(([, list]) => list.length);
    return filled.length > 1 ? filled : null;
  }, [groups, kept, facetOf]);
  // Under facet headings the tints need no key.
  const shownFacets = marks.tints && !byFacet
    ? (Object.keys(FACET_TINT) as Facet[]).filter((f) => shown.some((t) => facetOf(t.raw) === f))
    : [];
  const run = (list: FlowTag[]) =>
    list.map((t, i) => (
      <React.Fragment key={t.raw}>
        <Tooltip
          bubble
          side="up"
          className="inline"
          content={
            <>
              <div className="font-medium">{t.label}</div>
              <div className="text-xs text-muted">{tagDetail(t)}</div>
            </>
          }
        >
          <Link
            to={tagPageHref(t)}
            className={`rounded px-0.5 -mx-0.5 ${TAG_TINT_CLASS} hover:bg-raised hover:underline ${KIND_TEXT[t.kind]}`}
            style={{
              ...tagMarkStyle(t.raw, facetOf(t.raw), PANEL_GROUND, marks),
              opacity: (unsure(t) ? UNSURE_OPACITY : 1) * fade(t.raw),
            }}
          >
            {t.label}
            {t.weight != null && (
              <span className="ml-0.5 text-[10px] tabular-nums text-amber-300">{formatWeight(t.weight)}</span>
            )}
          </Link>
        </Tooltip>
        {i < list.length - 1 && <span className="text-line-strong">, </span>}
      </React.Fragment>
    ));
  const boilerplateToggle = boilerplate.length > 0 && (
    <button
      type="button"
      onClick={() => setShowBoilerplate((v) => !v)}
      aria-expanded={showBoilerplate}
      title={
        showBoilerplate
          ? "Fold boilerplate tags away"
          : `Show ${boilerplate.length} boilerplate ${boilerplate.length === 1 ? "tag" : "tags"} (set in Settings)`
      }
      className="inline-flex items-center h-5 px-1.5 rounded-full border border-line text-2xs text-faint hover:text-neutral-100 hover:border-line-strong align-middle"
    >
      {showBoilerplate ? "fold boilerplate" : `+${boilerplate.length} boilerplate`}
    </button>
  );
  // What every layout ends on: boilerplate (folded, or shown dimmed after
  // its toggle) and the add-tags pill.
  const tail = (
    <>
      {boilerplateToggle}
      {showBoilerplate && <span className="opacity-50"> {run(boilerplate)}</span>}
      {boilerplate.length > 0 && trailing && " "}
      {trailing}
    </>
  );
  const asked = groups ? groups.matched.length + groups.missed.length : 0;
  return (
    <div className="space-y-4">
      {groups ? (
        <>
          {/* How much of the prompt shows in the image, and what came unasked. */}
          {asked > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-neutral-200">
                  <span className="text-sm font-semibold tabular-nums">{groups.matched.length}</span>
                  <span className="text-muted"> of {asked} prompted tags seen</span>
                </span>
                {groups.unprompted.length > 0 && (
                  <span className="text-faint tabular-nums">+{groups.unprompted.length} unprompted</span>
                )}
              </div>
              <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                {GROUPS.filter((g) => g.id !== "mine").map((g) =>
                  groups[g.id].length ? (
                    <div key={g.id} className={g.swatch} style={{ flexGrow: groups[g.id].length }} />
                  ) : null,
                )}
              </div>
            </div>
          )}
          {GROUPS.map((g) =>
            groups[g.id].length ? (
              <div key={g.id}>
                <GroupHeading label={g.label} count={groups[g.id].length} />
                <div className={RUN_TEXT}>{run(groups[g.id])}</div>
              </div>
            ) : null,
          )}
          {/* A div, not a p: the trailing add-tags field is a form. */}
          <div className={RUN_TEXT}>{tail}</div>
        </>
      ) : byFacet ? (
        <>
          {byFacet.map(([f, list]) => (
            <div key={f ?? "other"}>
              <GroupHeading
                label={f ? FACET_LABEL[f] : "other"}
                count={list.length}
                picked={!!f && picked === f}
                onPick={f ? () => pick(f) : undefined}
              />
              <div className={RUN_TEXT}>{run(list)}</div>
            </div>
          ))}
          <div className={RUN_TEXT}>{tail}</div>
        </>
      ) : (
        <div className={RUN_TEXT}>
          {run(kept)}
          {kept.length > 0 && " "}
          {tail}
        </div>
      )}
      {(keyMine || shown.some(unsure) || shownFacets.length > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-faint">
          {keyMine && <span className={KIND_TEXT.manual}>yours</span>}
          {shown.some(unsure) && <span style={{ opacity: UNSURE_OPACITY }}>fainter = less confident</span>}
          {shownFacets.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={picked === f}
              onClick={() => pick(f)}
              title={picked === f ? "Show all tags" : `Pick out the ${FACET_LABEL[f]} tags`}
              className={`rounded px-1 text-neutral-200 transition-opacity ${
                picked === f ? "ring-1 ring-neutral-300" : picked ? "opacity-50 hover:opacity-100" : ""
              }`}
              style={{ backgroundColor: FACET_TINT[f] }}
            >
              {FACET_LABEL[f]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

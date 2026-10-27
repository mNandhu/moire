import { useMemo } from "react";
import { AlertTriangle, Images, Play, Plus, Save, Trash2, Wand2, X } from "lucide-react";
import { Button, ButtonLink } from "../ui/Button";
import { generatorFor } from "../generate/InGenerate";
import type { GenMeta } from "../../lib/gen";
import type { Generator } from "../../lib/generate";
import { galleryHref } from "../../lib/imageFilter";
import {
  FIELD_LABEL,
  RULE_FIELDS,
  guessPath,
  type PreviewResult,
  type RuleField,
  type RuleFields,
  type SignatureRow,
} from "../../lib/rules";


// An unpinned field the sample only has by keyword guessing: where the text
// came from, a jump to it in the graph, and a one-click pin to make it certain.
function GuessedFrom({
  path,
  onReveal,
  onPin,
}: {
  path: string | null;
  onReveal: (path: string) => void;
  onPin: (path: string) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 text-2xs text-amber-300">
      <span className="shrink-0 px-1.5 rounded-md border border-amber-400/30">Guessed</span>
      {path ? (
        <>
          <button
            type="button"
            onClick={() => onReveal(path)}
            className="font-mono truncate hover:text-amber-200"
            title="Show it in the graph"
          >
            {path}
          </button>
          <button
            type="button"
            onClick={() => onPin(path)}
            className="shrink-0 inline-flex items-center gap-0.5 text-brand-300 hover:text-brand-200"
            title="Pin this value so it's no longer a guess"
          >
            <Plus size={11} /> Pin
          </button>
        </>
      ) : (
        <span className="text-faint">by keyword match</span>
      )}
    </span>
  );
}

/**
 * The selected version's rules: Preview / Save / Reset, then one card per
 * field with its pinned paths (green once a preview resolved them) or where
 * the sample guessed it from.
 */
export function RuleEditor({
  selected,
  fields,
  generators,
  preview,
  currentGen,
  activeField,
  onActiveField,
  busy,
  loading,
  loadFailed,
  isDirty,
  hasRuleset,
  onPreview,
  onSave,
  onRemove,
  onRemovePath,
  onPin,
  onReveal,
}: {
  selected: SignatureRow;
  fields: RuleFields;
  generators: Generator[] | undefined;
  preview: PreviewResult | null;
  /** What the sample's extraction says now, for fields only guessed. */
  currentGen: GenMeta | null | undefined;
  activeField: RuleField;
  onActiveField: (field: RuleField) => void;
  busy: boolean;
  loading: boolean;
  loadFailed: boolean;
  isDirty: boolean;
  hasRuleset: boolean;
  onPreview: () => void;
  onSave: () => void;
  onRemove: () => void;
  onRemovePath: (field: RuleField, path: string) => void;
  onPin: (field: RuleField, path: string) => void;
  onReveal: (path: string) => void;
}) {
  const previewGen = preview?.gen;
  const firedByField = useMemo(() => preview?.paths ?? {}, [preview]);
  return (

    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={onPreview} disabled={busy}>
          <Play size={14} /> Preview
        </Button>
        <Button
          variant="primary"
          onClick={onSave}
          disabled={busy || loading || loadFailed}
          title={loadFailed ? "Ruleset didn't load. Click the signature to retry" : undefined}
        >
          <Save size={14} /> Save
          {isDirty && (
            <span className="ml-1 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
          )}
        </Button>
        {/* Nothing to reset without saved pins, and the DELETE would
            still reproject every image of the signature. */}
        <Button
          variant="ghost"
          onClick={onRemove}
          disabled={busy || !hasRuleset}
          title={hasRuleset ? undefined : "Already using the built-in extraction"}
        >
          <Trash2 size={14} /> Reset to built-in
        </Button>
        {isDirty && (
          <span className="flex items-center gap-1 text-2xs text-amber-400">
            <AlertTriangle size={12} /> Unsaved changes
          </span>
        )}
        {/* This version's images (the family's are on its header). */}
        <ButtonLink
          variant="ghost"
          className="ml-auto"
          to={galleryHref({ workflowSig: selected.workflow_sig })}
          title={`The ${selected.count} ${selected.count === 1 ? "image" : "images"} made with this version`}
        >
          <Images size={14} /> Show in gallery
        </ButtonLink>
        {(() => {
          const gen = generatorFor(generators, { sig: selected.workflow_sig });
          return gen ? (
            <ButtonLink variant="ghost" to={`/generate?workflow=${encodeURIComponent(gen._id)}`}>
              <Wand2 size={14} /> Use this workflow
            </ButtonLink>
          ) : selected.sample_image_id ? (
            <ButtonLink
              variant="ghost"
              to={`/generate/workflows/new?image=${encodeURIComponent(selected.sample_image_id)}`}
            >
              <Wand2 size={14} /> Set up this workflow
            </ButtonLink>
          ) : null;
        })()}
      </div>

      {RULE_FIELDS.map((field) => (
        <div
          key={field}
          className={`rounded-lg border p-2.5 ${
            activeField === field
              ? "border-brand-500/60 bg-brand-500/5"
              : "border-line bg-surface"
          }`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <button
              onClick={() => onActiveField(field)}
              className="text-sm font-medium inline-flex items-center gap-1.5"
              title="Make this the target for tree clicks"
            >
              <Plus
                size={13}
                className={
                  activeField === field
                    ? "text-brand-300"
                    : "text-faint"
                }
              />
              {FIELD_LABEL[field]}
            </button>
            {previewGen != null && (
              <span className="text-2xs text-neutral-400 truncate max-w-[55%]">
                → {String((previewGen as Record<string, unknown>)[field] ?? "none")}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(fields[field] || []).map((p) => {
              const fired = (firedByField[field] || []).find(
                (r) => r.path === p,
              );
              const ok = fired && fired.coerced != null;
              return (
                <span
                  key={p}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-mono border ${
                    preview
                      ? ok
                        ? "bg-brand-500/15 border-brand-500/50 text-brand-100"
                        : "bg-raised border-line-strong text-muted"
                      : "bg-raised border-line-strong"
                  }`}
                  title={
                    fired ? `resolved: ${String(fired.coerced)}` : undefined
                  }
                >
                  {p}
                  <button
                    onClick={() => onRemovePath(field, p)}
                    className="hover:text-white"
                    aria-label={`Remove ${p}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              );
            })}
            {(fields[field] || []).length === 0 &&
              guessPath(currentGen, field) !== undefined && (
                <GuessedFrom
                  path={guessPath(currentGen, field) ?? null}
                  onReveal={onReveal}
                  onPin={(p) => onPin(field, p)}
                />
              )}
          </div>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Section } from "../../../components/ui/Card";
import { Skeleton } from "../../../components/ui/Skeleton";
import { useToast } from "../../../components/Toasts";
import { useConfirm } from "../../../components/ConfirmDialog";
import { ChipListEditor } from "../../../components/settings/ChipListEditor";
import { SaveBar } from "../../../components/settings/SaveBar";
import { useUnsavedChangesGuard } from "../../../hooks/useUnsavedChangesGuard";
import {
  TAG_SETTINGS_KEY,
  saveTagSettings,
  useTagAggregate,
  useTagSettings,
} from "../../../lib/queries";
import { compileBoilerplate, normalizeTagName } from "../../../lib/boilerplate";
import { formatTag } from "../../../lib/tags";
import { sameList } from "../../../lib/lists";
import { errorText } from "../../../lib/api";

const PREVIEW = 30;

/** A typed piece as a list entry: trimmed, lowercase; null when it is blank or
 * only wildcards. */
function boilerplateEntry(piece: string): string | null {
  const entry = piece.trim().toLowerCase();
  const key = normalizeTagName(entry);
  return !key || key.replace(/[*\s]/g, "") === "" ? null : entry;
}

/**
 * The boilerplate list: tags that ride along on nearly every prompt. Edited
 * as chips, with a live preview of which of the library's tags it catches,
 * because a pattern like `score_*` is only trustworthy once you see its
 * matches.
 */
export function BoilerplateSection() {
  const qc = useQueryClient();
  const { push } = useToast();
  const confirm = useConfirm();
  const { data: settings } = useTagSettings();
  const { data: tags } = useTagAggregate({ includePrompt: true });

  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  // Start (and restart after a save) from what the server holds.
  useEffect(() => {
    if (settings) setDraft(settings.boilerplate);
  }, [settings]);

  const dirty = !!settings && !!draft && !sameList(draft, settings.boilerplate);
  useUnsavedChangesGuard(dirty, confirm);

  // Distinct names the list catches, merged across sources, most used first.
  const matches = useMemo(() => {
    if (!draft || !tags) return null;
    const isBp = compileBoilerplate(draft);
    const byName = new Map<string, number>();
    for (const t of tags) {
      if (!isBp(t._id)) continue;
      const name = formatTag(t._id);
      byName.set(name, (byName.get(name) ?? 0) + t.count);
    }
    return [...byName.entries()].sort((a, b) => b[1] - a[1]);
  }, [draft, tags]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await saveTagSettings(draft);
      qc.setQueryData(TAG_SETTINGS_KEY, saved);
      push("Boilerplate list saved", "success");
    } catch (e) {
      push(`Failed to save: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const atDefaults =
    !!draft && !!settings && sameList(draft, settings.default_boilerplate);

  return (
    <div className="space-y-5">
      <Section
        title="Boilerplate tags"
        description="Tags that ride along on almost every prompt. They're folded away in the image view, hidden on the Tags page and suggested last in search. Searching and filtering by them still works."
      >
        {!draft ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-3">
            <ChipListEditor
              entries={draft}
              onChange={setDraft}
              toEntry={boilerplateEntry}
              keyOf={normalizeTagName}
              label="Boilerplate entries"
              addLabel="Add boilerplate entries"
              placeholder="Add tags or patterns, comma separated (score_*, best quality)"
              emptyText="Nothing is treated as boilerplate."
              entryClass={(entry) => (entry.includes("*") ? "font-mono" : undefined)}
            />
            <p className="text-xs text-faint">
              <span className="font-mono">*</span> matches anything. Case, and spaces vs
              underscores, don't matter. Applies to AI, manual and prompt tags alike.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="What this catches"
        description={
          matches
            ? `${matches.length.toLocaleString()} ${matches.length === 1 ? "tag" : "tags"} in your library, most used first.`
            : undefined
        }
      >
        {!matches ? (
          <Skeleton className="h-16 w-full" />
        ) : matches.length === 0 ? (
          <p className="text-sm text-faint">No tags in your library match this list.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {matches.slice(0, PREVIEW).map(([name, count]) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line text-xs text-muted"
              >
                {name}
                <span className="text-faint tabular-nums">{count.toLocaleString()}</span>
              </span>
            ))}
            {matches.length > PREVIEW && (
              <span className="inline-flex items-center h-7 px-1 text-xs text-faint">
                and {(matches.length - PREVIEW).toLocaleString()} more
              </span>
            )}
          </div>
        )}
      </Section>

      <SaveBar
        dirty={dirty}
        saving={saving}
        resetDisabled={!settings || atDefaults}
        onReset={() => settings && setDraft(settings.default_boilerplate)}
        onSave={() => void save()}
      />
    </div>
  );
}

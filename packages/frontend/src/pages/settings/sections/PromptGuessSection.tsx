import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Section } from "../../../components/ui/Card";
import { Skeleton } from "../../../components/ui/Skeleton";
import { useToast } from "../../../components/Toasts";
import { useConfirm } from "../../../components/ConfirmDialog";
import { ChipListEditor } from "../../../components/settings/ChipListEditor";
import { SaveBar } from "../../../components/settings/SaveBar";
import { useUnsavedChangesGuard } from "../../../hooks/useUnsavedChangesGuard";
import {
  GUESS_KEYWORDS_KEY,
  saveGuessKeywords,
  useGuessKeywords,
} from "../../../lib/queries";
import { canonicalName, formatTag } from "../../../lib/tags";
import { errorText } from "../../../lib/api";
import { sameList } from "../../../lib/lists";

/** Stored keyword form (mirrors prompt_guess.keyword_key on the backend). */
const keywordKey = (entry: string) => canonicalName(entry).toLowerCase();

/**
 * Keywords that give a prompt away when a workflow's graph doesn't say where
 * its prompt is (remote queues, prompts assembled by custom nodes). Every text
 * in the graph is scored by them; prompts found this way are marked Guessed.
 */
export function PromptGuessSection() {
  const qc = useQueryClient();
  const { push } = useToast();
  const confirm = useConfirm();
  const { data: settings } = useGuessKeywords();

  const [positive, setPositive] = useState<string[] | null>(null);
  const [negative, setNegative] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!settings) return;
    setPositive(settings.guess_positive);
    setNegative(settings.guess_negative);
  }, [settings]);

  const dirty =
    !!settings &&
    !!positive &&
    !!negative &&
    (!sameList(positive, settings.guess_positive) ||
      !sameList(negative, settings.guess_negative));
  useUnsavedChangesGuard(dirty, confirm);

  const atDefaults =
    !!settings &&
    !!positive &&
    !!negative &&
    sameList(positive, settings.default_positive) &&
    sameList(negative, settings.default_negative);

  const save = async () => {
    if (!positive || !negative) return;
    setSaving(true);
    try {
      const saved = await saveGuessKeywords(positive, negative);
      qc.setQueryData(GUESS_KEYWORDS_KEY, saved);
      push("Keywords saved. Prompts are being re-read in the background.", "success");
    } catch (e) {
      push(`Failed to save: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Section
        title="Guessing prompts"
        description="Some workflows don't wire their prompt into a sampler Moiré can follow, like remote queues or prompts built by custom nodes. For those, every text in the workflow is scored by these keywords: the best match becomes the prompt, and it's marked Guessed. Shown text beats stored text, then more matches, then the longer text."
      >
        {settings && (
          <p className="text-sm text-muted">
            {settings.guessed_images === 0
              ? "No image uses a guessed prompt right now."
              : `${settings.guessed_images.toLocaleString()} ${
                  settings.guessed_images === 1 ? "image uses" : "images use"
                } a guessed prompt. To be certain for a workflow, pin its prompt on the `}
            {settings.guessed_images > 0 && (
              <>
                <Link to="/rules" className="text-brand-300 hover:text-brand-200">
                  Rules page
                </Link>
                .
              </>
            )}
          </p>
        )}
      </Section>

      <Section
        title="Positive keywords"
        description="Words a positive prompt tends to carry."
      >
        {positive ? (
          <KeywordList label="positive" entries={positive} onChange={setPositive} />
        ) : (
          <Skeleton className="h-20 w-full" />
        )}
      </Section>

      <Section
        title="Negative keywords"
        description="Words a negative prompt tends to carry. A text needs more matches on one side than the other to count."
      >
        {negative ? (
          <KeywordList label="negative" entries={negative} onChange={setNegative} />
        ) : (
          <Skeleton className="h-20 w-full" />
        )}
      </Section>

      <SaveBar
        dirty={dirty}
        saving={saving}
        resetDisabled={!settings || atDefaults}
        onReset={() => {
          if (!settings) return;
          setPositive(settings.default_positive);
          setNegative(settings.default_negative);
        }}
        onSave={() => void save()}
      />
    </div>
  );
}

function KeywordList({
  label,
  entries,
  onChange,
}: {
  label: string;
  entries: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <ChipListEditor
      entries={entries}
      onChange={onChange}
      toEntry={(piece) => keywordKey(piece) || null}
      label={`${label} keywords`}
      addLabel={`Add ${label} keywords`}
      placeholder="Add keywords, comma separated"
      emptyText="No keywords: this side is never guessed."
      display={formatTag}
    />
  );
}

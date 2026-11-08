import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Section } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Picker } from "../../../components/ui/Picker";
import { useToast } from "../../../components/Toasts";
import { filterOptions, useSetFilterLevel } from "../../../components/SensitivityControl";
import { UnknownHiddenNotice } from "../../../components/SensitivityNotice";
import { errorText } from "../../../lib/api";
import { formatTag } from "../../../lib/tags";
import { RATINGS, type Rating } from "../../../lib/rating";
import { setTagLevel, useSensitivity, useTagLevels } from "../../../lib/queries/sensitivity";
import { fromOption, TAG_LEVEL_OPTIONS, toOption, type TagLevel } from "../../../lib/sensitivity";

const LEVEL_NAMES: Record<Rating, string> = {
  general: "General",
  sensitive: "Sensitive",
  questionable: "Questionable",
  explicit: "Explicit",
};

/** The Global Sensitivity Filter: what the whole app shows, and this
 * library's own tag levels. */
export function SensitivitySection() {
  return (
    <div className="space-y-6">
      <FilterCard />
      <TagLevelsCard />
    </div>
  );
}

function FilterCard() {
  const { data } = useSensitivity();
  const { set, saving } = useSetFilterLevel();
  return (
    <Section title="Sensitivity filter">
      <div className="space-y-4">
        <div className="max-w-xs">
          <Picker
            aria-label="Show"
            value={toOption(data?.max_level ?? null)}
            options={filterOptions(data)}
            onChange={(v) => void set(fromOption(v))}
            disabled={!data || saving}
          />
        </div>
        {data?.counts && (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {RATINGS.map((r) => (
              <div key={r} className="flex items-baseline gap-2">
                <dt className="text-faint">{LEVEL_NAMES[r]}</dt>
                <dd className="tabular-nums text-neutral-200">{data.counts.by_level[r].toLocaleString()}</dd>
              </div>
            ))}
            <div className="flex items-baseline gap-2">
              <dt className="text-faint">No level yet</dt>
              <dd className="tabular-nums text-neutral-200">{data.counts.unknown.toLocaleString()}</dd>
            </div>
          </dl>
        )}
        <UnknownHiddenNotice />
      </div>
    </Section>
  );
}

function TagLevelsCard() {
  const { data } = useTagLevels();
  const qc = useQueryClient();
  const { push } = useToast();
  const [tag, setTag] = useState("");
  const [level, setLevel] = useState<Rating>("sensitive");

  const save = async (name: string, to: Rating | null) => {
    try {
      await setTagLevel(qc, name, to);
    } catch (e) {
      push(`Couldn't save the level: ${errorText(e)}`, "error");
    }
  };
  const add = async () => {
    const name = tag.trim();
    if (!name) return;
    await save(name, level);
    setTag("");
  };

  const rows = data?.tags ?? [];
  const suggested = rows.filter((r) => r.source === "suggested").length;

  return (
    <Section
      title="Tag levels"
      actions={suggested > 0 ? <Badge tone="warning">{suggested.toLocaleString()} suggested</Badge> : undefined}
    >
      <div className="space-y-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input
            aria-label="Tag"
            placeholder="Tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="w-56"
          />
          <Picker aria-label="Level" value={level} options={TAG_LEVEL_OPTIONS} onChange={(v) => setLevel(v as Rating)} className="w-40" />
          <Button type="submit" size="sm" disabled={!tag.trim()}>
            Add
          </Button>
        </form>
        {rows.length > 0 && (
          <ul className="max-h-[28rem] overflow-y-auto divide-y divide-line rounded-lg border border-line">
            {rows.map((r) => (
              <TagLevelRow key={r.tag} row={r} onSave={save} />
            ))}
          </ul>
        )}
        {data && data.hidden > 0 && (
          <p role="status" className="text-sm text-faint">
            {data.hidden.toLocaleString()} more above the filter
          </p>
        )}
      </div>
    </Section>
  );
}

function TagLevelRow({ row, onSave }: { row: TagLevel; onSave: (tag: string, level: Rating | null) => Promise<void> }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate text-neutral-100">{formatTag(row.tag)}</span>
      <span className="tabular-nums text-faint">{row.images.toLocaleString()}</span>
      {row.source === "suggested" && (
        <>
          <Badge tone="warning">Suggested</Badge>
          <Button size="sm" variant="ghost" onClick={() => void onSave(row.tag, row.level)}>
            Keep
          </Button>
        </>
      )}
      <Picker
        aria-label={`Level of ${formatTag(row.tag)}`}
        value={row.level}
        options={TAG_LEVEL_OPTIONS}
        onChange={(v) => void onSave(row.tag, v as Rating)}
        className="w-36"
      />
      <Button size="iconSm" variant="ghost" aria-label={`Remove ${formatTag(row.tag)}`} onClick={() => void onSave(row.tag, null)}>
        <X size={14} />
      </Button>
    </li>
  );
}

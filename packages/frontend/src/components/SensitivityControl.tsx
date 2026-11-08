import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Shield, ShieldCheck } from "lucide-react";
import { cn } from "../lib/cn";
import { errorText } from "../lib/api";
import { setFilterLevel, useSensitivity } from "../lib/queries/sensitivity";
import {
  FILTER_OPTIONS,
  filterLabel,
  fromOption,
  hiddenCount,
  toOption,
  type FilterLevel,
  type SensitivityState,
} from "../lib/sensitivity";
import { useToast } from "./Toasts";
import { Picker } from "./ui/Picker";
import { Tooltip } from "./ui/Tooltip";

/** Each choice, with how many images it would hide. */
export function filterOptions(state: SensitivityState | undefined) {
  return FILTER_OPTIONS.map((o) => {
    const n = state?.counts ? hiddenCount({ ...state, max_level: fromOption(o.value) }) : 0;
    return { ...o, hint: n ? `${n.toLocaleString()} hidden` : undefined };
  });
}

/** Set the filter, refetching everything; a failure is a toast. */
export function useSetFilterLevel() {
  const qc = useQueryClient();
  const { push } = useToast();
  const [saving, setSaving] = useState(false);
  const set = async (max: FilterLevel | null) => {
    setSaving(true);
    try {
      await setFilterLevel(qc, max);
    } catch (e) {
      push(`Couldn't change the filter: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };
  return { set, saving };
}

/** The page header's Global Sensitivity Filter: a shield at the top right,
 * green while the filter is on. */
export function SensitivityControl() {
  const { data } = useSensitivity();
  const { set, saving } = useSetFilterLevel();
  const max = data?.max_level ?? null;
  const on = max !== null;
  if (!data?.counts) return null;
  const hidden = hiddenCount(data);
  const Icon = on ? ShieldCheck : Shield;
  const label = filterLabel(max);

  return (
    <Picker
      aria-label="Sensitivity filter"
      value={toOption(max)}
      options={filterOptions(data)}
      onChange={(v) => void set(fromOption(v))}
      disabled={saving}
      align="right"
      portal
      trigger={({ open }) => {
        const icon = (
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-raised",
              on ? "text-emerald-300" : "text-faint hover:text-neutral-100",
              open && "bg-raised",
            )}
          >
            <Icon size={18} />
          </span>
        );
        // No bubble over the open list.
        return open ? (
          icon
        ) : (
          <Tooltip content={hidden ? `${label} · ${hidden.toLocaleString()} hidden` : label} bubble>
            {icon}
          </Tooltip>
        );
      }}
    />
  );
}

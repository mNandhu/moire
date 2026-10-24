import { useCallback, useMemo, useRef, useState } from "react";
import {
  deleteRuleset,
  fetchRuleset,
  fetchWorkflow,
  saveRuleset,
  type RuleField,
  type RuleFields,
  type SignatureRow,
} from "../lib/rules";
import { errorText } from "../lib/api";

/**
 * One editing session over a signature's extraction Ruleset.
 *
 * There are four ways to leave or lose an edit: browser unload, in-app
 * navigation, switching signature, deleting the ruleset, and they used to
 * re-implement the dirty check three different ways with no shared definition
 * of dirty. Worse, the baseline ref was reassigned in three separate places;
 * missing one leaves the page permanently dirty, so every subsequent navigation
 * prompts about changes that were already saved.
 *
 * This owns the loaded-vs-edited state, the single definition of dirty, and
 * every transition that resets the baseline (load / save / delete). The page
 * renders it; useUnsavedChangesGuard wires the exit paths to `isDirty`.
 *
 * See CONTEXT.md › Generation metadata for what a Ruleset does.
 */

export type RulesetSession = {
  selected: SignatureRow | null;
  fields: RuleFields;
  graph: unknown;
  isDirty: boolean;
  busy: boolean;
  /**
   * The ruleset failed to load. The editor is empty, not the server's state,
   * so saving would overwrite the real ruleset; save is refused until a
   * reload (clicking the signature again) succeeds.
   */
  loadFailed: boolean;
  /** The selected signature's ruleset is still loading; save is refused. */
  loading: boolean;
  /** Switch to another signature, guarding unsaved edits first. */
  selectSig: (row: SignatureRow) => Promise<void>;
  pinPath: (field: RuleField, path: string) => void;
  removePath: (field: RuleField, path: string) => void;
  save: () => Promise<void>;
  remove: () => Promise<void>;
};

export type ConfirmDiscard = (opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  tone?: "default" | "warning" | "danger";
}) => Promise<boolean>;

const nativeConfirm: ConfirmDiscard = async ({ title, message }) =>
  window.confirm(message ? `${title}\n\n${message}` : title);

/**
 * Comparable form of a field map: empty pin lists dropped, keys sorted. Pinning
 * then unpinning a path leaves `{model: []}`, and the server may return keys
 * in another order; neither is an edit.
 */
function canonical(fields: RuleFields): string {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(fields).sort()) {
    const v = fields[k as RuleField];
    if (v && v.length) out[k] = v;
  }
  return JSON.stringify(out);
}

export function useRulesetSession({
  notify,
  onSaved,
  confirmDiscard = nativeConfirm,
}: {
  notify: (message: string, kind: "success" | "error" | "info") => void;
  /** Refresh the signature list after a save or delete changes it. */
  onSaved?: () => void;
  confirmDiscard?: ConfirmDiscard;
}): RulesetSession {
  const [selected, setSelected] = useState<SignatureRow | null>(null);
  const [fields, setFields] = useState<RuleFields>({});
  const [graph, setGraph] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  // The last state the server agreed with. Every transition that makes the
  // server agree again must come back through `commit`.
  const baseline = useRef<RuleFields>({});
  const [baselineVersion, setBaselineVersion] = useState(0);

  // Which signature the editor currently belongs to. Every async step checks
  // it after its await: a load or save that resolves after the user switched
  // away must not write into the new signature's editor (stale pins showing
  // under the wrong workflow, or A's fields becoming B's baseline and leaving
  // B permanently "unsaved").
  const currentSig = useRef<string | null>(null);

  const commit = useCallback((next: RuleFields) => {
    baseline.current = next;
    setBaselineVersion((v) => v + 1);
  }, []);

  const isDirty = useMemo(
    () => canonical(fields) !== canonical(baseline.current),
    // baselineVersion is the dependency that makes a commit re-evaluate this;
    // baseline.current is a ref and cannot be one.
    [fields, baselineVersion],
  );

  const selectSig = useCallback(
    async (row: SignatureRow) => {
      if (row.workflow_sig === currentSig.current && !loadFailed) return;
      if (
        isDirty &&
        !(await confirmDiscard({
          title: "Discard unsaved changes?",
          message: "This signature has pins that haven't been saved.",
          confirmLabel: "Discard and switch",
          tone: "warning",
        }))
      ) {
        return;
      }
      const sig = row.workflow_sig;
      currentSig.current = sig;
      // Reset synchronously: the previous signature's pins must never show
      // (or be savable) under this one, even while, or if, the load fails.
      setSelected(row);
      setLoadFailed(false);
      setLoading(true);
      commit({});
      setFields({});
      setGraph(null);

      // Independent: a missing sample graph shouldn't block editing the rules.
      const [rs, wf] = await Promise.allSettled([
        fetchRuleset(sig),
        fetchWorkflow(row.sample_image_id),
      ]);
      if (currentSig.current !== sig) return;
      setLoading(false);

      if (rs.status === "fulfilled") {
        const loaded = rs.value.fields || {};
        commit(loaded);
        setFields(loaded);
      } else {
        setLoadFailed(true);
        notify(`Failed to load ruleset: ${String(rs.reason)}`, "error");
      }

      if (wf.status === "fulfilled") {
        // Root the tree at the raw doc so pinned paths read `prompt.<node>...`,
        // matching the backend's resolve_path.
        const w = wf.value as { prompt?: unknown; workflow?: unknown } | null;
        const g: Record<string, unknown> = {};
        if (w && w.prompt != null) g.prompt = w.prompt;
        if (w && w.workflow != null) g.workflow = w.workflow;
        setGraph(g);
      } else {
        notify(`Failed to load sample graph: ${String(wf.reason)}`, "error");
        setGraph({});
      }
    },
    [isDirty, loadFailed, confirmDiscard, commit, notify],
  );

  const pinPath = useCallback((field: RuleField, path: string) => {
    setFields((f) => {
      const cur = f[field] || [];
      if (cur.includes(path)) return f;
      return { ...f, [field]: [...cur, path] };
    });
  }, []);

  const removePath = useCallback((field: RuleField, path: string) => {
    setFields((f) => ({
      ...f,
      [field]: (f[field] || []).filter((p) => p !== path),
    }));
  }, []);

  const save = useCallback(async () => {
    if (!selected) return;
    // Until the load lands the editor shows {}, not the server's ruleset,
    // so saving now would wipe it.
    if (loading) return;
    if (loadFailed) {
      notify("Ruleset didn't load. Click the signature to retry before saving", "error");
      return;
    }
    const sig = selected.workflow_sig;
    const snapshot = fields;
    setBusy(true);
    try {
      await saveRuleset(sig, snapshot);
      // Only re-baseline if the editor still shows what was saved.
      if (currentSig.current === sig) commit(snapshot);
      notify("Ruleset saved · reprojecting this signature", "success");
      onSaved?.();
    } catch (e) {
      notify(`Save failed: ${errorText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [selected, loading, loadFailed, fields, commit, notify, onSaved]);

  const remove = useCallback(async () => {
    if (!selected) return;
    const sig = selected.workflow_sig;
    if (
      !(await confirmDiscard({
        title: "Reset to built-in extraction?",
        message: "Your pins for this workflow are removed and its images are re-read with the built-in rules.",
        confirmLabel: "Reset",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      await deleteRuleset(sig);
      if (currentSig.current === sig) {
        commit({});
        setFields({});
      }
      notify("Reset to built-in extraction · reprojecting this workflow", "info");
      onSaved?.();
    } catch (e) {
      notify(`Reset failed: ${errorText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [selected, confirmDiscard, commit, notify, onSaved]);

  return {
    selected,
    fields,
    graph,
    isDirty,
    busy,
    loadFailed,
    loading,
    selectSig,
    pinPath,
    removePath,
    save,
    remove,
  };
}

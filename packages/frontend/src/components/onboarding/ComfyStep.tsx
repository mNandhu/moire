import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/Button";
import { errorText } from "../../lib/api";
import { filesFromDrop } from "../../lib/dropFiles";
import { GEN_KEY, putSettings, testConnection } from "../../lib/generate";
import { plural } from "../../lib/onboarding";
import { readWorkflowFiles } from "../../lib/workflows";
import { cn } from "../../lib/cn";
import { Group, Help, InlineField, Optional, StatusLine, StepHeading } from "./parts";

export type ComfyState = {
  address: string;
  phase: "idle" | "checking" | "connected" | "failed";
  error?: string | null;
};

export type WorkflowRead = {
  /** The picked folder's name, or "the dropped files". */
  from: string;
  items: { name: string; nodes: number }[];
  skipped: number;
  error?: string | null;
};

export function comfySummary(comfy: ComfyState, workflows: WorkflowRead | null): string {
  const parts = [comfy.phase === "connected" ? "Connected" : "Not connected"];
  if (workflows?.items.length) parts.push(plural(workflows.items.length, "workflow"));
  return parts.join(" · ");
}

const isJson = (name: string) => /\.json$/i.test(name);

/**
 * Step 2, both parts optional. The address is saved and checked the way
 * Settings › ComfyUI does it. Saved workflows are read in the browser (only
 * each file's id, name and node types are sent), as on the Rules page.
 */
export function ComfyStep({
  comfy,
  setComfy,
  workflows,
  setWorkflows,
}: {
  comfy: ComfyState;
  setComfy: (c: ComfyState) => void;
  workflows: WorkflowRead | null;
  setWorkflows: (w: WorkflowRead | null) => void;
}) {
  const qc = useQueryClient();
  const folderInput = useRef<HTMLInputElement | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const connect = async () => {
    const address = comfy.address.trim();
    if (!address) return;
    setComfy({ address, phase: "checking" });
    try {
      await putSettings({ address });
      const r = await testConnection();
      setComfy({ address, phase: r.ok ? "connected" : "failed", error: r.error });
    } catch (e) {
      setComfy({ address, phase: "failed", error: errorText(e) });
    }
    void qc.invalidateQueries({ queryKey: GEN_KEY });
  };

  const disconnect = async () => {
    setComfy({ ...comfy, phase: "checking" });
    try {
      await putSettings({ address: "" });
      setComfy({ address: comfy.address, phase: "idle" });
    } catch (e) {
      setComfy({ ...comfy, phase: "failed", error: errorText(e) });
    }
    void qc.invalidateQueries({ queryKey: GEN_KEY });
  };

  const read = async (files: File[], from: string) => {
    const json = files.filter((f) => isJson(f.name));
    setReading(true);
    try {
      const { parsed } = await readWorkflowFiles(json);
      setWorkflows({
        from,
        items: parsed.map((w) => ({ name: w.filename, nodes: w.node_types.length })),
        skipped: files.length - parsed.length,
      });
    } catch (e) {
      setWorkflows({ from, items: [], skipped: 0, error: errorText(e) });
    } finally {
      setReading(false);
    }
  };

  const connected = comfy.phase === "connected";
  const n = workflows?.items.length ?? 0;

  return (
    <section aria-labelledby="h-comfy" className="max-w-[620px] animate-fade-in">
      <StepHeading id="h-comfy" title="ComfyUI">
        Both settings are optional. Skip this step if you don't use ComfyUI.
      </StepHeading>
      <Group>
        <label htmlFor="ob-comfy" className="mb-1 block font-medium">
          Address<Optional>for Generate</Optional>
        </label>
        <Help>Moiré queues prompts on this ComfyUI. What it makes lands in your output folder like any other image.</Help>
        <InlineField
          id="ob-comfy"
          autoFocus
          value={comfy.address}
          readOnly={connected}
          invalid={comfy.phase === "failed"}
          onChange={(e) => setComfy({ address: e.target.value, phase: "idle" })}
          onCommit={() => void (connected ? disconnect() : connect())}
          action={
            <Button
              type="submit"
              size="sm"
              disabled={comfy.phase === "checking" || (!connected && !comfy.address.trim())}
            >
              {connected ? "Disconnect" : comfy.phase === "failed" ? "Try again" : "Connect"}
            </Button>
          }
        />
        {comfy.phase === "checking" && <StatusLine tone="busy">Checking…</StatusLine>}
        {connected && <StatusLine tone="ok">Connected. Generate will show in the sidebar.</StatusLine>}
        {comfy.phase === "failed" && (
          <StatusLine tone="bad">
            Nothing answered at that address{comfy.error ? ` (${comfy.error})` : ""}. Start ComfyUI, or check the
            address.
          </StatusLine>
        )}
      </Group>
      <Group>
        <span className="mb-1 block font-medium">
          Saved workflows<Optional>for extraction rules</Optional>
        </span>
        <Help>
          Moiré groups images by the workflow that made them. Pick ComfyUI's workflows folder, usually{" "}
          <code>ComfyUI\user\default\workflows</code>, and each group is named after its file. Only each file's id,
          name and node types are kept.
        </Help>
        <div
          className={cn(
            "-m-2 flex flex-wrap items-center gap-2.5 rounded-lg border border-dashed p-2 transition-colors",
            dragging ? "border-brand-400 bg-brand-600/10" : "border-transparent",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void filesFromDrop(e.dataTransfer, isJson).then((files) => read(files, "the dropped files"));
          }}
        >
          <Button size="sm" disabled={reading} onClick={() => folderInput.current?.click()}>
            {reading ? "Reading…" : workflows ? "Choose another folder…" : "Choose folder…"}
          </Button>
          <span className="text-[13px] text-faint [&_code]:text-muted">
            {!workflows ? (
              "or drop the files here"
            ) : workflows.error ? (
              <span className="text-red-300">{workflows.error}</span>
            ) : n ? (
              <>
                {plural(n, "workflow")} read from <code>{workflows.from}</code>
                {workflows.skipped ? `, ${plural(workflows.skipped, "other file")} skipped` : ""}
              </>
            ) : (
              <span className="text-amber-300">
                No ComfyUI workflows in <code>{workflows.from}</code>. They're .json files with a <code>nodes</code>{" "}
                list.
              </span>
            )}
          </span>
          {/* webkitdirectory picks a whole folder, subfolders included. */}
          <input
            ref={folderInput}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              const root = files[0]?.webkitRelativePath.split("/")[0] || "that folder";
              void read(files, root);
              e.target.value = "";
            }}
          />
        </div>
        {n > 0 && (
          <div className="mt-2.5 columns-2 gap-6 text-[13px] [column-width:200px]">
            {workflows!.items.map((w, i) => (
              <div key={`${i}:${w.name}`} className="flex break-inside-avoid justify-between gap-2.5 border-b border-line py-1.5">
                <span className="min-w-0 truncate">{w.name}</span>
                <span className="whitespace-nowrap tabular-nums text-faint">{plural(w.nodes, "node")}</span>
              </div>
            ))}
          </div>
        )}
      </Group>
    </section>
  );
}

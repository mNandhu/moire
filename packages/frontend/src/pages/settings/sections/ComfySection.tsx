import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, X } from "lucide-react";
import { Section } from "../../../components/ui/Card";
import { Badge, Button, Input, Picker } from "../../../components/ui";
import { ComfyStatusLine } from "../../../components/generate/ComfyStatusLine";
import {
  GEN_KEY,
  HEADER_MASK,
  MODELS_KEY,
  SETTINGS_KEY,
  putSettings,
  refreshModels,
  setLoraChoice,
  testConnection,
  useComfyModels,
  useComfySettings,
  type ComfySettings,
  type LoraMatch,
} from "../../../lib/generate";
import { useToast } from "../../../components/Toasts";

type HeaderRow = { name: string; value: string };

function MatchRow({ m, onPick }: { m: LoraMatch; onPick: (name: string) => void }) {
  let status: React.ReactNode;
  if (!m.files.length) status = <Badge tone="neutral">Not installed</Badge>;
  else if (!m.name) status = <Badge tone="warning">Choose one</Badge>;
  else status = <Badge tone="success">Matched</Badge>;
  return (
    <tr className="border-t border-line">
      <td className="py-2 pr-3 font-mono text-xs text-neutral-100">{m.stem}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-xs text-muted">{m.images.toLocaleString()}</td>
      <td className="py-2 pr-3 text-xs">
        {m.files.length > 1 ? (
          <span title="Two files share this name">
            <Picker
              aria-label={`File for ${m.stem}`}
              value={m.name ?? ""}
              options={m.files.map((f) => ({ value: f, label: f }))}
              onChange={onPick}
              placeholder={`Choose one of ${m.files.length} files`}
            />
          </span>
        ) : (
          <span className="font-mono text-muted">{m.files[0] ?? "none"}</span>
        )}
      </td>
      <td className="py-2 text-right">{status}</td>
    </tr>
  );
}

/** ComfyUI: connection, output folder, installed models and LoRA matching. */
export function ComfySection() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: settings } = useComfySettings();
  const { data: models } = useComfyModels();
  const [address, setAddress] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [outputPath, setOutputPath] = useState("");
  const [perRequest, setPerRequest] = useState(1);

  useEffect(() => {
    if (!settings) return;
    setAddress(settings.address);
    setHeaders(Object.entries(settings.headers).map(([name, value]) => ({ name, value })));
    setOutputPath(settings.output_path ?? "");
    setPerRequest(settings.builtin_per_request);
  }, [settings]);

  const save = useMutation({
    mutationFn: (patch: Partial<ComfySettings> & { output_path?: string | null }) => putSettings(patch),
    onSuccess: (s) => {
      qc.setQueryData(SETTINGS_KEY, s);
      void qc.invalidateQueries({ queryKey: GEN_KEY });
    },
    onError: (e) => toast.push(e.message, "error"),
  });
  const test = useMutation({
    mutationFn: async () => {
      await putSettings({
        address,
        headers: Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])),
      });
      return testConnection();
    },
    onSuccess: (r) => {
      toast.push(r.ok ? "Connected" : `Can't reach ComfyUI${r.error ? `: ${r.error}` : ""}`, r.ok ? "success" : "error");
      void qc.invalidateQueries({ queryKey: GEN_KEY });
    },
    onError: (e) => toast.push(e.message, "error"),
  });
  const refresh = useMutation({
    mutationFn: refreshModels,
    onSuccess: (m) => qc.setQueryData(MODELS_KEY, m),
    onError: (e) => toast.push(e.message, "error"),
  });
  const choose = useMutation({
    mutationFn: ({ stem, name }: { stem: string; name: string }) => setLoraChoice(stem, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: MODELS_KEY }),
  });

  const matched = models?.matching.filter((m) => m.name).length ?? 0;
  const needChoice = models?.matching.filter((m) => m.files.length > 1 && !m.name).length ?? 0;

  return (
    <div className="space-y-5">
      <Section title="Connection" actions={<ComfyStatusLine withActions={false} />}>
        <div className="space-y-4">
          <div>
            <label htmlFor="comfy-address" className="mb-1.5 block text-xs font-medium text-muted">
              Address
            </label>
            <div className="flex gap-2">
              <Input
                id="comfy-address"
                value={address}
                placeholder="127.0.0.1:8188"
                onChange={(e) => setAddress(e.target.value)}
                className="font-mono"
              />
              <Button onClick={() => test.mutate()} disabled={!address.trim() || test.isPending}>
                Test
              </Button>
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">
              <span title="Sent with every request to ComfyUI, for a proxied or secured server. Kept on this machine.">
                Request headers (optional)
              </span>
            </div>
            <div className="space-y-2">
              {headers.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    aria-label="Header name"
                    placeholder="Authorization"
                    value={h.name}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className="w-48 font-mono"
                  />
                  <Input
                    aria-label="Header value"
                    type={h.value === HEADER_MASK ? "text" : "password"}
                    value={h.value}
                    onFocus={() => {
                      if (h.value === HEADER_MASK) setHeaders(headers.map((x, j) => (j === i ? { ...x, value: "" } : x)));
                    }}
                    onBlur={() => {
                      // Left empty: keep the stored secret rather than erase it.
                      if (!h.value && settings?.headers[h.name] === HEADER_MASK)
                        setHeaders(headers.map((x, j) => (j === i ? { ...x, value: HEADER_MASK } : x)));
                    }}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    className="font-mono"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove header"
                    onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                  >
                    <X size={15} />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setHeaders([...headers, { name: "", value: "" }])}>
                <Plus size={14} /> Add header
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Output folder">
        <div className="flex gap-2">
          <Input
            aria-label="Output folder"
            value={outputPath}
            placeholder="ComfyUI/output"
            onChange={(e) => setOutputPath(e.target.value)}
            className="font-mono"
            title="ComfyUI's output folder; Moiré adds it as a library, or reuses one at that path"
          />
          <Button
            onClick={() => save.mutate({ output_path: outputPath })}
            disabled={save.isPending || outputPath === (settings?.output_path ?? "")}
          >
            Save
          </Button>
        </div>
      </Section>

      <Section title="Built-in Generator">
        <label className="flex items-center justify-between gap-4 text-sm">
          <span className="text-neutral-200" title="The most images ComfyUI makes at once in one request">
            Images per request
          </span>
          <Input
            type="number"
            min={1}
            max={64}
            value={perRequest}
            onChange={(e) => setPerRequest(Number(e.target.value) || 1)}
            onBlur={() => perRequest !== settings?.builtin_per_request && save.mutate({ builtin_per_request: perRequest })}
            className="w-20 text-right tabular-nums"
          />
        </label>
      </Section>

      <Section
        title="Installed models"
        actions={
          <Button size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw size={13} className={refresh.isPending ? "animate-spin" : undefined} /> Refresh
          </Button>
        }
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5 text-sm">
          {[
            ["Checkpoints", models?.checkpoints.length ?? 0],
            ["LoRAs", models?.loras.length ?? 0],
            ["Embeddings", models?.embeddings.length ?? 0],
            ["Matched to library", matched],
            ["Need a choice", needChoice],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-line px-3 py-2">
              <dt className="text-xs text-faint">{k}</dt>
              <dd className="tabular-nums text-neutral-100">{Number(v).toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {!!models?.matching.length && (
        <Section title="LoRAs your images use">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-faint">
                <th className="pb-2 pr-3 font-normal">In your images</th>
                <th className="pb-2 pr-3 text-right font-normal">Images</th>
                <th className="pb-2 pr-3 font-normal">ComfyUI file</th>
                <th className="pb-2 text-right font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {models.matching.map((m) => (
                <MatchRow key={m.stem} m={m} onPick={(name) => choose.mutate({ stem: m.stem, name })} />
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}


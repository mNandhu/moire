import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Section } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { ProgressBar } from "../../../components/ui/ProgressBar";
import { Picker } from "../../../components/ui/Picker";
import { api } from "../../../lib/api";
import { SETTINGS_KEY, putSettings, useComfySettings, type ComfySettings } from "../../../lib/generate";
import { useToast } from "../../../components/Toasts";
import { TAGS_KEY } from "../../../lib/queries";
import { taskPct } from "../../../lib/backgroundTasks";
import { formatBytes } from "../../../lib/format";
import { useSettings } from "../SettingsContext";

type FaceStatus = {
  model: string;
  enabled: boolean;
  downloaded: boolean;
  download: {
    status: string;
    error: string | null;
    cancel_requested: boolean;
    done: number | null;
    total: number | null;
  };
  /** Avatar images waiting to be looked at. */
  pending: number;
};

const FACES_KEY = ["ai", "faces"] as const;

/**
 * Character avatars: the optional face detector that crops them to the
 * face. Nothing downloads until the user asks; once it's there, avatars are
 * looked at in the background and the character pages pick that up.
 */
export function CharactersSection() {
  const qc = useQueryClient();
  const { settings, setSettings, saving, save } = useSettings();
  const { data: faces } = useQuery({
    queryKey: FACES_KEY,
    queryFn: ({ signal }) => api<FaceStatus>("/api/v1/ai/faces", { signal }),
    refetchInterval: (q) => {
      const s = q.state.data;
      return s && (s.download.status === "downloading" || s.pending > 0) ? 1000 : false;
    },
  });

  // When the model arrives or the avatars are all looked at, the character
  // queries refresh: the first refresh also queues every avatar.
  const busy = !!faces && (faces.download.status === "downloading" || faces.pending > 0);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) void qc.invalidateQueries({ queryKey: TAGS_KEY });
    wasBusy.current = busy;
  }, [busy, qc]);

  const run = async (path: string) => {
    qc.setQueryData(FACES_KEY, await api<FaceStatus>(`/api/v1/ai/faces/${path}`, { method: "POST" }));
    await qc.invalidateQueries({ queryKey: TAGS_KEY });
  };

  const dl = faces?.download;
  const done = dl?.done ?? 0;
  const total = dl?.total ?? 0;
  const pct = dl ? (taskPct(dl) ?? 0) : 0;

  return (
    <div className="space-y-5">
      <NewCharacterOutfit />
      <Section
        title="Face detection"
        description="Crops each character's avatar to their face. Uses a small model made for anime art (about 12 MB) that runs on this computer."
      >
        {!faces ? (
          <div className="text-sm text-faint">Loading…</div>
        ) : dl?.status === "downloading" ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-neutral-200">
                Downloading the face model
                {total > 0 && (
                  <span className="text-muted tabular-nums">
                    {" "}
                    · {formatBytes(done)} of {formatBytes(total)}
                  </span>
                )}
              </span>
              <Button size="sm" onClick={() => void run("download-cancel")} disabled={dl.cancel_requested}>
                Cancel
              </Button>
            </div>
            <ProgressBar value={pct} aria-label="Face model download progress" />
          </div>
        ) : faces.downloaded ? (
          <div className="space-y-3">
            <div className="text-sm text-neutral-200">
              Downloaded
              {faces.pending > 0 && (
                <span className="inline-flex items-center gap-1.5 text-muted ml-2">
                  <Loader2 size={12} className="animate-spin" /> Looking at {faces.pending}{" "}
                  {faces.pending === 1 ? "avatar" : "avatars"}…
                </span>
              )}
            </div>
            {settings && (
              <Checkbox
                id="face_detect"
                checked={settings.face_detect}
                onChange={(v) => setSettings({ ...settings, face_detect: v })}
                label="Crop avatars to faces"
                hint="Off: avatars show the top of the image, unless you set a centre on the character page."
              />
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted">
              {dl?.status === "error" ? (
                <span className="text-red-300">Download failed{dl.error ? `: ${dl.error}` : ""}</span>
              ) : (
                "Not downloaded. Avatars show the top of the image until then."
              )}
            </div>
            <Button size="sm" variant="primary" onClick={() => void run("download")}>
              {dl?.status === "error" ? "Retry" : "Download"}
            </Button>
          </div>
        )}
      </Section>

      {faces?.downloaded && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={save} disabled={!settings || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

const OUTFIT_STARTS = [
  { value: "none", label: "Not set" },
  { value: "default", label: "Their usual clothes" },
];

/** What a character picked in Generate starts wearing. Saved at once. */
function NewCharacterOutfit() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: comfy } = useComfySettings();
  const pick = async (v: string) => {
    try {
      qc.setQueryData(SETTINGS_KEY, await putSettings({ new_character_outfit: v as ComfySettings["new_character_outfit"] }));
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Couldn't save", "error");
    }
  };
  return (
    <Section title="Outfits in Generate">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-neutral-200">Outfit for new characters</span>
        <div className="w-56">
          <Picker
            value={comfy?.new_character_outfit ?? "none"}
            options={OUTFIT_STARTS}
            onChange={(v) => void pick(v)}
            aria-label="Outfit for new characters"
            disabled={!comfy}
          />
        </div>
      </div>
    </Section>
  );
}

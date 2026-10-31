import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Section } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { ProgressBar } from "../../../components/ui/ProgressBar";
import { FACES_KEY, postFaces } from "../../../lib/ai";
import { TAGS_KEY } from "../../../lib/queries";
import { taskPct } from "../../../lib/backgroundTasks";
import { formatBytes } from "../../../lib/format";
import { useAiSettingsForm } from "../useAiSettingsForm";
import { useFaceStatus } from "../../../hooks/useFaceStatus";

/**
 * Character avatars: the optional face detector that crops them to the
 * face. Nothing downloads until the user asks; once it's there, avatars are
 * looked at in the background and the character pages pick that up.
 */
export function CharactersSection() {
  const qc = useQueryClient();
  const { settings, setSettings, saving, save } = useAiSettingsForm();
  const { data: faces } = useFaceStatus();

  const run = async (command: "download" | "download-cancel") => {
    qc.setQueryData(FACES_KEY, await postFaces(command));
    await qc.invalidateQueries({ queryKey: TAGS_KEY });
  };

  const dl = faces?.download;
  const done = dl?.done ?? 0;
  const total = dl?.total ?? 0;
  const pct = dl ? (taskPct(dl) ?? 0) : 0;

  return (
    <div className="space-y-5">
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
          <Button variant="primary" onClick={save} disabled={!settings} pending={saving}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

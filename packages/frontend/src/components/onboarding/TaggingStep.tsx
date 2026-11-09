import { useState } from "react";
import { roughDuration } from "../../lib/format";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui/Button";
import {
  CPU_SECONDS_PER_IMAGE,
  GPU_SECONDS_PER_IMAGE,
  gpuInstallCommand,
} from "../../lib/onboarding";
import { aboutDuration, type AiEstimate } from "../../lib/ai";
import { Group, StatusLine, StepHeading, SwitchRow } from "./parts";

/**
 * Step 3: switch on auto-tag, which tags every image once the scan is done
 * and each new one as it arrives. The time it would take is worked out for
 * the device the tagger runs on; on the CPU build, next to the GPU build's,
 * with how to switch.
 */
export function TaggingStep({
  images,
  capped,
  checkout,
  on,
  onChange,
  estimate,
}: {
  images: number;
  capped: boolean;
  checkout: boolean;
  on: boolean;
  onChange: (on: boolean) => void;
  estimate: AiEstimate | undefined;
}) {
  // Without the status (an older backend), the documented CPU rate.
  const device = estimate?.device ?? "cpu";
  const perImage = estimate?.seconds_per_image ?? CPU_SECONDS_PER_IMAGE;
  const here = images * perImage;
  const gpu = images * GPU_SECONDS_PER_IMAGE;
  // From the same rates as the bars, so the claim and the bars agree.
  const faster = Math.max(2, Math.round(perImage / GPU_SECONDS_PER_IMAGE));
  const command = gpuInstallCommand(checkout);
  const [copied, setCopied] = useState(false);
  const count = `${capped ? "at least " : ""}${images.toLocaleString()} ${images === 1 ? "image" : "images"}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* no clipboard (plain http on another machine): the text is selectable */
    }
  };

  return (
    <section aria-labelledby="h-tagging" className="max-w-[620px] animate-fade-in">
      <StepHeading id="h-tagging" title="AI tagging">
        Images are already tagged from their prompts, which covers search, filters and most of Moiré. The tagger adds
        tags for what is actually in each picture, which helps most with images saved without a prompt.
      </StepHeading>
      <Group>
        <SwitchRow
          checked={on}
          onChange={onChange}
          title="Tag images with AI"
          detail={images > 0 ? `${count}, ${aboutDuration(here)} on the ${device === "gpu" ? "GPU" : "CPU"}` : undefined}
        />
      </Group>
      {device === "gpu" ? (
        <Group>
          <StatusLine tone="ok">Tagging runs on your NVIDIA GPU.</StatusLine>
        </Group>
      ) : (
        <>
          {images > 0 && (
            <Group>
              <span className="mb-3 block font-medium">Tagging {count} takes</span>
              <div className="mb-2 grid gap-2.5">
                <Bar label="This computer" seconds={here} of={Math.max(here, gpu)} />
                <Bar label="NVIDIA GPU" seconds={gpu} of={Math.max(here, gpu)} gpu />
              </div>
            </Group>
          )}
          <Group>
            <div className="rounded-lg border border-brand-400/45 bg-brand-600/[0.07] px-3.5 py-3 text-[13px] leading-normal text-muted">
              <b className="mb-0.5 block font-medium text-neutral-100">Have an NVIDIA GPU? Use the GPU build</b>
              It tags about {faster} times faster. The download is about 2 GB, and you need the NVIDIA driver, nothing
              else. Close Moiré, then run:
              <div className="my-2.5 flex items-center gap-2 rounded-lg border border-line bg-sunken py-1 pl-3 pr-1">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1 font-mono text-[12.5px] text-neutral-100">
                  {command}
                </code>
                <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label="Copy command">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {checkout && "pnpm dev keeps the GPU build from then on. A plain uv run would put the CPU build back."}
            </div>
          </Group>
        </>
      )}
    </section>
  );
}

function Bar({ label, seconds, of, gpu }: { label: string; seconds: number; of: number; gpu?: boolean }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)_64px] items-center gap-3.5 text-[13px] text-muted">
      <span>{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-line">
        <i
          className={`block h-full rounded-full ${gpu ? "bg-brand-400" : "bg-faint"}`}
          style={{ width: `${Math.max(1.5, (seconds / of) * 100)}%` }}
        />
      </span>
      <span className="text-right font-medium tabular-nums text-neutral-100">{roughDuration(seconds)}</span>
    </div>
  );
}

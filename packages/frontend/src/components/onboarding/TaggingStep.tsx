import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui/Button";
import {
  CPU_SECONDS_PER_IMAGE,
  GPU_SECONDS_PER_IMAGE,
  formatDuration,
  gpuInstallCommand,
} from "../../lib/onboarding";
import { Group, Help, StepHeading, SwitchRow } from "./parts";

/**
 * Step 3. The switch ships disabled until turning it on can queue every
 * untagged image (docs/onboarding-plan.md, Phase 3); the time comparison and
 * the GPU recommendation already apply to tagging run from its own page.
 */
export function TaggingStep({ images, capped, checkout }: { images: number; capped: boolean; checkout: boolean }) {
  const cpu = images * CPU_SECONDS_PER_IMAGE;
  const gpu = images * GPU_SECONDS_PER_IMAGE;
  // From the same rates as the bars, so the claim and the bars agree.
  const faster = Math.round(CPU_SECONDS_PER_IMAGE / GPU_SECONDS_PER_IMAGE);
  const command = gpuInstallCommand(checkout);
  const [copied, setCopied] = useState(false);

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
          checked={false}
          onChange={() => {}}
          disabled
          title="Tag images with AI"
          detail="Not available during setup yet. You can tag images any time from the AI Tagging page."
        />
      </Group>
      {images > 0 && (
        <Group>
          <span className="mb-1 block font-medium">
            Tagging {capped ? "at least " : ""}
            {images.toLocaleString()} images would take
          </span>
          <Help>About 0.6 images a second on CPU and 0.1 s an image on a GTX 1650. Your hardware will differ.</Help>
          <div className="mb-2 mt-1 grid gap-2.5">
            <Bar label="CPU" seconds={cpu} of={cpu} />
            <Bar label="NVIDIA GPU" seconds={gpu} of={cpu} gpu />
          </div>
        </Group>
      )}
      <Group>
        <div className="rounded-lg border border-brand-400/45 bg-brand-600/[0.07] px-3.5 py-3 text-[13px] leading-normal text-muted">
          <b className="mb-0.5 block font-medium text-neutral-100">Have an NVIDIA GPU? Use the GPU build</b>
          It tags about {faster} times faster. The download is about 2 GB, and you need the NVIDIA driver, nothing else.
          Close Moiré, then run:
          <div className="my-2.5 flex items-center gap-2 rounded-lg border border-line bg-sunken py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1 font-mono text-[12.5px] text-neutral-100">
              {command}
            </code>
            <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label="Copy command">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {checkout && "Keep UV_NO_GROUP=cpu set in the shell you run Moiré from, or the next sync reinstalls the CPU build."}
        </div>
      </Group>
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
      <span className="text-right font-medium tabular-nums text-neutral-100">{formatDuration(seconds)}</span>
    </div>
  );
}

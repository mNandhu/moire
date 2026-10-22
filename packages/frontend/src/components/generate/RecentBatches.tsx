import { Link } from "react-router-dom";
import { batchLine, isWaiting, stateTone, STATE_LABEL, turnLabel, whenLabel } from "../../lib/batches";
import { useBatches, useComfyStatus, type ActiveBatch, type BatchSummary } from "../../lib/generate";
import { Badge } from "../ui";
import { NoImageMark } from "./BatchResults";

const THUMB_H = 36;

/** Up to three of a batch's images at its own ratio. */
function Thumbs({ b, turn }: { b: BatchSummary; turn: ActiveBatch | undefined }) {
  const ratio = b.width && b.height ? b.width / b.height : 2 / 3;
  const w = Math.round(THUMB_H * ratio);
  const urls = b.thumbs.slice(0, 3);
  return (
    <span className="flex shrink-0 gap-1">
      {urls.length ? (
        urls.map((url) => (
          <img
            key={url}
            src={url}
            alt=""
            loading="lazy"
            className="rounded object-cover bg-raised"
            style={{ width: w, height: THUMB_H }}
          />
        ))
      ) : (
        // No images: say why in the thumb's place rather than a blank square.
        <NoImageMark
          why={b.state === "failed" ? "failed" : turn && !turn.running ? "waiting" : b.state === "running" ? "running" : "missing"}
          style={{ width: w, height: THUMB_H }}
        />
      )}
    </span>
  );
}

const NO_ACTIVE: ActiveBatch[] = [];

/** The batches before the newest one, under its images. */
export function RecentBatches({ onOpen }: { onOpen: (id: number) => void }) {
  // The newest one is shown above, with its images.
  const { data: all } = useBatches(6);
  const { data: status } = useComfyStatus();
  const active = status?.active ?? NO_ACTIVE;
  const data = all?.slice(1);
  if (!data?.length) return null;
  return (
    <section aria-label="Recent batches">
      <div className="mb-1.5 flex items-center px-2 text-xs font-medium text-muted">
        Recent batches
        <span className="flex-1" />
        <Link to="/generations" className="font-normal hover:text-neutral-100">
          All generations
        </Link>
      </div>
      <ul className="space-y-0.5">
        {data.map((b) => {
          const turn = b.state === "running" ? active.find((a) => a._id === b._id) : undefined;
          const waiting = !!turn && isWaiting(turn);
          return (
            <li key={b._id}>
              <button
                type="button"
                onClick={() => onOpen(b._id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-raised"
              >
                <Thumbs b={b} turn={turn} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-neutral-100">{b.name}</span>
                  <span className="block truncate text-xs text-faint">{batchLine(b)}</span>
                </span>
                {waiting ? (
                  <span title={turnLabel(turn) ?? undefined}>
                    <Badge tone="neutral">Queued</Badge>
                  </span>
                ) : b.state === "running" || b.state === "failed" || b.state === "paused" ? (
                  <Badge tone={stateTone(b.state)}>{STATE_LABEL[b.state]}</Badge>
                ) : (
                  <span className="text-xs text-faint">{whenLabel(b.created_at)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

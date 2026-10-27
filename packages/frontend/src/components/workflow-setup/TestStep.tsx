import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Wand2 } from "lucide-react";
import { Button, Card, Tooltip } from "../ui";
import { TestBadge } from "../generate/TestBadge";
import { GENERATORS_KEY, RejectedError, startTest, useComfyStatus, useGenerators } from "../../lib/generate";
import { canRunTest, testState } from "../../lib/generatorRunBar";

/** A saved workflow's test run: start it (again), follow it, and once it
 * passed, open Generate on it. */
export function TestStep({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: generators } = useGenerators();
  const { data: status } = useComfyStatus();
  const gen = generators?.find((g) => g._id === id);
  const run = useMutation({
    mutationFn: () => startTest(id, null),
    onSettled: () => qc.invalidateQueries({ queryKey: GENERATORS_KEY }),
  });
  if (!gen) return null;
  const t = gen.test;
  const state = testState(gen);
  const connected = !!status?.connected;
  const rejected = run.error instanceof RejectedError ? run.error.nodeErrors : null;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="text-sm font-semibold text-neutral-50">Test run</h3>
        <TestBadge gen={gen} />
        <div className="ml-auto flex gap-2">
          {state === "ready" ? (
            <Button variant="primary" size="sm" onClick={() => navigate(`/generate?workflow=${encodeURIComponent(id)}`)}>
              <Wand2 size={14} /> Use this workflow
            </Button>
          ) : (
            <Tooltip
              content={
                connected
                  ? "One image with the default prompt and, where it can, one LoRA at strength 0: proves the prompts, the output folder and the insertion point."
                  : "Waiting for ComfyUI"
              }
            >
              <Button
                variant="primary"
                size="sm"
                disabled={!connected || run.isPending || !canRunTest(state)}
                onClick={() => run.mutate()}
              >
                {(run.isPending || state === "running") && <Loader2 size={14} className="animate-spin" />}
                {state === "running" ? "Running" : state === "untested" ? "Run test image" : "Run again"}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {state === "failed" && t?.error && (
        <p className="font-mono text-xs text-red-300">
          {t.error.class_type} {t.error.node && `node ${t.error.node}`}: {t.error.message}
        </p>
      )}
      {state === "failed" && t?.state === "done" && <p className="text-xs text-red-300">Returned 0 images</p>}
      {state === "waiting" && (
        <p className="text-xs text-muted">
          It made {t?.outputs} {t?.outputs === 1 ? "image" : "images"}; waiting for the library scan. If nothing arrives, check
          that the workflow saves into ComfyUI's output folder.
        </p>
      )}
      {rejected ? (
        <ul className="space-y-1 font-mono text-xs text-red-300">
          {rejected.map((e, i) => (
            <li key={i}>
              {e.class_type ?? "Node"} {e.added ? "(added by Moiré)" : `#${e.node}`}: {e.input ? `${e.input}: ` : ""}
              {e.message}
            </li>
          ))}
        </ul>
      ) : (
        run.error && <p className="text-xs text-red-300">{run.error.message}</p>
      )}
    </Card>
  );
}

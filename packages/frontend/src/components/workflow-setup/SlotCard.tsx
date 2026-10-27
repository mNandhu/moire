import { Card } from "../ui";
import type { SlotPath } from "../../lib/generate";

/** A slot card: title, its state badge, then what it found. */
export function SlotCard({
  title,
  badge,
  action,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="text-sm font-semibold text-neutral-50">{title}</h3>
        {badge}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </Card>
  );
}

export function NodeLine({ title, path, extra }: { title: string; path: SlotPath | [string, number]; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-neutral-300">
      <span>{title}</span>
      <span className="font-mono text-xs text-faint">
        #{path[0]} {typeof path[1] === "string" ? path[1] : `out ${path[1]}`}
      </span>
      {extra}
    </div>
  );
}

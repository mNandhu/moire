import { useEffect } from "react";
import { etaShort } from "../lib/eta";
import { setTitlePrefix } from "./useDocumentTitle";
import { useBackgroundTasks } from "./useBackgroundTasks";

/** While generating, the tab title starts with the time left on the queue
 * ("2m left · Generate · Moiré"), so it reads from another tab. */
export function useQueueTitle() {
  const { data: tasks } = useBackgroundTasks();
  const eta = tasks?.find((t) => t.kind === "generate")?.eta_s;
  const prefix = eta != null && eta >= 1 ? `${etaShort(eta)} left · ` : "";
  useEffect(() => setTitlePrefix(prefix), [prefix]);
  useEffect(() => () => setTitlePrefix(""), []);
}

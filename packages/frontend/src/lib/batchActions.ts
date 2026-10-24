import type { GenRequest } from "./generate";

/** The requests a retry-all picks up. */
export const retryable = (requests: readonly GenRequest[]) => requests.filter((q) => q.state === "failed" || q.state === "lost");

/** A non-2xx API response. `message` is already the words to show (FastAPI's
 * `detail` unwrapped); `status` is the HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The words in a FastAPI error body: `{"detail": "..."}`, a 422 `detail` list
 * (each `msg`), else the raw text. */
function detailText(raw: string): string {
  try {
    const d = JSON.parse(raw)?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x) => x?.msg ?? String(x)).join("; ");
  } catch {
    /* not JSON; use as-is */
  }
  return raw;
}

/** The error for a non-ok Response: the unwrapped detail, else the raw body,
 * else `${status} ${statusText}`. For raw-fetch sites that bypass `api()`. */
export async function httpError(r: Response): Promise<ApiError> {
  const text = detailText(await r.text().catch(() => ""));
  return new ApiError(text || `${r.status} ${r.statusText}`.trim(), r.status);
}

/**
 * The one fetch-JSON helper. Six pages had each defined their own identical
 * `api<T>()`; this is that, in one place: GET (or any method via `init`),
 * throw an ApiError on non-2xx, parse JSON on success.
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  return (await apiRaw(url, init)).json();
}

/** `api` for a write: `body`, when given, goes as JSON (stringified, with its
 * Content-Type); `init` adds the rest (a signal). */
export function apiJson<T>(url: string, method: string, body?: unknown, init?: RequestInit): Promise<T> {
  return api<T>(url, jsonInit(method, body, init));
}

/** The RequestInit `apiJson` sends, for a caller that reads the Response
 * itself. No body, no Content-Type. */
export function jsonInit(method: string, body?: unknown, init: RequestInit = {}): RequestInit {
  if (body === undefined) return { ...init, method };
  const headers = { ...Object.fromEntries(new Headers(init.headers)), "Content-Type": "application/json" };
  return { ...init, method, headers, body: JSON.stringify(body) };
}

/** The checked Response, for a caller that needs more than the JSON (a
 * response header). Throws an ApiError on non-2xx like `api`. */
export async function apiRaw(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init);
  if (!r.ok) throw await httpError(r);
  return r;
}

/** The words to show for any caught error. An ApiError is already clean; a
 * plain Error may still carry a raw JSON body, so unwrap that too. */
export function errorText(e: unknown): string {
  return detailText(e instanceof Error ? e.message : String(e));
}

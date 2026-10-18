/**
 * The one fetch-JSON helper. Six pages had each defined their own identical
 * `api<T>()`; this is that, in one place: GET (or any method via `init`),
 * throw the response body text on non-2xx, parse JSON on success.
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

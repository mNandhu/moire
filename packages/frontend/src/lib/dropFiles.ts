/**
 * Every file in a drag-and-drop, folders included.
 *
 * `dataTransfer.files` lists only the top-level items, and a dropped folder
 * shows up there as an unreadable zero-byte entry. Walking the
 * `webkitGetAsEntry()` tree recovers the files inside, recursively, so
 * dropping ComfyUI's whole `workflows` folder works. `accept` filters by
 * name (e.g. only `.json`).
 */

// The subset of the File and Directory Entries API this walk uses. Typed
// locally so tests can pass plain fakes.
export type EntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: EntryLike[]) => void, err?: (e: unknown) => void) => void;
  };
};

async function walk(entry: EntryLike, accept: (name: string) => boolean, out: File[]) {
  if (entry.isFile && entry.file) {
    if (!accept(entry.name)) return;
    out.push(await new Promise<File>((ok, err) => entry.file!(ok, err)));
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns results in batches (100 in Chromium) until empty.
    for (;;) {
      const batch = await new Promise<EntryLike[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const child of batch) await walk(child, accept, out);
    }
  }
}

export async function filesFromEntries(
  entries: EntryLike[],
  accept: (name: string) => boolean = () => true,
): Promise<File[]> {
  const out: File[] = [];
  for (const e of entries) await walk(e, accept, out);
  return out;
}

export async function filesFromDrop(
  dt: DataTransfer,
  accept: (name: string) => boolean = () => true,
): Promise<File[]> {
  // Entries must be taken synchronously, before any await: the DataTransfer
  // is emptied once the drop handler yields.
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e) as unknown as EntryLike[];
  if (!entries.length) return Array.from(dt.files).filter((f) => accept(f.name));
  return filesFromEntries(entries, accept);
}

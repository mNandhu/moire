import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Plus, RotateCw, Pencil, Trash2, Eye, EyeOff } from "lucide-react";
import { useToast } from "../components/Toasts";
import { PageHeader } from "../components/ui/PageHeader";
import { Card } from "../components/ui/Card";
import { Dialog } from "../components/ui/Dialog";
import { AddLibraryDialog } from "../components/AddLibraryDialog";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/ui/Button";
import { Input, Field } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { Skeleton, Spinner } from "../components/ui/Skeleton";
import { EmptyState } from "../components/ui/EmptyState";
import { api } from "../lib/api";

type Library = {
  _id: string;
  name?: string;
  path: string;
  indexed_count?: number;
  last_scanned?: string;
  watch_enabled?: boolean;
  last_event_at?: string | null;
};

export default function LibrariesPage() {
  const { push } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  // Library changes alter which images the gallery should show. Both the flat
  // feed (`["images", ...]`) and the batch-collapsed grouped view
  // (`["image-groups", ...]`) are cached with a staleTime, so without this the
  // gallery shows stale results — including images from a removed library —
  // until a manual reload. Drop both so they refetch next time they mount.
  const invalidateImageFeed = () => {
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["image-groups"] });
  };
  const [libs, setLibs] = useState<Library[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPath, setEditPath] = useState("");

  // Polling progress map
  const [progress, setProgress] = useState<
    Record<string, { scanning: boolean; scan_total: number; scan_done: number }>
  >({});
  const prevScanningRef = useRef<Record<string, boolean>>({});

  // Compute which libraries need polling (those currently scanning)
  const scanningIds = useMemo(
    () => libs.filter((l: any) => l && (l as any).scanning).map((l) => l._id),
    [libs]
  );

  // Poll scan progress for scanning libraries only
  useEffect(() => {
    if (!scanningIds.length) return;
    let timer: number | undefined;
    let cancelled = false;
    const tick = async () => {
      const updates: Record<
        string,
        { scanning: boolean; scan_total: number; scan_done: number }
      > = {};
      try {
        await Promise.all(
          scanningIds.map(async (id) => {
            try {
              const r = await fetch(`/api/v1/libraries/${id}/progress`);
              if (!r.ok) return;
              const j = await r.json();
              updates[id] = {
                scanning: !!j.scanning,
                scan_total: j.scan_total || 0,
                scan_done: j.scan_done || 0,
              };
            } catch { /* network errors silenced — polling will retry */ }
          })
        );
        // Detect scanning -> done transitions to refresh once
        const prev = prevScanningRef.current;
        let transitioned = false;
        for (const [id, u] of Object.entries(updates)) {
          if (prev[id] && !u.scanning) transitioned = true;
        }
        prevScanningRef.current = Object.fromEntries(
          Object.entries(updates).map(([id, u]) => [id, u.scanning])
        );
        if (transitioned) {
          refresh();
          invalidateImageFeed();
        }
        if (!cancelled) setProgress((p) => ({ ...p, ...updates }));
      } finally {
        const anyScanning = Object.values(updates).some((u) => u.scanning);
        if (!cancelled && anyScanning) timer = window.setTimeout(tick, 1500);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [scanningIds]);

  const refresh = async (opts?: { initial?: boolean }) => {
    if (opts?.initial) setInitialLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const data = await api<Library[]>(`/api/v1/libraries`);
      setLibs(data);
    } catch (e: any) {
      const msg = e?.message || "Failed to load libraries";
      setError(msg);
    } finally {
      if (opts?.initial) setInitialLoading(false);
      else setRefreshing(false);
    }
  };
  useEffect(() => {
    refresh({ initial: true });
  }, []);

  const updateLibrary = async (id: string, data: Partial<Library>) => {
    await api(`/api/v1/libraries/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    refresh();
    invalidateImageFeed();
  };

  const deleteLibrary = async (id: string) => {
    const lib = libs.find((l) => l._id === id);
    const ok = await confirm({
      title: `Delete ${lib?.name || lib?.path || "this library"}?`,
      message:
        "Its indexed images, tags and thumbnails are removed from Tagify. Files on disk are not touched.",
      confirmLabel: "Delete library",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/api/v1/libraries/${id}`, { method: "DELETE" });
    } catch (e: any) {
      push(e?.message || "Failed to delete library", "error");
      return;
    }
    refresh();
    invalidateImageFeed();
  };

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Libraries"
        count={initialLoading ? undefined : libs.length}
        description="Folders Tagify watches and indexes."
        actions={
          <div className="flex items-center gap-3">
            {refreshing && !initialLoading && (
              <span className="flex items-center gap-2 text-xs text-neutral-400">
                <Spinner className="h-3 w-3" /> Refreshing…
              </span>
            )}
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus size={16} />
              Add libraries
            </Button>
          </div>
        }
      />

      <AddLibraryDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={async ({ added, failed }) => {
          await refresh();
          invalidateImageFeed();
          push(
            `Added ${added} librar${added === 1 ? "y" : "ies"}${failed.length ? ` · ${failed.length} failed` : ""} — scanning in the background`,
            failed.length ? "error" : "success",
          );
        }}
      />

      {/* Error banner */}
      {error && !initialLoading && (
        <div className="rounded-lg border border-red-800 bg-red-900/40 p-3 text-sm text-red-200 flex items-start justify-between gap-3">
          <div>{error}</div>
          <Button variant="danger" size="sm" onClick={() => refresh()}>
            Retry
          </Button>
        </div>
      )}

      <div className="grid gap-3">
        {/* Initial loading skeletons */}
        {initialLoading && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-72" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-5 w-20" />
                    <Skeleton className="h-5 w-24" />
                  </div>
                </div>
                <Skeleton className="mt-3 h-7 w-40" />
              </Card>
            ))}
          </>
        )}

        {/* Empty state */}
        {!initialLoading && !libs.length && !error && (
          <EmptyState
            icon={FolderOpen}
            title="No libraries yet"
            description="Add a folder of images — or a parent folder whose subfolders each become a library."
            actions={
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <Plus size={16} />
                Add libraries
              </Button>
            }
          />
        )}

        {/* Libraries list */}
        {!initialLoading &&
          libs.map((l) => (
            <Card key={l._id} hover className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-neutral-100 truncate">
                    {l.name || l.path}
                  </div>
                  <div className="text-xs text-neutral-400 truncate">{l.path}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!(progress[l._id]?.scanning || (l as any).scanning) &&
                    typeof l.indexed_count === "number" && (
                      <Badge>{l.indexed_count.toLocaleString()} indexed</Badge>
                    )}
                  {l.last_scanned && (
                    <Badge>
                      <span title={new Date(l.last_scanned).toLocaleString()}>
                        {new Date(l.last_scanned).toLocaleDateString()}
                      </span>
                    </Badge>
                  )}
                  {rescanning.has(l._id) && (
                    <Badge tone="brand">Rescanning…</Badge>
                  )}
                  <Badge tone={l.watch_enabled ? "brand" : undefined}>
                    {l.watch_enabled ? "Watching" : "Watch off"}
                  </Badge>
                </div>
              </div>

              {progress[l._id]?.scanning && (
                <div className="mt-3">
                  <progress
                    className="w-full h-2 [&::-webkit-progress-bar]:bg-neutral-800 [&::-webkit-progress-value]:bg-brand-600 [&::-moz-progress-bar]:bg-brand-600 rounded"
                    value={Math.max(0, progress[l._id]?.scan_done || 0)}
                    max={Math.max(1, progress[l._id]?.scan_total || 1)}
                    aria-label="Scanning progress"
                  />
                  <div className="mt-1 text-xs text-neutral-400 tabular-nums">
                    {progress[l._id]?.scan_done || 0} /{" "}
                    {progress[l._id]?.scan_total || 0}
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    setRescanning((s) => new Set(s).add(l._id));
                    try {
                      await api(`/api/v1/libraries/${l._id}/rescan`, {
                        method: "POST",
                      });
                      push(`Rescan started for ${l.name || l.path}`, "info");
                    } finally {
                      refresh();
                      setRescanning((s) => {
                        const n = new Set(s);
                        n.delete(l._id);
                        return n;
                      });
                      push(`Rescan requested`, "success");
                    }
                  }}
                  disabled={rescanning.has(l._id)}
                >
                  <RotateCw size={14} />
                  {rescanning.has(l._id) ? "Rescanning…" : "Rescan"}
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      await updateLibrary(l._id, { watch_enabled: !l.watch_enabled });
                      push(
                        l.watch_enabled ? "Watching disabled" : "Watching enabled",
                        "success",
                      );
                    } catch (e: any) {
                      push(e?.message || "Failed to update watching", "error");
                    }
                  }}
                >
                  {l.watch_enabled ? <EyeOff size={14} /> : <Eye size={14} />}
                  {l.watch_enabled ? "Stop watching" : "Watch"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditId(l._id);
                    setEditName(l.name || "");
                    setEditPath(l.path);
                  }}
                >
                  <Pencil size={14} />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="dangerSoft"
                  onClick={() => deleteLibrary(l._id)}
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </Card>
          ))}
      </div>

      <Dialog
        open={!!editId}
        onClose={() => setEditId(null)}
        title="Edit library"
        footer={
          <>
            <Button onClick={() => setEditId(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (!editId) return;
                const payload: Partial<Library> = {};
                if (editName !== undefined) payload.name = editName || undefined;
                if (editPath) payload.path = editPath;
                try {
                  await updateLibrary(editId, payload);
                  setEditId(null);
                  push("Library saved", "success");
                } catch (e: any) {
                  push(e?.message || "Failed to save library", "error");
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" htmlFor="edit_name">
            <Input
              id="edit_name"
              placeholder="Friendly name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </Field>
          <Field label="Path" htmlFor="edit_path">
            <Input
              id="edit_path"
              placeholder="D:/images"
              value={editPath}
              onChange={(e) => setEditPath(e.target.value)}
            />
          </Field>
          {editPath !== libs.find((l) => l._id === editId)?.path && (
            <p className="text-xs text-amber-400">
              Path changed — rescan will start automatically.
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}

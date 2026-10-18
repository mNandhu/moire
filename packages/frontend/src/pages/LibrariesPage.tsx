import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  FolderOpen,
  Plus,
  RotateCw,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  MoreHorizontal,
} from "lucide-react";
import { useToast } from "../components/Toasts";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { ProgressBar } from "../components/ui/ProgressBar";
import { Card } from "../components/ui/Card";
import { Dialog } from "../components/ui/Dialog";
import { AddLibraryDialog } from "../components/AddLibraryDialog";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/ui/Button";
import { Input, Field } from "../components/ui/Input";
import { Skeleton, Spinner } from "../components/ui/Skeleton";
import { EmptyState } from "../components/ui/EmptyState";
import { api } from "../lib/api";
import { LIBRARIES_KEY, useLibraries, type Library } from "../lib/queries";

export default function LibrariesPage() {
  const { push } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  // Library changes alter which images the gallery should show. Both the flat
  // feed (`["images", ...]`) and the batch-collapsed grouped view
  // (`["image-groups", ...]`) are cached with a staleTime, so without this the
  // gallery shows stale results, including images from a removed library,
  // until a manual reload. Drop both so they refetch next time they mount.
  const invalidateImageFeed = () => {
    queryClient.invalidateQueries({ queryKey: ["images"] });
    queryClient.invalidateQueries({ queryKey: ["image-groups"] });
  };
  const libsQuery = useLibraries();
  const libs = useMemo(() => libsQuery.data ?? [], [libsQuery.data]);
  const initialLoading = libsQuery.isPending;
  const refreshing = libsQuery.isFetching && !libsQuery.isPending;
  const error = libsQuery.error
    ? libsQuery.error.message || "Failed to load libraries"
    : null;
  // Refetch the shared list; every page reading libraries updates with it.
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: LIBRARIES_KEY }),
    [queryClient],
  );
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
    () => libs.filter((l) => l.scanning).map((l) => l._id),
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
            } catch { /* network errors silenced; polling will retry */ }
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
  }, [scanningIds, refresh]);

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
        "Its indexed images, tags and thumbnails are removed from Moiré. Files on disk are not touched.",
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

  const rescan = async (l: Library) => {
    setRescanning((s) => new Set(s).add(l._id));
    try {
      await api(`/api/v1/libraries/${l._id}/rescan`, { method: "POST" });
      push(`Rescan started for ${l.name || l.path}`, "info");
    } catch (e) {
      push((e as Error)?.message || "Failed to start rescan", "error");
    } finally {
      refresh();
      setRescanning((s) => {
        const n = new Set(s);
        n.delete(l._id);
        return n;
      });
    }
  };

  const toggleWatch = async (l: Library) => {
    try {
      await updateLibrary(l._id, { watch_enabled: !l.watch_enabled });
      push(l.watch_enabled ? "Stopped watching" : "Watching for changes", "success");
    } catch (e) {
      push((e as Error)?.message || "Failed to update watching", "error");
    }
  };

  return (
    <>
      <PageHeader
        title="Libraries"
        count={initialLoading ? undefined : libs.length}
        description="Folders Moiré indexes."
        actions={
          <div className="flex items-center gap-3">
            {refreshing && !initialLoading && (
              <span className="flex items-center gap-2 text-xs text-neutral-400">
                <Spinner className="h-3 w-3" /> Refreshing…
              </span>
            )}
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus size={16} />
              Add library
            </Button>
          </div>
        }
      />
      <PageBody className="space-y-5">

      <AddLibraryDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={async ({ added, failed }) => {
          await refresh();
          invalidateImageFeed();
          push(
            `Added ${added} librar${added === 1 ? "y" : "ies"}${failed.length ? ` · ${failed.length} failed` : ""}, scanning in the background`,
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
            description="Add a folder of images, or a parent folder whose subfolders each become a library."
            actions={
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <Plus size={16} />
                Add library
              </Button>
            }
          />
        )}

        {/* Libraries list */}
        {!initialLoading &&
          libs.map((l) => {
            const scanning = !!(progress[l._id]?.scanning || l.scanning);
            const busy = scanning || rescanning.has(l._id);
            // One quiet line of facts instead of a row of same-weight badges.
            const facts = [
              !scanning && typeof l.indexed_count === "number"
                ? `${l.indexed_count.toLocaleString()} ${l.indexed_count === 1 ? "image" : "images"}`
                : null,
              l.last_scanned
                ? `Scanned ${new Date(l.last_scanned).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
                : null,
            ].filter(Boolean);
            return (
              <Card key={l._id} className="p-4">
                <div className="flex items-center gap-4">
                  <span className="hidden sm:inline-flex items-center justify-center w-10 h-10 rounded-lg shrink-0 text-brand-300 bg-brand-500/10">
                    <FolderOpen size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-neutral-100 truncate">
                      {l.name || l.path}
                    </div>
                    <div className="text-xs text-faint truncate" title={l.path}>
                      {l.path}
                    </div>
                    {/* Separators are a trailing dot on each fact, so a
                        wrapped line never starts with one. */}
                    <div className="mt-1 text-xs text-muted flex flex-wrap items-center gap-x-1.5">
                      {facts.map((f, i) => (
                        <span key={i} className="tabular-nums whitespace-nowrap">
                          {f}
                          <span className="text-faint ml-1.5">·</span>
                        </span>
                      ))}
                      <span className="whitespace-nowrap">
                        {l.watch_enabled ? (
                          <span className="inline-flex items-center gap-1">
                            <Eye size={12} className="text-brand-300" /> Watching
                          </span>
                        ) : (
                          <span className="text-faint">Not watching</span>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      onClick={() => void rescan(l)}
                      disabled={busy}
                      aria-label="Rescan"
                      title="Rescan this folder"
                    >
                      <RotateCw size={14} className={busy ? "animate-spin" : undefined} />
                      <span className="hidden sm:inline">
                        {scanning ? "Scanning…" : rescanning.has(l._id) ? "Rescanning…" : "Rescan"}
                      </span>
                    </Button>
                    <DropdownMenu
                      aria-label={`More actions for ${l.name || l.path}`}
                      icon={<MoreHorizontal size={16} />}
                      size="sm"
                      items={[
                        {
                          label: l.watch_enabled ? "Stop watching" : "Watch for changes",
                          icon: l.watch_enabled ? <EyeOff size={15} /> : <Eye size={15} />,
                          onClick: () => void toggleWatch(l),
                        },
                        {
                          label: "Edit",
                          icon: <Pencil size={15} />,
                          onClick: () => {
                            setEditId(l._id);
                            setEditName(l.name || "");
                            setEditPath(l.path);
                          },
                        },
                        {
                          label: "Delete",
                          icon: <Trash2 size={15} />,
                          variant: "danger",
                          onClick: () => void deleteLibrary(l._id),
                        },
                      ]}
                    />
                  </div>
                </div>

                {progress[l._id]?.scanning && (
                  <div className="mt-3">
                    <ProgressBar
                      value={Math.max(0, progress[l._id]?.scan_done || 0)}
                      max={Math.max(1, progress[l._id]?.scan_total || 1)}
                      aria-label="Scanning progress"
                    />
                    <div className="mt-1 text-xs text-muted tabular-nums">
                      {(progress[l._id]?.scan_done || 0).toLocaleString()} /{" "}
                      {(progress[l._id]?.scan_total || 0).toLocaleString()}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
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
              Path changed. Rescan will start automatically.
            </p>
          )}
        </div>
      </Dialog>
      </PageBody>
    </>
  );
}

import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Tag as TagIcon } from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { Button, ButtonLink } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/Toasts";
import { FocusPicker } from "../components/FocusPicker";
import { FaceCrop } from "../components/CharacterAvatar";
import { TagImages } from "../components/TagPanel";
import { setTagFocus } from "../lib/imageMutations";
import { TAGS_KEY, useTagDetail } from "../lib/queries";
import { DEFAULT_FILTERS, serializeFilters } from "../lib/imageFilter";
import { formatTag } from "../lib/tags";
import { characterHref } from "../lib/character";
import { galleryTag } from "../lib/tagBrowse";
import { formatUsedRange } from "../lib/workflows";

/**
 * A plain tag's page: its cover, centred where the user clicks, and its own
 * images to pick a different cover from. The counterpart of a character's
 * page for tags that are not people.
 */
export default function TagPage() {
  const { tag = "" } = useParams();
  const qc = useQueryClient();
  const { push } = useToast();
  const { data: detail, isError } = useTagDetail(tag, "all");
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = detail?.focus ?? null;
  // Start from the stored point, and again when a fetch brings a new one.
  useEffect(() => setFocus(saved), [saved?.[0], saved?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = focus?.[0] !== saved?.[0] || focus?.[1] !== saved?.[1];

  const save = async (next: [number, number] | null) => {
    setSaving(true);
    try {
      await setTagFocus(tag, next);
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
    } catch (e) {
      push(`Couldn't save: ${String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  if (isError) {
    return (
      <>
        <PageHeader title={formatTag(tag)} width="wide" />
        <EmptyState
          icon={TagIcon}
          title="No images have this tag"
          description="It may have been renamed, or its images quarantined."
          actions={<ButtonLink to="/tags">Back to Tags</ButtonLink>}
        />
      </>
    );
  }

  // A character's cover is framed on their own page.
  if (detail?.category === "character") return <Navigate to={characterHref(tag)} replace />;

  const cover = detail?.cover_url ?? null;
  return (
    <>
      <PageHeader
        title={formatTag(tag)}
        width="wide"
        count={detail?.count}
        description={detail ? formatUsedRange(detail.first_used, detail.last_used) || undefined : undefined}
        actions={
          <ButtonLink
            size="sm"
            variant="primary"
            to={`/?${serializeFilters({ ...DEFAULT_FILTERS, tags: [galleryTag(tag, "all")] })}`}
          >
            <ExternalLink size={14} /> Open in gallery
          </ButtonLink>
        }
      />
      <PageBody width="wide">
        {!detail ? (
          <Skeleton className="h-44 w-full max-w-md" />
        ) : (
          <div className="space-y-8">
            {cover && (
              <section aria-label="Cover" className="flex flex-wrap items-center gap-5">
                <FocusPicker src={cover} aspect={detail.aspect ?? null} focus={focus} onChange={setFocus} height="h-56" />
                <div className="flex flex-col items-start gap-3">
                  <FaceCrop
                    src={cover}
                    face={null}
                    focus={focus}
                    aspect={detail.aspect ?? null}
                    className="h-24 w-24 rounded-lg ring-1 ring-line"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save(focus)}>
                      {saving ? "Saving…" : "Save"}
                    </Button>
                    {(saved || focus) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        title="Back to the default crop"
                        onClick={() => {
                          setFocus(null);
                          if (saved) void save(null);
                        }}
                      >
                        Reset
                      </Button>
                    )}
                  </div>
                </div>
              </section>
            )}
            <TagImages tag={tag} source="all" count={detail.count} pinned={detail.thumb_image_id} />
          </div>
        )}
      </PageBody>
    </>
  );
}

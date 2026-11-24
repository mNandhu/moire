import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { FolderPlus, Images, RotateCw, UserRound, Wand2 } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { withBackgroundLocation } from "@/lib/backgroundLocation";
import { stepsState } from "@/lib/stepList";
import { DEFAULT_FILTERS, imageHref, type FeedItem } from "@/features/images/lib/imageFilter";
import { fetchImage, imageDocKey } from "@/features/images/lib/imageApi";
import { useCharacterLookup, useCharacters } from "@/features/characters/lib/queries";
import { characterHref, displayName } from "@/features/characters/lib/character";
import { Banner } from "@/features/discover/components/Banner";
import { ImageStrip } from "@/features/discover/components/DiscoverSection";
import { STRIP_SIZE } from "@/features/discover/lib/queries";
import { bestOf, characterIn, sessionDay, sessionSpan, type Session } from "@/features/overview/lib/sessions";

/** The link that opens `img` stepping through `items` (a session). */
export function useOpenIn(name: string, items: readonly FeedItem[] | undefined) {
  const location = useLocation();
  return (img: FeedItem) => ({
    to: imageHref(img._id, DEFAULT_FILTERS),
    state: { ...withBackgroundLocation(location), ...stepsState({ name, items: [...(items ?? [])] }) },
  });
}

/**
 * Overview's banner: the latest day's work, shown by its best image and
 * named for the character in it (else for the day), with the rest of it as
 * a shelf. With no images at all, the ways to get some.
 */
export function LatestSession({
  session,
  pending,
  failed,
  onRetry,
}: {
  session: Session<FeedItem> | undefined;
  pending: boolean;
  /** The images couldn't be loaded: not the same as none. */
  failed?: boolean;
  onRetry?: () => void;
}) {
  const best = session ? bestOf(session.items) : undefined;
  const doc = useQuery({
    queryKey: imageDocKey(best?._id ?? ""),
    queryFn: ({ signal }) => fetchImage(best!._id, { signal }),
    enabled: !!best,
    staleTime: 60_000,
  });
  const characters = useCharacters();
  const names = useCharacterLookup();
  const who = doc.data && characters.data ? characterIn(doc.data.tags, names) : undefined;
  const open = useOpenIn("overview:latest", session?.items);

  if (failed && !session) {
    return (
      <Banner
        label="Latest session"
        picture={null}
        text={
          <div>
            <h2 className="text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-50 sm:text-5xl">
              Couldn't load your recent images
            </h2>
          </div>
        }
        actions={
          <Button variant="primary" onClick={onRetry}>
            <RotateCw size={16} /> Try again
          </Button>
        }
      />
    );
  }

  if (!pending && !session) {
    return (
      <Banner
        label="Latest session"
        picture={null}
        color="rgb(139 92 246)"
        text={
          <div>
            <h2 className="text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-50 sm:text-5xl">
              Nothing here yet
            </h2>
            <p className="mt-2 text-sm text-neutral-300">Add a folder of images or make some.</p>
          </div>
        }
        actions={
          <>
            <ButtonLink variant="primary" to="/libraries">
              <FolderPlus size={16} /> Add library
            </ButtonLink>
            <ButtonLink to="/generate">
              <Wand2 size={16} /> Generate
            </ButtonLink>
          </>
        }
      />
    );
  }

  const count = session?.items.length ?? 0;
  const rest = session?.items.filter((it) => it._id !== best?._id).slice(0, STRIP_SIZE);
  // Named once the character check is in, so the title doesn't change under the eye.
  const ready = session && best && !doc.isPending && !characters.isPending;
  const when = session ? sessionDay(session.end) : "";
  return (
    <Banner
      label="Latest session"
      picture={
        best
          ? {
              id: best._id,
              src: best.thumb_url,
              face: null,
              focus: null,
              aspect: best.width && best.height ? best.width / best.height : null,
            }
          : undefined
      }
      color={who?.color}
      text={
        ready ? (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-300">
              {who ? `Latest session · ${when}` : "Latest session"}
            </p>
            <h2 className="line-clamp-2 text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-50 sm:text-5xl">
              {who ? displayName(who).name : when}
            </h2>
            <p className="mt-1.5 truncate text-sm tabular-nums text-neutral-300">
              {count.toLocaleString()}
              {session.partial ? "+" : ""} {count === 1 && !session.partial ? "image" : "images"} · {sessionSpan(session)}
            </p>
          </div>
        ) : undefined
      }
      actions={
        ready && (
          <>
            <ButtonLink variant="primary" {...open(best)}>
              <Images size={16} /> View session
            </ButtonLink>
            {who && (
              <ButtonLink to={characterHref(who.tag)} aria-label="Open character">
                <UserRound size={16} /> <span className="hidden sm:inline">Open character</span>
              </ButtonLink>
            )}
          </>
        )
      }
    >
      {(pending || !!rest?.length) && (
        <ImageStrip
          name="overview:latest"
          items={rest}
          pending={pending}
          filters={DEFAULT_FILTERS}
          size="sm"
          placeholders={6}
          steps={session?.items}
        />
      )}
    </Banner>
  );
}


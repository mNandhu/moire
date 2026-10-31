import type { FeedItem, ImageDetail } from "../lib/imageFilter";

// Whole image payloads for tests, with every key the wire always sends. No
// cast: a key added to the types fails here until it gets a default.

/** A feed row (GET /images); `group_id`/`group_count` only when given. */
export function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  const _id = over._id ?? "L1:a.png";
  return {
    _id,
    path: _id.slice(_id.indexOf(":") + 1),
    width: 512,
    height: 512,
    thumb_url: `/thumb/${_id}`,
    blurhash: null,
    rating: null,
    score: null,
    quarantined: false,
    mtime: null,
    has_ai_tags: true,
    ...over,
  };
}

/** The single-image document (GET /images/{id}). */
export function imageDetail(over: Partial<ImageDetail> = {}): ImageDetail {
  const _id = over._id ?? "L1:a.png";
  return {
    ...feedItem({ _id }),
    library_id: _id.slice(0, _id.indexOf(":")),
    size: null,
    tags: [],
    gen: null,
    ai: null,
    ctime: null,
    thumb_key: null,
    has_tags: false,
    has_prompt_tags: false,
    ...over,
  };
}

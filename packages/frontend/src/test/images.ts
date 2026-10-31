import type { FeedItem, ImageDetail } from "../lib/imageFilter";

// Whole image payloads for tests, with every key the wire always sends. No
// cast: a key added to the types fails here until it gets a default.

// Unknown flags are null, as on a row nothing has set them for, so a test
// states the ones it relies on.

/** `L1:a.png` as its library and path; an id with no colon is all path. */
function idParts(_id: string): { library: string; path: string } {
  const i = _id.indexOf(":");
  return i < 0 ? { library: "", path: _id } : { library: _id.slice(0, i), path: _id.slice(i + 1) };
}

/** A feed row (GET /images); `group_id`/`group_count` only when given. */
export function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  const _id = over._id ?? "L1:a.png";
  return {
    _id,
    path: idParts(_id).path,
    width: 512,
    height: 512,
    thumb_url: `/thumb/${_id}`,
    blurhash: null,
    rating: null,
    score: null,
    quarantined: null,
    mtime: null,
    has_ai_tags: null,
    ...over,
  };
}

/** The single-image document (GET /images/{id}). */
export function imageDetail(over: Partial<ImageDetail> = {}): ImageDetail {
  const _id = over._id ?? "L1:a.png";
  return {
    ...feedItem({ _id }),
    library_id: idParts(_id).library,
    size: null,
    tags: [],
    gen: null,
    ai: null,
    ctime: null,
    thumb_key: null,
    has_tags: null,
    has_prompt_tags: null,
    ...over,
  };
}

/**
 * Transcript window: the newest `limit` messages ending at `before`, so a phone
 * can render a long session immediately and page backwards on scroll.
 *
 * @param {unknown[]} all
 * @param {URLSearchParams} searchParams
 */
export function messagePage(all, searchParams) {
  const total = all.length;
  const limit = positiveInt(searchParams.get("limit"));
  if (limit === null) return { messages: all, total, start: 0, hasMore: false };
  // `Number(null)` is 0, so an absent cursor must be detected before coercion.
  const before = positiveInt(searchParams.get("before"));
  const end = before === null ? total : Math.min(before, total);
  const start = Math.max(0, end - limit);
  return { messages: all.slice(start, end), total, start, hasMore: start > 0 };
}

/** @param {string | null} value */
function positiveInt(value) {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

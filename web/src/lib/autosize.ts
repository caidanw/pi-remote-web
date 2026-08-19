/**
 * Composer autosize maths, kept pure so the row cap is testable.
 * Safari has no `field-sizing: content`, so the textarea height is always
 * driven from a measured scrollHeight rather than the browser's own sizing.
 */
export type AutosizeInput = {
  /** scrollHeight measured with the textarea collapsed to 0. */
  scrollHeight: number;
  lineHeight: number;
  /** padding + border on the block axis. */
  chrome: number;
  maxRows: number;
  /** Optional absolute ceiling (px); ignored when not a finite number. */
  maxHeight?: number | string;
};

export function autosizeHeight({
  scrollHeight,
  lineHeight,
  chrome,
  maxRows,
  maxHeight,
}: AutosizeInput): { height: number; scrollable: boolean } {
  const rows = Math.max(1, maxRows);
  const line = lineHeight > 0 ? lineHeight : 20;
  const ceilings = [line * rows + chrome];
  if (typeof maxHeight === "number" && Number.isFinite(maxHeight)) ceilings.push(maxHeight);
  const max = Math.min(...ceilings);
  const content = Math.max(scrollHeight, line + chrome);
  return { height: Math.min(content, max), scrollable: content > max };
}

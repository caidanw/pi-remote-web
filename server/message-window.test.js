import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messagePage } from "./message-window.js";

const all = Array.from({ length: 10 }, (_, i) => ({ i }));
const page = (query) => messagePage(all, new URLSearchParams(query));

describe("transcript windowing", () => {
  it("returns the whole transcript without a limit", () => {
    assert.deepEqual(page(""), { messages: all, total: 10, start: 0, hasMore: false });
  });

  it("returns the newest messages, not an empty slice", () => {
    // Regression: an absent `before` coerced to 0 and returned nothing.
    const result = page("limit=3");
    assert.deepEqual(
      result.messages.map((m) => m.i),
      [7, 8, 9],
    );
    assert.deepEqual({ total: result.total, start: result.start, hasMore: result.hasMore }, {
      total: 10,
      start: 7,
      hasMore: true,
    });
  });

  it("pages backwards from a cursor and reports the start of history", () => {
    const older = page("limit=3&before=7");
    assert.deepEqual(
      older.messages.map((m) => m.i),
      [4, 5, 6],
    );
    assert.equal(older.hasMore, true);

    const oldest = page("limit=5&before=4");
    assert.deepEqual(
      oldest.messages.map((m) => m.i),
      [0, 1, 2, 3],
    );
    assert.equal(oldest.hasMore, false);
  });

  it("ignores junk values instead of emptying the transcript", () => {
    for (const query of ["limit=0", "limit=-4", "limit=abc", "limit="]) {
      assert.equal(page(query).messages.length, 10, query);
    }
    assert.equal(page("limit=3&before=abc").messages.length, 3);
    assert.equal(page("limit=3&before=999").messages.at(-1).i, 9);
  });

  it("handles an empty transcript", () => {
    assert.deepEqual(messagePage([], new URLSearchParams("limit=5")), {
      messages: [],
      total: 0,
      start: 0,
      hasMore: false,
    });
  });
});

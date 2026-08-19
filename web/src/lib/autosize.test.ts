import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autosizeHeight } from "./autosize.ts";

const base = { lineHeight: 20, chrome: 24, maxRows: 3 };

describe("composer autosize", () => {
  it("shows one row when empty or single-line", () => {
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 0 }), { height: 44, scrollable: false });
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 44 }), { height: 44, scrollable: false });
  });

  it("grows with content up to the row cap, then scrolls", () => {
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 64 }), { height: 64, scrollable: false });
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 84 }), { height: 84, scrollable: false });
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 300 }), { height: 84, scrollable: true });
  });

  it("never adopts a stretched measurement beyond the cap", () => {
    // Safari reports the full composer height when the textarea is stretched.
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 600 }), { height: 84, scrollable: true });
  });

  it("honours a smaller absolute ceiling and ignores non-numeric ones", () => {
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 300, maxHeight: 60 }), {
      height: 60,
      scrollable: true,
    });
    assert.deepEqual(autosizeHeight({ ...base, scrollHeight: 300, maxHeight: "50vh" }), {
      height: 84,
      scrollable: true,
    });
  });

  it("falls back to a sane line height", () => {
    assert.deepEqual(autosizeHeight({ ...base, lineHeight: 0, scrollHeight: 0 }), {
      height: 44,
      scrollable: false,
    });
  });
});

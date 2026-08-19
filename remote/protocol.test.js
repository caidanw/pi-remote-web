import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFrameParser, encodeFrame } from "./protocol.js";

describe("remote protocol", () => {
  it("parses fragmented and adjacent frames", () => {
    const frames = [];
    const errors = [];
    const parser = createFrameParser({
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
    });

    const encoded = encodeFrame({ type: "one" }) + encodeFrame({ type: "two" });
    parser.push(encoded.slice(0, 7));
    parser.push(encoded.slice(7));

    assert.deepEqual(frames, [{ type: "one" }, { type: "two" }]);
    assert.deepEqual(errors, []);
  });

  it("rejects malformed and oversized frames", () => {
    const errors = [];
    const parser = createFrameParser({
      onFrame: () => assert.fail("invalid frame reached consumer"),
      onError: (error) => errors.push(error.message),
      maxFrameBytes: 8,
    });

    parser.push("not-json\n");
    parser.push("123456789");

    assert.deepEqual(errors, [
      "invalid remote frame",
      "remote frame exceeds size limit",
    ]);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAskModelResponse } from "./ask-response.js";

describe("parseAskModelResponse", () => {
  it("keeps only unique, available source ids", () => {
    assert.deepEqual(
      parseAskModelResponse(
        '{"answer":"Inspect the bearing.","source_ids":["SOP-MCH-042","SOP-MCH-042"]}',
        new Set(["SOP-MCH-042"]),
      ),
      { answer: "Inspect the bearing.", sourceIds: ["SOP-MCH-042"] },
    );
  });

  it("rejects invented citations", () => {
    assert.throws(
      () =>
        parseAskModelResponse(
          '{"answer":"Check coolant.","source_ids":["CAP-999"]}',
          new Set(["CAP-7"]),
        ),
      /unavailable source/,
    );
  });

  it("accepts a JSON object wrapped in model commentary", () => {
    assert.deepEqual(
      parseAskModelResponse(
        'Result:\n```json\n{"answer":"Inspect the bearing.","source_ids":["SOP-MCH-042"]}\n```',
        new Set(["SOP-MCH-042"]),
      ),
      { answer: "Inspect the bearing.", sourceIds: ["SOP-MCH-042"] },
    );
  });
});

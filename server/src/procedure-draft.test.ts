import assert from "node:assert/strict";
import test from "node:test";
import { parseProcedureDraft } from "./procedure-draft.js";

test("parses the exact procedure draft shape", () => {
  assert.deepEqual(
    parseProcedureDraft(
      JSON.stringify({
        title: "Check coolant contamination after bearing replacement",
        steps: ["Inspect the coolant for contamination."],
        tools: [],
        safety: ["Stop the machine before inspection."],
      }),
    ),
    {
      title: "Check coolant contamination after bearing replacement",
      steps: ["Inspect the coolant for contamination."],
      tools: [],
      safety: ["Stop the machine before inspection."],
    },
  );
});

test("rejects markdown, extra keys, and empty steps", () => {
  assert.throws(() => parseProcedureDraft('```json\n{"title":"x"}\n```'), /valid JSON/);
  assert.throws(
    () =>
      parseProcedureDraft(
        JSON.stringify({ title: "x", steps: ["Do x"], tools: [], safety: [], extra: true }),
      ),
    /exactly/,
  );
  assert.throws(
    () => parseProcedureDraft(JSON.stringify({ title: "x", steps: [], tools: [], safety: [] })),
    /non-empty/,
  );
});

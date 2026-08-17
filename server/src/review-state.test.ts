import assert from "node:assert/strict";
import test from "node:test";
import { reviewStatus } from "./review-state.js";

test("derives all procedure review states", () => {
  assert.equal(reviewStatus(false, null), "pending");
  assert.equal(reviewStatus(true, null), "approved");
  assert.equal(reviewStatus(false, new Date("2026-08-17T12:00:00Z")), "rejected");
});

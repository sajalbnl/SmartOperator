import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankDocuments } from "./retrieval-ranking.js";

describe("rankDocuments", () => {
  const documents = [
    {
      content: "Inspect spindle vibration. Replace the bearing if roughness is confirmed.",
      createdAt: null,
      id: "SOP-MCH-042",
      label: "Spindle Vibration Troubleshooting",
      title: "Spindle Vibration Troubleshooting",
      type: "sop" as const,
    },
    {
      content: "Check coolant contamination before replacing the bearing again.",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      id: "CAP-7",
      label: "Coolant contamination before bearing replacement",
      title: "Coolant contamination before bearing replacement",
      type: "capture" as const,
    },
    {
      content: "Clean chips from the work envelope.",
      createdAt: null,
      id: "SOP-MCH-018",
      label: "Chip removal",
      title: "Chip removal",
      type: "sop" as const,
    },
  ];

  it("retrieves the written SOP and related approved field capture", () => {
    const result = rankDocuments(
      "How do I troubleshoot vibration on CNC-042?",
      "CNC-042",
      documents,
    );
    assert.deepEqual(
      result.map((document) => document.id),
      ["SOP-MCH-042", "CAP-7"],
    );
  });

  it("does not match unrelated knowledge solely because the machine id is present", () => {
    const result = rankDocuments("How do I troubleshoot vibration on CNC-042?", "CNC-042", [
      documents[2]!,
    ]);
    assert.deepEqual(result, []);
  });
});

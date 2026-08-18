import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion } from "./ai.js";
import type { RetrievedDocument } from "./retrieval.js";

test("retries a truncated Ask response with several approved captures", async () => {
  const documents: RetrievedDocument[] = [
    {
      id: "CAP-1",
      label: "Bearing replacement contamination check",
      type: "capture",
      title: "Bearing replacement contamination check",
      content: "Check coolant contamination before replacing the bearing again.",
    },
    {
      id: "CAP-2",
      label: "Coolant sight glass inspection",
      type: "capture",
      title: "Coolant sight glass inspection",
      content: "Inspect the coolant sight glass for cloudiness or suspended debris.",
    },
    {
      id: "CAP-3",
      label: "Contamination isolation",
      type: "capture",
      title: "Contamination isolation",
      content: "If contaminated, isolate the machine and replace the coolant.",
    },
    {
      id: "SOP-MCH-042",
      label: "Spindle Vibration Troubleshooting",
      type: "sop",
      title: "Spindle Vibration Troubleshooting",
      content: "Stop the spindle, inspect the holder, and inspect the spindle bearing.",
    },
  ];
  const responses = [
    {
      content: [{ type: "text", text: '{"answer":"First check the coolant' }],
      stop_reason: "max_tokens",
    },
    {
      content: [
        {
          type: "text",
          text:
            '{"answer":"First check the coolant for contamination, then follow the spindle inspection SOP.","source_ids":["CAP-1","CAP-2","CAP-3","SOP-MCH-042"]}',
        },
      ],
      stop_reason: "end_turn",
    },
  ];
  const requestBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    assert.ok(response);
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };

  try {
    const result = await answerQuestion(
      "How do I troubleshoot vibration on CNC-042?",
      "CNC-042",
      documents,
    );

    assert.deepEqual(result.sourceIds, ["CAP-1", "CAP-2", "CAP-3", "SOP-MCH-042"]);
    assert.equal(requestBodies.length, 2);
    assert.match(String(requestBodies[1]?.system), /previous response failed validation/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  }
});

test("retries when an Ask answer ignores approved captures", async () => {
  const documents: RetrievedDocument[] = [
    {
      id: "CAP-1",
      label: "Coolant contamination check",
      type: "capture",
      title: "Coolant contamination check",
      content: "Check coolant contamination before replacing the bearing again.",
    },
    {
      id: "SOP-MCH-042",
      label: "Spindle Vibration Troubleshooting",
      type: "sop",
      title: "Spindle Vibration Troubleshooting",
      content: "Inspect the toolholder and spindle bearing.",
    },
  ];
  const responses = [
    {
      content: [
        {
          type: "text",
          text:
            '{"answer":"Inspect the toolholder and spindle bearing.","source_ids":["SOP-MCH-042"]}',
        },
      ],
      stop_reason: "end_turn",
    },
    {
      content: [
        {
          type: "text",
          text:
            '{"answer":"First check the coolant for contamination, then inspect the toolholder and spindle bearing.","source_ids":["CAP-1","SOP-MCH-042"]}',
        },
      ],
      stop_reason: "end_turn",
    },
  ];
  const requestBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    assert.ok(response);
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };

  try {
    const result = await answerQuestion(
      "How do I troubleshoot vibration on CNC-042?",
      "CNC-042",
      documents,
    );

    assert.deepEqual(result.sourceIds, ["CAP-1", "SOP-MCH-042"]);
    assert.equal(requestBodies.length, 2);
    assert.match(String(requestBodies[0]?.system), /include every one of these IDs.*CAP-1/i);
    assert.match(String(requestBodies[1]?.system), /omitted required approved capture/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  }
});

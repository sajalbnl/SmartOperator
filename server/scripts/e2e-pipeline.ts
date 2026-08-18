import "dotenv/config";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { db } from "../src/db.js";
import { requireEnv, responseError } from "./env.js";

const filePath = process.argv[2];
const allowStructureStub = process.argv.includes("--allow-structure-stub");
const demoQuestion = "How do I troubleshoot vibration on CNC-042?";
if (!filePath) {
  throw new Error(
    "Usage: npm run e2e:pipeline -- /absolute/path/to/synthetic-video.mp4 [--allow-structure-stub]",
  );
}

const fileInfo = await stat(filePath);
const apiBaseUrl = (
  process.env.API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`
).replace(/\/$/, "");
const s3 = new S3Client({ region: requireEnv("AWS_REGION") });
let captureId: string | null = null;

type Part = {
  byteEnd: number;
  byteStart: number;
  partNumber: number;
  presignedUrl: string;
};

type Pipeline = {
  error: string | null;
  status: "uploaded" | "transcribing" | "structuring" | "ready" | "failed";
};

type AskResult = {
  answer: string;
  question: string;
  sources: Array<{ id: string; type: "capture" | "sop" }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${await responseError(response)}`);
  }
  return (await response.json()) as T;
}

async function waitForTerminal(): Promise<Pipeline> {
  const deadline = Date.now() + 150_000;
  let pipeline = await request<Pipeline>(`/captures/${captureId}/pipeline`);
  while (!['ready', 'failed'].includes(pipeline.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    pipeline = await request<Pipeline>(`/captures/${captureId}/pipeline`);
  }
  if (!['ready', 'failed'].includes(pipeline.status)) {
    throw new Error(`Pipeline timed out in ${pipeline.status}.`);
  }
  return pipeline;
}

async function rowCounts() {
  const result = await db.query<{ procedures: number; transcripts: number }>(
    `SELECT
       (SELECT COUNT(*)::INTEGER FROM transcripts WHERE capture_id = $1) AS transcripts,
       (SELECT COUNT(*)::INTEGER FROM procedures WHERE capture_id = $1) AS procedures`,
    [captureId],
  );
  return result.rows[0];
}

try {
  const before = await request<AskResult>("/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine_id: "CNC-042", text: demoQuestion }),
  });
  if (
    before.question !== demoQuestion ||
    !before.sources.some((source) => source.id === "SOP-MCH-042") ||
    before.sources.some((source) => source.type === "capture") ||
    !before.answer.toLowerCase().includes("bearing")
  ) {
    throw new Error(`First Ask did not produce the seeded-SOP baseline: ${JSON.stringify(before)}`);
  }
  console.log(`First Ask: ${before.answer}`);

  const plan = await request<{ captureId: string; parts: Part[] }>("/captures", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `phase4-synthetic-${randomUUID()}`,
    },
    body: JSON.stringify({
      machine_id: "CNC-042",
      operator_id: "pipeline-test",
      duration_s: 60,
      total_bytes: fileInfo.size,
    }),
  });
  captureId = plan.captureId;
  const file = await open(filePath, "r");
  try {
    for (const part of plan.parts) {
      const byteLength = part.byteEnd - part.byteStart + 1;
      const bytes = Buffer.allocUnsafe(byteLength);
      const { bytesRead } = await file.read(bytes, 0, byteLength, part.byteStart);
      if (bytesRead !== byteLength) {
        throw new Error(`Could not read all bytes for part ${part.partNumber}.`);
      }
      const upload = await fetch(part.presignedUrl, { method: "PUT", body: bytes });
      if (!upload.ok) {
        throw new Error(`S3 part upload failed: ${await responseError(upload)}`);
      }
      const etag = upload.headers.get("etag");
      if (!etag) {
        throw new Error("S3 part upload returned no ETag.");
      }
      await request(`/captures/${captureId}/parts/${part.partNumber}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ etag }),
      });
    }
  } finally {
    await file.close();
  }

  await request(`/captures/${captureId}/complete`, { method: "POST" });
  const firstRun = await waitForTerminal();
  const firstCounts = await rowCounts();
  if (firstRun.status === "ready") {
    console.log(`Synthetic capture ${captureId} reached ready with live AI services.`);
    if (firstCounts?.transcripts !== 1 || firstCounts.procedures !== 1) {
      throw new Error(`Unexpected first-run row counts: ${JSON.stringify(firstCounts)}`);
    }

    // Simulate a failure after transcription. The retry must reuse the existing
    // transcript, recreate only the missing draft, and remain safe when called twice.
    await db.query("DELETE FROM procedures WHERE capture_id = $1", [captureId]);
    await db.query(
      `UPDATE captures
       SET pipeline_status = 'failed', pipeline_error = 'Synthetic retry verification'
       WHERE id = $1`,
      [captureId],
    );
    await request(`/captures/${captureId}/pipeline/retry`, { method: "POST" });
    await request(`/captures/${captureId}/pipeline/retry`, { method: "POST" });

    const retried = await waitForTerminal();
    if (retried.status !== "ready") {
      throw new Error(`Retried pipeline failed: ${retried.error}`);
    }
    const retriedCounts = await rowCounts();
    if (retriedCounts?.transcripts !== 1 || retriedCounts.procedures !== 1) {
      throw new Error(`Retry created duplicate rows: ${JSON.stringify(retriedCounts)}`);
    }
  } else {
    if (!allowStructureStub) {
      throw new Error(`Initial pipeline failed: ${firstRun.error}`);
    }
    if (firstCounts?.transcripts !== 1 || firstCounts.procedures !== 0) {
      throw new Error(`Failure did not preserve one transcript: ${JSON.stringify(firstCounts)}`);
    }

    await request(`/captures/${captureId}/pipeline/retry`, { method: "POST" });
    await request(`/captures/${captureId}/pipeline/retry`, { method: "POST" });
    const retried = await waitForTerminal();
    const failedRetryCounts = await rowCounts();
    if (
      retried.status !== "failed" ||
      failedRetryCounts?.transcripts !== 1 ||
      failedRetryCounts.procedures !== 0
    ) {
      throw new Error(
        `Failed retry was not idempotent: ${retried.status} ${JSON.stringify(failedRetryCounts)}`,
      );
    }

    console.log(`Live structuring unavailable (${firstRun.error}); failed retry kept one transcript.`);
    await db.query(
      `INSERT INTO procedures
         (capture_id, title, steps_json, tools_json, safety_json, source, approved)
       VALUES ($1, $2, $3::JSONB, $4::JSONB, $5::JSONB, 'capture', FALSE)`,
      [
        captureId,
        "Test coolant contamination before replacing the bearing again",
        JSON.stringify([
          "Confirm that vibration persists after the bearing replacement.",
          "Check the coolant for contamination before replacing the bearing again.",
        ]),
        JSON.stringify([]),
        JSON.stringify([]),
      ],
    );
    await db.query(
      `UPDATE captures
       SET pipeline_status = 'ready', pipeline_error = NULL, pipeline_updated_at = NOW()
       WHERE id = $1`,
      [captureId],
    );
    await request(`/captures/${captureId}/pipeline/retry`, { method: "POST" });
    await request(`/captures/${captureId}/pipeline/retry`, { method: "POST" });
    const stubCounts = await rowCounts();
    if (stubCounts?.transcripts !== 1 || stubCounts.procedures !== 1) {
      throw new Error(`Ready re-trigger created duplicates: ${JSON.stringify(stubCounts)}`);
    }
    console.log("Used one test-only draft to verify Review/Approve while Anthropic is blocked.");
  }

  const review = await request<{
    procedures: Array<{
      captureId: string;
      id: string;
      safety: string[];
      steps: string[];
      title: string;
      tools: string[];
      transcript: string;
    }>;
  }>("/procedures?review_status=pending");
  const listedDraft = review.procedures.find((procedure) => procedure.captureId === captureId);
  const draftText = listedDraft
    ? [listedDraft.title, ...listedDraft.steps].join(" ").toLowerCase()
    : "";
  if (
    !listedDraft ||
    !listedDraft.transcript.trim() ||
    !listedDraft.title.trim() ||
    listedDraft.steps.length === 0 ||
    !draftText.includes("coolant") ||
    !draftText.includes("contamination") ||
    !draftText.includes("bearing")
  ) {
    throw new Error("Review list did not include a sensible coolant-contamination draft.");
  }
  console.log(`Review transcript: ${listedDraft.transcript}`);
  console.log(`Draft: ${JSON.stringify({
    title: listedDraft.title,
    steps: listedDraft.steps,
    tools: listedDraft.tools,
    safety: listedDraft.safety,
  })}`);

  const procedureResult = await db.query<{ id: string }>(
    "SELECT id FROM procedures WHERE capture_id = $1",
    [captureId],
  );
  const procedureId = procedureResult.rows[0]?.id;
  if (!procedureId) {
    throw new Error("Retried pipeline produced no procedure.");
  }
  await request(`/procedures/${procedureId}/approve`, { method: "POST" });
  await request(`/procedures/${procedureId}/approve`, { method: "POST" });
  const approved = await db.query<{ approved: boolean }>(
    "SELECT approved FROM procedures WHERE id = $1",
    [procedureId],
  );
  if (approved.rows[0]?.approved !== true) {
    throw new Error("Approval did not persist approved=true.");
  }

  console.log("Review response included transcript/draft; repeated approval stayed true.");

  const after = await request<AskResult>("/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine_id: "CNC-042", text: demoQuestion }),
  });
  const normalizedAfter = after.answer.toLowerCase();
  if (
    after.question !== demoQuestion ||
    !after.sources.some((source) => source.id === `CAP-${captureId}`) ||
    !normalizedAfter.includes("coolant") ||
    !normalizedAfter.includes("contamin")
  ) {
    throw new Error(`Second Ask did not use captured knowledge: ${JSON.stringify(after)}`);
  }
  console.log(`Second Ask: ${after.answer}`);
  console.log("PASS: identical Ask improved after human approval and cited the capture.");
} finally {
  if (captureId) {
    const capture = await db.query<{ s3_key: string }>(
      "SELECT s3_key FROM captures WHERE id = $1",
      [captureId],
    );
    const key = capture.rows[0]?.s3_key;
    if (key) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: requireEnv("AWS_S3_BUCKET"), Key: key }),
      );
    }
    await db.query("DELETE FROM captures WHERE id = $1", [captureId]);
    console.log(`Cleaned up synthetic capture ${captureId}.`);
  }
  await db.end();
}

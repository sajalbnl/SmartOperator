import "dotenv/config";
import { db } from "../src/db.js";
import { responseError } from "./env.js";

const captureId = process.argv[2];
if (!captureId || !/^\d+$/.test(captureId)) {
  throw new Error("Usage: npm run verify:pipeline-retry -- <capture-id>");
}

const apiBaseUrl = (
  process.env.API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`
).replace(/\/$/, "");

type Counts = { procedures: number; transcripts: number };
type Pipeline = { status: "uploaded" | "transcribing" | "structuring" | "ready" | "failed" };

async function counts(): Promise<Counts> {
  const result = await db.query<Counts>(
    `SELECT
       (SELECT COUNT(*)::INTEGER FROM transcripts WHERE capture_id = $1) AS transcripts,
       (SELECT COUNT(*)::INTEGER FROM procedures WHERE capture_id = $1) AS procedures`,
    [captureId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Could not read pipeline row counts.");
  }
  return row;
}

async function request<T>(path: string, method = "GET"): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { method });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${await responseError(response)}`);
  }
  return (await response.json()) as T;
}

try {
  const before = await counts();
  const first = await request<Pipeline>(`/captures/${captureId}/pipeline/retry`, "POST");
  const second = await request<Pipeline>(`/captures/${captureId}/pipeline/retry`, "POST");
  console.log(`Retry responses: ${first.status}, ${second.status}`);

  const deadline = Date.now() + 150_000;
  let status = await request<Pipeline>(`/captures/${captureId}/pipeline`);
  while (!['ready', 'failed'].includes(status.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    status = await request<Pipeline>(`/captures/${captureId}/pipeline`);
  }

  const after = await counts();
  if (after.transcripts > 1 || after.procedures > 1) {
    throw new Error(`Duplicate rows detected: ${JSON.stringify(after)}`);
  }
  if (after.transcripts < before.transcripts || after.procedures < before.procedures) {
    throw new Error("A retry removed existing knowledge rows.");
  }
  console.log(`Pipeline ended ${status.status}; row counts are idempotent.`);
  console.table({ before, after });
} finally {
  await db.end();
}

import "dotenv/config";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { requireEnv, responseError } from "./env.js";

const MEBIBYTE = 1024 * 1024;
const FILE_SIZE = 30 * MEBIBYTE;
const API_BASE_URL = (
  process.env.API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`
).replace(/\/$/, "");
const filePath = join(tmpdir(), `smartoperator-e2e-${randomUUID()}.bin`);

type Part = {
  partNumber: number;
  byteStart: number;
  byteEnd: number;
  presignedUrl: string;
};

type CapturePlan = {
  captureId: string;
  parts: Part[];
};

type CaptureRecord = {
  status: string;
  total_bytes: string;
  s3_key: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${await responseError(response)}`);
  }
  return (await response.json()) as T;
}

async function expectConflict(path: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${path}`, { method: "POST" });
  if (response.status !== 409) {
    throw new Error(`Expected POST ${path} to return 409; received ${response.status}.`);
  }
}

async function generateFile(): Promise<string> {
  const file = await open(filePath, "w");
  const hash = createHash("sha256");

  try {
    for (let offset = 0; offset < FILE_SIZE; offset += MEBIBYTE) {
      const bytes = randomBytes(Math.min(MEBIBYTE, FILE_SIZE - offset));
      await file.write(bytes, 0, bytes.length, offset);
      hash.update(bytes);
    }
  } finally {
    await file.close();
  }

  return hash.digest("hex");
}

async function initializeCapture(label: string, proveRetry: boolean): Promise<CapturePlan> {
  const idempotencyKey = `smartoperator-e2e-${label}-${randomUUID()}`;
  const request: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      machine_id: "CNC-042",
      operator_id: "operator-demo",
      duration_s: 60,
      total_bytes: FILE_SIZE,
    }),
  };
  const first = await api<CapturePlan>("/captures", request);

  if (!proveRetry) {
    return first;
  }

  const retried = await api<CapturePlan>("/captures", request);
  if (retried.captureId !== first.captureId) {
    throw new Error("Repeated capture init created a different capture ID.");
  }
  console.log(`Init retry reused capture ${first.captureId}.`);
  return retried;
}

async function uploadPart(
  file: FileHandle,
  captureId: string,
  part: Part,
  proveRetry = false,
): Promise<void> {
  const byteLength = part.byteEnd - part.byteStart + 1;
  const bytes = Buffer.allocUnsafe(byteLength);
  const { bytesRead } = await file.read(bytes, 0, byteLength, part.byteStart);

  if (bytesRead !== byteLength) {
    throw new Error(
      `Part ${part.partNumber}: expected ${byteLength} file bytes, read ${bytesRead}.`,
    );
  }

  const response = await fetch(part.presignedUrl, {
    method: "PUT",
    body: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
  if (!response.ok) {
    throw new Error(`S3 PUT part ${part.partNumber} failed: ${await responseError(response)}`);
  }

  const etag = response.headers.get("etag");
  if (!etag) {
    throw new Error(`S3 PUT part ${part.partNumber} returned no ETag.`);
  }

  const completeRequest: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ etag }),
  };
  await api(`/captures/${captureId}/parts/${part.partNumber}/complete`, completeRequest);

  if (proveRetry) {
    const retried = await api<{ alreadyComplete: boolean }>(
      `/captures/${captureId}/parts/${part.partNumber}/complete`,
      completeRequest,
    );
    if (!retried.alreadyComplete) {
      throw new Error("Repeated part completion was not reported as idempotent.");
    }
  }

  console.log(`Capture ${captureId}: uploaded part ${part.partNumber}.`);
}

async function showChunks(
  database: Client,
  captureId: string,
  label: string,
): Promise<void> {
  const result = await database.query(
    `SELECT chunk.part_number,
            chunk.byte_start,
            chunk.byte_end,
            chunk.state,
            chunk.attempts,
            chunk.etag,
            chunk.last_error,
            capture.status AS capture_status
     FROM chunks AS chunk
     JOIN captures AS capture ON capture.id = chunk.capture_id
     WHERE chunk.capture_id = $1
     ORDER BY chunk.part_number`,
    [captureId],
  );
  console.log(`\n${label} — chunks for capture ${captureId}`);
  console.table(result.rows);
}

async function completeCapture(captureId: string): Promise<void> {
  const first = await api<{ status: string; alreadyComplete: boolean }>(
    `/captures/${captureId}/complete`,
    { method: "POST" },
  );
  if (first.status !== "uploaded") {
    throw new Error(`Capture ${captureId} did not transition to uploaded.`);
  }

  const retried = await api<{ status: string; alreadyComplete: boolean }>(
    `/captures/${captureId}/complete`,
    { method: "POST" },
  );
  if (!retried.alreadyComplete) {
    throw new Error("Repeated capture completion was not reported as idempotent.");
  }
  console.log(`Capture ${captureId}: completion retry was a 200 no-op.`);
}

async function verifyS3Object(
  database: Client,
  s3: S3Client,
  captureId: string,
  expectedSha256: string,
): Promise<void> {
  const result = await database.query<CaptureRecord>(
    "SELECT status, total_bytes, s3_key FROM captures WHERE id = $1",
    [captureId],
  );
  const capture = result.rows[0];
  if (!capture || capture.status !== "uploaded") {
    throw new Error(`Capture ${captureId} is not uploaded in Postgres.`);
  }

  const object = await s3.send(
    new GetObjectCommand({
      Bucket: requireEnv("AWS_S3_BUCKET"),
      Key: capture.s3_key,
    }),
  );
  if (object.ContentLength !== FILE_SIZE || Number(capture.total_bytes) !== FILE_SIZE) {
    throw new Error(`Capture ${captureId} has an unexpected assembled size.`);
  }
  if (!object.Body) {
    throw new Error(`Capture ${captureId} S3 object has no response body.`);
  }

  const actualSha256 = createHash("sha256")
    .update(await object.Body.transformToByteArray())
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Capture ${captureId} assembled bytes do not match the source file.`);
  }

  console.log(
    `Verified assembled object byte-for-byte: s3://${requireEnv("AWS_S3_BUCKET")}/${capture.s3_key}`,
  );
}

async function runFresh(
  file: FileHandle,
  database: Client,
  s3: S3Client,
  expectedSha256: string,
): Promise<void> {
  console.log("\n=== Fresh end-to-end upload ===");
  const capture = await initializeCapture("fresh", true);
  await expectConflict(`/captures/${capture.captureId}/complete`);

  for (const [index, part] of capture.parts.entries()) {
    await uploadPart(file, capture.captureId, part, index === 0);
  }

  await completeCapture(capture.captureId);
  await showChunks(database, capture.captureId, "Post-run");
  await verifyS3Object(database, s3, capture.captureId, expectedSha256);
}

async function runInterruptedResume(
  file: FileHandle,
  database: Client,
  s3: S3Client,
  expectedSha256: string,
): Promise<void> {
  console.log("\n=== Interrupted, then resumed upload ===");
  const capture = await initializeCapture("resume", false);
  const stopAfter = Math.floor(capture.parts.length / 2);

  for (const part of capture.parts.slice(0, stopAfter)) {
    await uploadPart(file, capture.captureId, part);
  }

  await showChunks(database, capture.captureId, "Mid-run after simulated process death");
  console.log("Discarded the original URL plan; requesting fresh URLs as a relaunched client.");

  const resumed = await api<CapturePlan>(`/captures/${capture.captureId}/resume`);
  const expectedRemaining = capture.parts.slice(stopAfter).map((part) => part.partNumber);
  const actualRemaining = resumed.parts.map((part) => part.partNumber);
  if (JSON.stringify(actualRemaining) !== JSON.stringify(expectedRemaining)) {
    throw new Error(
      `Resume returned parts ${actualRemaining.join(",")}; expected ${expectedRemaining.join(",")}.`,
    );
  }

  for (const part of resumed.parts) {
    await uploadPart(file, capture.captureId, part);
  }

  await completeCapture(capture.captureId);
  await showChunks(database, capture.captureId, "Post-resume run");
  await verifyS3Object(database, s3, capture.captureId, expectedSha256);
}

const database = new Client({ connectionString: requireEnv("DATABASE_URL") });
const s3 = new S3Client({ region: requireEnv("AWS_REGION") });
let file: FileHandle | undefined;

try {
  console.log(`Generating ${FILE_SIZE / MEBIBYTE} MiB test file at ${filePath}`);
  const expectedSha256 = await generateFile();
  file = await open(filePath, "r");
  await database.connect();

  const health = await api<{ status: string }>("/health");
  if (health.status !== "ok") {
    throw new Error("Server health probe did not return ok.");
  }

  await runFresh(file, database, s3, expectedSha256);
  await runInterruptedResume(file, database, s3, expectedSha256);
  console.log("\nPASS: fresh and interrupted/resumed 30 MiB uploads are correct.");
} finally {
  await file?.close().catch(() => undefined);
  await database.end().catch(() => undefined);
  await unlink(filePath).catch(() => undefined);
}


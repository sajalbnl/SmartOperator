import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { HttpError } from "./http-error.js";
import {
  completeMultipartUpload,
  createMultipartUpload,
  isMissingMultipartUpload,
  objectHasSize,
  presignPart,
} from "./storage.js";

export const PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10_000;

type CaptureInput = {
  machineId: string;
  operatorId: string;
  durationSeconds: number;
  totalBytes: number;
};

type CaptureRow = {
  id: string;
  machine_id: string;
  operator_id: string;
  duration_s: number;
  total_bytes: string;
  status: string;
  s3_key: string;
  s3_upload_id: string | null;
  idempotency_key: string | null;
};

type ChunkRow = {
  part_number: number;
  byte_start: string;
  byte_end: string;
  etag: string | null;
  state: "pending" | "uploading" | "failed" | "done";
};

export type PlannedPart = {
  partNumber: number;
  byteStart: number;
  byteEnd: number;
};

export type PresignedPart = PlannedPart & { presignedUrl: string };

export function planParts(totalBytes: number): PlannedPart[] {
  const partCount = Math.ceil(totalBytes / PART_SIZE_BYTES);

  if (partCount > MAX_MULTIPART_PARTS) {
    throw new HttpError(
      400,
      `total_bytes requires ${partCount} parts; S3 allows at most ${MAX_MULTIPART_PARTS}.`,
    );
  }

  return Array.from({ length: partCount }, (_, index) => {
    const byteStart = index * PART_SIZE_BYTES;
    return {
      partNumber: index + 1,
      byteStart,
      byteEnd: Math.min(byteStart + PART_SIZE_BYTES, totalBytes) - 1,
    };
  });
}

function captureMatches(row: CaptureRow, input: CaptureInput): boolean {
  return (
    row.machine_id === input.machineId &&
    row.operator_id === input.operatorId &&
    row.duration_s === input.durationSeconds &&
    Number(row.total_bytes) === input.totalBytes
  );
}

async function createOrFindCapture(
  input: CaptureInput,
  idempotencyKey: string | null,
): Promise<CaptureRow> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        idempotencyKey,
      ]);
      const existing = await client.query<CaptureRow>(
        "SELECT * FROM captures WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      const row = existing.rows[0];

      if (row) {
        if (!captureMatches(row, input)) {
          throw new HttpError(
            409,
            "Idempotency-Key was already used with different capture metadata.",
          );
        }
        await client.query("COMMIT");
        return row;
      }
    }

    const key = `captures/${randomUUID()}.bin`;
    const inserted = await client.query<CaptureRow>(
      `INSERT INTO captures
         (machine_id, operator_id, status, duration_s, total_bytes, s3_key, idempotency_key)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6)
       RETURNING *`,
      [
        input.machineId,
        input.operatorId,
        input.durationSeconds,
        input.totalBytes,
        key,
        idempotencyKey,
      ],
    );
    const capture = inserted.rows[0];

    if (!capture) {
      throw new Error("Postgres did not return the inserted capture.");
    }

    const parts = planParts(input.totalBytes);
    await client.query(
      `INSERT INTO chunks
         (capture_id, part_number, byte_start, byte_end, state)
       SELECT $1, plan.part_number, plan.byte_start, plan.byte_end, 'pending'
       FROM UNNEST($2::INTEGER[], $3::BIGINT[], $4::BIGINT[])
         AS plan(part_number, byte_start, byte_end)`,
      [
        capture.id,
        parts.map((part) => part.partNumber),
        parts.map((part) => part.byteStart),
        parts.map((part) => part.byteEnd),
      ],
    );

    await client.query("COMMIT");
    return capture;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function ensureMultipartInitialized(captureId: string): Promise<CaptureRow> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<CaptureRow>(
      "SELECT * FROM captures WHERE id = $1 FOR UPDATE",
      [captureId],
    );
    const capture = result.rows[0];

    if (!capture) {
      throw new HttpError(404, "Capture not found.");
    }

    if (capture.status === "uploaded" || capture.s3_upload_id) {
      await client.query("COMMIT");
      return capture;
    }

    const uploadId = await createMultipartUpload(capture.s3_key);
    const updated = await client.query<CaptureRow>(
      `UPDATE captures
       SET s3_upload_id = $2
       WHERE id = $1
       RETURNING *`,
      [capture.id, uploadId],
    );
    await client.query("COMMIT");
    return updated.rows[0] ?? { ...capture, s3_upload_id: uploadId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function issueUrls(captureId: string): Promise<PresignedPart[]> {
  const capture = await ensureMultipartInitialized(captureId);

  if (capture.status === "uploaded") {
    return [];
  }
  if (!capture.s3_upload_id) {
    throw new Error("Capture has no S3 multipart upload ID.");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const chunks = await client.query<ChunkRow>(
      `SELECT part_number, byte_start, byte_end, etag, state
       FROM chunks
       WHERE capture_id = $1 AND state <> 'done'
       ORDER BY part_number
       FOR UPDATE`,
      [captureId],
    );

    const parts = await Promise.all(
      chunks.rows.map(async (chunk) => ({
        partNumber: chunk.part_number,
        byteStart: Number(chunk.byte_start),
        byteEnd: Number(chunk.byte_end),
        presignedUrl: await presignPart(
          capture.s3_key,
          capture.s3_upload_id as string,
          chunk.part_number,
        ),
      })),
    );

    if (parts.length > 0) {
      await client.query(
        `UPDATE chunks
         SET state = 'uploading',
             attempts = attempts + 1,
             last_error = NULL,
             updated_at = NOW()
         WHERE capture_id = $1
           AND part_number = ANY($2::INTEGER[])
           AND state <> 'done'`,
        [captureId, parts.map((part) => part.partNumber)],
      );
    }

    await client.query("COMMIT");
    return parts;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeCapture(
  input: CaptureInput,
  idempotencyKey: string | null,
): Promise<{ captureId: string; parts: PresignedPart[] }> {
  const capture = await createOrFindCapture(input, idempotencyKey);
  return { captureId: capture.id, parts: await issueUrls(capture.id) };
}

export async function resumeCapture(
  captureId: string,
): Promise<{ captureId: string; parts: PresignedPart[] }> {
  return { captureId, parts: await issueUrls(captureId) };
}

export async function markPartComplete(
  captureId: string,
  partNumber: number,
  etag: string,
): Promise<{ captureId: string; partNumber: number; state: "done"; alreadyComplete: boolean }> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const capture = await client.query<{ status: string }>(
      "SELECT status FROM captures WHERE id = $1 FOR UPDATE",
      [captureId],
    );

    if (!capture.rows[0]) {
      throw new HttpError(404, "Capture not found.");
    }

    const result = await client.query<ChunkRow>(
      `SELECT part_number, byte_start, byte_end, etag, state
       FROM chunks
       WHERE capture_id = $1 AND part_number = $2
       FOR UPDATE`,
      [captureId, partNumber],
    );
    const chunk = result.rows[0];

    if (!chunk) {
      throw new HttpError(404, "Capture part not found.");
    }

    const alreadyComplete = chunk.state === "done";
    if (!alreadyComplete) {
      await client.query(
        `UPDATE chunks
         SET etag = $3,
             state = 'done',
             last_error = NULL,
             updated_at = NOW()
         WHERE capture_id = $1 AND part_number = $2`,
        [captureId, partNumber, etag],
      );
    }

    await client.query("COMMIT");
    return { captureId, partNumber, state: "done", alreadyComplete };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function finishCapture(
  captureId: string,
): Promise<{ captureId: string; status: "uploaded"; alreadyComplete: boolean }> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<CaptureRow>(
      "SELECT * FROM captures WHERE id = $1 FOR UPDATE",
      [captureId],
    );
    const capture = result.rows[0];

    if (!capture) {
      throw new HttpError(404, "Capture not found.");
    }
    if (capture.status === "uploaded") {
      await client.query("COMMIT");
      return { captureId, status: "uploaded", alreadyComplete: true };
    }
    if (!capture.s3_upload_id) {
      throw new HttpError(409, "Capture multipart upload has not been initialized.");
    }

    const chunks = await client.query<ChunkRow>(
      `SELECT part_number, byte_start, byte_end, etag, state
       FROM chunks
       WHERE capture_id = $1
       ORDER BY part_number
       FOR UPDATE`,
      [captureId],
    );
    const incompleteParts = chunks.rows
      .filter((chunk) => chunk.state !== "done" || !chunk.etag)
      .map((chunk) => chunk.part_number);

    if (incompleteParts.length > 0) {
      throw new HttpError(409, "Not all capture parts are complete.", {
        incompleteParts,
      });
    }

    try {
      await completeMultipartUpload(
        capture.s3_key,
        capture.s3_upload_id,
        chunks.rows.map((chunk) => ({
          partNumber: chunk.part_number,
          etag: chunk.etag as string,
        })),
      );
    } catch (error) {
      // S3 completion can succeed immediately before the process/DB transaction dies.
      // A retry then sees NoSuchUpload; exact object size at this capture's unique key
      // proves it is safe to commit the missing Postgres status transition.
      if (
        !isMissingMultipartUpload(error) ||
        !(await objectHasSize(capture.s3_key, Number(capture.total_bytes)))
      ) {
        throw error;
      }
    }

    if (!(await objectHasSize(capture.s3_key, Number(capture.total_bytes)))) {
      throw new Error("S3 completed the multipart upload with an unexpected object size.");
    }

    await client.query(
      `UPDATE captures
       SET status = 'uploaded',
           pipeline_status = COALESCE(pipeline_status, 'uploaded'),
           pipeline_error = NULL,
           pipeline_updated_at = NOW()
       WHERE id = $1`,
      [captureId],
    );
    await client.query("COMMIT");
    return { captureId, status: "uploaded", alreadyComplete: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

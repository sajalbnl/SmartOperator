import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import {
  PART_SIZE_BYTES,
  type CaptureQueueItem,
  type LocalCapture,
  type LocalChunk,
  type PresignedPart,
  type QueueSnapshot,
} from './types';

const DATABASE_NAME = 'smartoperator-queue.db';
const queueListeners = new Set<() => void>();
let databasePromise: Promise<SQLiteDatabase> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function makeLocalCaptureId() {
  const random = Math.random().toString(36).slice(2, 12);
  return `device-${Date.now().toString(36)}-${random}`;
}

function notifyQueueChanged() {
  queueListeners.forEach((listener) => listener());
}

async function migrate(database: SQLiteDatabase) {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT UNIQUE,
      machine_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      duration_s INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      file_uri TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      urls_refreshed_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
      part_number INTEGER NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_end INTEGER NOT NULL,
      etag TEXT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'uploading', 'failed', 'done')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      presigned_url TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(capture_id, part_number)
    );

    CREATE INDEX IF NOT EXISTS chunks_capture_state_idx
      ON chunks(capture_id, state, part_number);
    CREATE INDEX IF NOT EXISTS chunks_retry_idx
      ON chunks(state, next_attempt_at);
  `);
}

export function getDatabase() {
  if (!databasePromise) {
    databasePromise = openDatabaseAsync(DATABASE_NAME).then(async (database) => {
      await migrate(database);
      return database;
    });
  }
  return databasePromise;
}

export function subscribeToQueue(listener: () => void) {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

export async function enqueueCapture(input: {
  durationMillis: number;
  fileUri: string;
  machineId: string;
  operatorId: string;
  totalBytes: number;
}) {
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1) {
    throw new Error('The completed capture has no readable bytes.');
  }

  const database = await getDatabase();
  const captureId = makeLocalCaptureId();
  const timestamp = nowIso();
  const durationSeconds = Math.max(0, Math.round(input.durationMillis / 1_000));
  const partCount = Math.ceil(input.totalBytes / PART_SIZE_BYTES);

  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO captures
         (id, machine_id, operator_id, status, duration_s, total_bytes, file_uri,
          created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      captureId,
      input.machineId,
      input.operatorId,
      durationSeconds,
      input.totalBytes,
      input.fileUri,
      timestamp,
      timestamp,
    );

    for (let index = 0; index < partCount; index += 1) {
      const byteStart = index * PART_SIZE_BYTES;
      const byteEnd = Math.min(byteStart + PART_SIZE_BYTES, input.totalBytes) - 1;
      await transaction.runAsync(
        `INSERT INTO chunks
           (capture_id, part_number, byte_start, byte_end, state, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        captureId,
        index + 1,
        byteStart,
        byteEnd,
        timestamp,
      );
    }
  });

  notifyQueueChanged();
  return captureId;
}

export async function loadQueueSnapshot(): Promise<QueueSnapshot> {
  const database = await getDatabase();
  const captures = await database.getAllAsync<LocalCapture>(
    'SELECT * FROM captures ORDER BY created_at DESC',
  );
  const chunks = await database.getAllAsync<LocalChunk>(
    'SELECT * FROM chunks ORDER BY capture_id, part_number',
  );
  const chunksByCapture = new Map<string, LocalChunk[]>();

  chunks.forEach((chunk) => {
    const captureChunks = chunksByCapture.get(chunk.capture_id) ?? [];
    captureChunks.push(chunk);
    chunksByCapture.set(chunk.capture_id, captureChunks);
  });

  const items: CaptureQueueItem[] = captures.map((capture) => ({
    ...capture,
    chunks: chunksByCapture.get(capture.id) ?? [],
  }));

  return {
    captures: items,
    unfinishedCount: items.filter((capture) => capture.status !== 'done').length,
  };
}

export async function recoverInterruptedWork() {
  const database = await getDatabase();
  const timestamp = nowIso();
  const result = await database.runAsync(
    `UPDATE captures
     SET status = 'pending', updated_at = ?
     WHERE status IN ('registering', 'resuming')`,
    timestamp,
  );
  if (result.changes > 0) {
    notifyQueueChanged();
  }
}

export async function listUnfinishedCaptures() {
  const database = await getDatabase();
  return database.getAllAsync<LocalCapture>(
    `SELECT * FROM captures
     WHERE status <> 'done'
     ORDER BY created_at`,
  );
}

export async function listRegisteredUnfinishedCaptures() {
  const database = await getDatabase();
  return database.getAllAsync<LocalCapture>(
    `SELECT * FROM captures
     WHERE status <> 'done' AND server_id IS NOT NULL
     ORDER BY created_at`,
  );
}

export async function listChunks(captureId: string) {
  const database = await getDatabase();
  return database.getAllAsync<LocalChunk>(
    'SELECT * FROM chunks WHERE capture_id = ? ORDER BY part_number',
    captureId,
  );
}

export async function markRegistrationStarted(captureId: string) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE captures
     SET status = 'registering', last_error = NULL, updated_at = ?
     WHERE id = ?`,
    nowIso(),
    captureId,
  );
  notifyQueueChanged();
}

export async function markCaptureResuming(captureId: string) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE captures
     SET status = 'resuming', updated_at = ?
     WHERE id = ? AND status <> 'done'`,
    nowIso(),
    captureId,
  );
  notifyQueueChanged();
}

function validatePartPlan(localChunks: LocalChunk[], parts: PresignedPart[]) {
  if (localChunks.length !== parts.length) {
    throw new Error(
      `Server returned ${parts.length} parts for a ${localChunks.length}-part capture.`,
    );
  }

  const localByPart = new Map(localChunks.map((chunk) => [chunk.part_number, chunk]));
  parts.forEach((part) => {
    const local = localByPart.get(part.partNumber);
    if (!local || local.byte_start !== part.byteStart || local.byte_end !== part.byteEnd) {
      throw new Error(`Server byte range for part ${part.partNumber} does not match SQLite.`);
    }
  });
}

export async function storeRegistration(
  captureId: string,
  serverId: string,
  parts: PresignedPart[],
) {
  const database = await getDatabase();
  const localChunks = await listChunks(captureId);
  validatePartPlan(localChunks, parts);
  const timestamp = nowIso();
  const refreshedAt = Date.now();

  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE captures
       SET server_id = ?, status = 'pending', attempts = 0, last_error = NULL,
           next_attempt_at = 0, urls_refreshed_at = ?, updated_at = ?
       WHERE id = ?`,
      serverId,
      refreshedAt,
      timestamp,
      captureId,
    );
    for (const part of parts) {
      await transaction.runAsync(
        `UPDATE chunks
         SET presigned_url = ?, updated_at = ?
         WHERE capture_id = ? AND part_number = ?`,
        part.presignedUrl,
        timestamp,
        captureId,
        part.partNumber,
      );
    }
  });
  notifyQueueChanged();
}

export async function storeResumedParts(captureId: string, parts: PresignedPart[]) {
  const database = await getDatabase();
  const localChunks = await listChunks(captureId);
  const unfinished = localChunks.filter((chunk) => chunk.state !== 'done');
  const localByPart = new Map(unfinished.map((chunk) => [chunk.part_number, chunk]));
  const returnedPartNumbers = new Set<number>();

  parts.forEach((part) => {
    const local = localByPart.get(part.partNumber);
    if (!local || local.byte_start !== part.byteStart || local.byte_end !== part.byteEnd) {
      throw new Error(`Resume byte range for part ${part.partNumber} does not match SQLite.`);
    }
    returnedPartNumbers.add(part.partNumber);
  });

  const timestamp = nowIso();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    for (const part of parts) {
      await transaction.runAsync(
        `UPDATE chunks
         SET presigned_url = ?, updated_at = ?
         WHERE capture_id = ? AND part_number = ? AND state <> 'done'`,
        part.presignedUrl,
        timestamp,
        captureId,
        part.partNumber,
      );
    }

    // The resume contract returns every server-side non-done part. A missing
    // local unfinished part means the completion report reached the server
    // immediately before the app died, so reconcile that interrupted AFTER write.
    for (const chunk of unfinished) {
      if (!returnedPartNumbers.has(chunk.part_number)) {
        await transaction.runAsync(
          `UPDATE chunks
           SET state = 'done', last_error = NULL, presigned_url = NULL,
               next_attempt_at = 0, updated_at = ?
           WHERE id = ?`,
          timestamp,
          chunk.id,
        );
      }
    }

    await transaction.runAsync(
      `UPDATE captures
       SET status = 'pending', attempts = 0, last_error = NULL,
           next_attempt_at = 0, urls_refreshed_at = ?, updated_at = ?
       WHERE id = ?`,
      Date.now(),
      timestamp,
      captureId,
    );
  });
  notifyQueueChanged();
}

export async function failCapture(capture: LocalCapture, error: string, retryAt: number) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE captures
     SET status = 'failed', attempts = attempts + 1, last_error = ?,
         next_attempt_at = ?, updated_at = ?
     WHERE id = ?`,
    error,
    retryAt,
    nowIso(),
    capture.id,
  );
  notifyQueueChanged();
}

export async function requeueDueFailures() {
  const database = await getDatabase();
  const timestamp = nowIso();
  const currentTime = Date.now();
  let changes = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const chunkResult = await transaction.runAsync(
      `UPDATE chunks
       SET state = 'pending', updated_at = ?
       WHERE state = 'failed' AND next_attempt_at <= ?`,
      timestamp,
      currentTime,
    );
    const captureResult = await transaction.runAsync(
      `UPDATE captures
       SET status = 'pending', updated_at = ?
       WHERE status = 'failed' AND next_attempt_at <= ?`,
      timestamp,
      currentTime,
    );
    changes = chunkResult.changes + captureResult.changes;
  });
  if (changes > 0) {
    notifyQueueChanged();
  }
}

export async function nextActionableCapture() {
  const database = await getDatabase();
  return database.getFirstAsync<LocalCapture>(
    `SELECT captures.* FROM captures
     WHERE captures.status <> 'done'
       AND NOT (captures.status = 'failed' AND captures.next_attempt_at > ?)
       AND (
         captures.server_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM chunks
           WHERE chunks.capture_id = captures.id AND chunks.state <> 'done'
         )
         OR EXISTS (
           SELECT 1 FROM chunks
           WHERE chunks.capture_id = captures.id
             AND chunks.state IN ('pending', 'uploading')
         )
       )
     ORDER BY captures.created_at
     LIMIT 1`,
    Date.now(),
  );
}

export async function nextUploadableChunk(captureId: string) {
  const database = await getDatabase();
  return database.getFirstAsync<LocalChunk>(
    `SELECT * FROM chunks
     WHERE capture_id = ? AND state IN ('uploading', 'pending')
     ORDER BY CASE state WHEN 'uploading' THEN 0 ELSE 1 END, part_number
     LIMIT 1`,
    captureId,
  );
}

export async function markChunkUploading(chunk: LocalChunk) {
  const database = await getDatabase();
  const timestamp = nowIso();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE chunks
       SET state = 'uploading', next_attempt_at = 0, updated_at = ?
       WHERE id = ? AND state <> 'done'`,
      timestamp,
      chunk.id,
    );
    await transaction.runAsync(
      `UPDATE captures SET status = 'uploading', updated_at = ?
       WHERE id = ? AND status <> 'done'`,
      timestamp,
      chunk.capture_id,
    );
  });
  notifyQueueChanged();
}

export async function storeChunkEtag(chunkId: number, etag: string) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE chunks SET etag = ?, updated_at = ? WHERE id = ? AND state <> 'done'`,
    etag,
    nowIso(),
    chunkId,
  );
  notifyQueueChanged();
}

export async function markChunkDone(chunk: LocalChunk, etag: string) {
  const database = await getDatabase();
  const timestamp = nowIso();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE chunks
       SET etag = ?, state = 'done', last_error = NULL, presigned_url = NULL,
           next_attempt_at = 0, updated_at = ?
       WHERE id = ?`,
      etag,
      timestamp,
      chunk.id,
    );
    await transaction.runAsync(
      `UPDATE captures SET status = 'pending', last_error = NULL, updated_at = ?
       WHERE id = ? AND status <> 'done'`,
      timestamp,
      chunk.capture_id,
    );
  });
  notifyQueueChanged();
}

export async function failChunk(chunk: LocalChunk, error: string, retryAt: number) {
  const database = await getDatabase();
  const timestamp = nowIso();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE chunks
       SET state = 'failed', attempts = attempts + 1, last_error = ?,
           presigned_url = NULL, next_attempt_at = ?, updated_at = ?
       WHERE id = ? AND state <> 'done'`,
      error,
      retryAt,
      timestamp,
      chunk.id,
    );
    await transaction.runAsync(
      `UPDATE captures SET status = 'pending', last_error = ?, updated_at = ?
       WHERE id = ? AND status <> 'done'`,
      error,
      timestamp,
      chunk.capture_id,
    );
  });
  notifyQueueChanged();
}

export async function markCaptureCompleting(captureId: string) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE captures
     SET status = 'completing', last_error = NULL, updated_at = ?
     WHERE id = ? AND status <> 'done'`,
    nowIso(),
    captureId,
  );
  notifyQueueChanged();
}

export async function markCaptureDone(captureId: string) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE captures
     SET status = 'done', attempts = 0, last_error = NULL,
         next_attempt_at = 0, updated_at = ?
     WHERE id = ?`,
    nowIso(),
    captureId,
  );
  notifyQueueChanged();
}

export async function getRetryDelayMillis() {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ retry_at: number | null }>(
    `SELECT MIN(retry_at) AS retry_at FROM (
       SELECT next_attempt_at AS retry_at FROM chunks WHERE state = 'failed'
       UNION ALL
       SELECT next_attempt_at AS retry_at FROM captures WHERE status = 'failed'
     )`,
  );
  if (result?.retry_at == null) {
    return 30_000;
  }
  return Math.max(100, Math.min(30_000, result.retry_at - Date.now()));
}

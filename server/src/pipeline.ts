import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "./db.js";
import { HttpError } from "./http-error.js";
import { structureTranscript, transcribeAudio } from "./ai.js";
import { downloadObject } from "./storage.js";

export type PipelineStatus = "uploaded" | "transcribing" | "structuring" | "ready" | "failed";

type CapturePipelineRow = {
  id: string;
  machine_id: string;
  pipeline_error: string | null;
  pipeline_status: PipelineStatus | null;
  pipeline_updated_at: Date | null;
  s3_key: string;
  status: string;
};

type TranscriptRow = { id: string; text: string };

const queuedCaptureIds: string[] = [];
const scheduledCaptures = new Set<string>();
let activeCaptureId: string | null = null;
let pumping = false;
const ffmpegStaticPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

async function setPipelineStatus(
  captureId: string,
  status: PipelineStatus,
  error: string | null = null,
): Promise<void> {
  await db.query(
    `UPDATE captures
     SET pipeline_status = $2, pipeline_error = $3, pipeline_updated_at = NOW()
     WHERE id = $1`,
    [captureId, status, error],
  );
}

async function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  const executable = process.env.FFMPEG_PATH?.trim() || ffmpegStaticPath;
  if (!executable) {
    throw new Error("No ffmpeg executable is available.");
  }
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    "-f",
    "mp3",
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("ffmpeg timed out after 120 seconds."));
      }
    }, 120_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error(`Could not start ffmpeg: ${error.message}`));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || "no details"}`));
      }
    });
  });

  const output = await stat(outputPath);
  if (output.size === 0) {
    throw new Error("ffmpeg produced an empty audio file.");
  }
}

async function findTranscript(captureId: string): Promise<TranscriptRow | null> {
  const result = await db.query<TranscriptRow>(
    "SELECT id, text FROM transcripts WHERE capture_id = $1",
    [captureId],
  );
  return result.rows[0] ?? null;
}

async function runCapturePipeline(captureId: string): Promise<void> {
  const captureResult = await db.query<CapturePipelineRow>(
    `SELECT id, machine_id, pipeline_error, pipeline_status, pipeline_updated_at, s3_key, status
     FROM captures
     WHERE id = $1`,
    [captureId],
  );
  const capture = captureResult.rows[0];
  if (!capture) {
    throw new HttpError(404, "Capture not found.");
  }
  if (capture.status !== "uploaded") {
    throw new HttpError(409, "Capture must be uploaded before processing can start.");
  }

  const existingProcedure = await db.query<{ id: string }>(
    "SELECT id FROM procedures WHERE capture_id = $1",
    [captureId],
  );
  if (existingProcedure.rows[0]) {
    await setPipelineStatus(captureId, "ready");
    return;
  }

  let transcript = await findTranscript(captureId);
  if (!transcript) {
    await setPipelineStatus(captureId, "transcribing");
    const workDirectory = await mkdtemp(join(tmpdir(), `smartoperator-${captureId}-`));
    const capturePath = join(workDirectory, "capture.bin");
    const audioPath = join(workDirectory, "audio.mp3");

    try {
      await downloadObject(capture.s3_key, capturePath);
      await runFfmpeg(capturePath, audioPath);
      const text = await transcribeAudio(audioPath);
      await db.query(
        `INSERT INTO transcripts (capture_id, text)
         VALUES ($1, $2)
         ON CONFLICT (capture_id) DO NOTHING`,
        [captureId, text],
      );
      transcript = await findTranscript(captureId);
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  if (!transcript) {
    throw new Error("Transcript was not available after transcription.");
  }

  await setPipelineStatus(captureId, "structuring");
  const draft = await structureTranscript(transcript.text, capture.machine_id);
  await db.query(
    `INSERT INTO procedures
       (capture_id, title, steps_json, tools_json, safety_json, source, approved)
     VALUES ($1, $2, $3::JSONB, $4::JSONB, $5::JSONB, 'capture', FALSE)
     ON CONFLICT (capture_id) DO NOTHING`,
    [
      captureId,
      draft.title,
      JSON.stringify(draft.steps),
      JSON.stringify(draft.tools),
      JSON.stringify(draft.safety),
    ],
  );
  await setPipelineStatus(captureId, "ready");
}

export function triggerCapturePipeline(
  captureId: string,
  priority: "high" | "normal" = "high",
): { started: boolean } {
  if (scheduledCaptures.has(captureId)) {
    return { started: false };
  }

  scheduledCaptures.add(captureId);
  if (priority === "high") {
    queuedCaptureIds.unshift(captureId);
  } else {
    queuedCaptureIds.push(captureId);
  }
  void pumpPipelineQueue();
  return { started: true };
}

async function pumpPipelineQueue(): Promise<void> {
  if (pumping) {
    return;
  }
  pumping = true;

  try {
    while (queuedCaptureIds.length > 0) {
      const captureId = queuedCaptureIds.shift();
      if (!captureId) {
        continue;
      }
      activeCaptureId = captureId;
      try {
        await runCapturePipeline(captureId);
      } catch (error) {
        console.error(`Capture ${captureId} pipeline failed:`, error);
        await setPipelineStatus(captureId, "failed", errorMessage(error)).catch((statusError) => {
          console.error(`Could not persist capture ${captureId} pipeline failure:`, statusError);
        });
      } finally {
        activeCaptureId = null;
        scheduledCaptures.delete(captureId);
      }
    }
  } finally {
    pumping = false;
    if (queuedCaptureIds.length > 0) {
      void pumpPipelineQueue();
    }
  }
}

export async function getPipelineStatus(captureId: string) {
  const result = await db.query<
    CapturePipelineRow & { procedure_id: string | null }
  >(
    `SELECT capture.id,
            capture.machine_id,
            capture.pipeline_error,
            capture.pipeline_status,
            capture.pipeline_updated_at,
            capture.s3_key,
            capture.status,
            procedure.id AS procedure_id
     FROM captures AS capture
     LEFT JOIN procedures AS procedure ON procedure.capture_id = capture.id
     WHERE capture.id = $1`,
    [captureId],
  );
  const capture = result.rows[0];
  if (!capture) {
    throw new HttpError(404, "Capture not found.");
  }
  if (capture.status !== "uploaded") {
    throw new HttpError(409, "Capture has not finished uploading.");
  }

  return {
    captureId: capture.id,
    status: capture.pipeline_status ?? "uploaded",
    error: capture.pipeline_error,
    updatedAt: capture.pipeline_updated_at?.toISOString() ?? null,
    procedureId: capture.procedure_id,
  };
}

export async function retryCapturePipeline(captureId: string) {
  const current = await getPipelineStatus(captureId);
  if (current.status === "ready") {
    return { ...current, started: false, alreadyReady: true };
  }

  if (scheduledCaptures.has(captureId) || activeCaptureId === captureId) {
    return { ...current, started: false, alreadyReady: false };
  }

  if (current.status !== "failed") {
    throw new HttpError(409, "Only a failed pipeline can be re-triggered.");
  }

  await setPipelineStatus(captureId, "uploaded");
  const { started } = triggerCapturePipeline(captureId);
  return { ...(await getPipelineStatus(captureId)), started, alreadyReady: false };
}

export async function resumeInterruptedPipelines(): Promise<void> {
  await db.query(
    `UPDATE captures AS capture
     SET pipeline_status = 'ready', pipeline_error = NULL, pipeline_updated_at = NOW()
     WHERE capture.status = 'uploaded'
       AND capture.pipeline_status IS DISTINCT FROM 'ready'
       AND EXISTS (
         SELECT 1 FROM procedures AS procedure WHERE procedure.capture_id = capture.id
       )`,
  );
  const interrupted = await db.query<{ id: string }>(
    `UPDATE captures
     SET pipeline_status = 'uploaded',
         pipeline_error = CASE
           WHEN pipeline_status IN ('transcribing', 'structuring')
             THEN 'Server restarted during processing; resumed automatically.'
           ELSE pipeline_error
         END,
         pipeline_updated_at = NOW()
     WHERE status = 'uploaded'
       AND pipeline_status IN ('transcribing', 'structuring')
       AND NOT EXISTS (
         SELECT 1 FROM procedures AS procedure WHERE procedure.capture_id = captures.id
       )
     RETURNING id`,
  );
  const waiting = await db.query<{ id: string }>(
    `SELECT capture.id
     FROM captures AS capture
     LEFT JOIN procedures AS procedure ON procedure.capture_id = capture.id
     WHERE capture.status = 'uploaded'
       AND procedure.id IS NULL
       AND capture.pipeline_status = 'uploaded'`,
  );

  const captureIds = new Set([
    ...interrupted.rows.map((row) => row.id),
    ...waiting.rows.map((row) => row.id),
  ]);
  captureIds.forEach((captureId) => triggerCapturePipeline(captureId, "normal"));
}

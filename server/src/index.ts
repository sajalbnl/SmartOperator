import "dotenv/config";
import express from "express";
import { db } from "./db.js";
import { HttpError } from "./http-error.js";
import {
  getPipelineStatus,
  resumeInterruptedPipelines,
  retryCapturePipeline,
  triggerCapturePipeline,
} from "./pipeline.js";
import { approveProcedure, listProcedures, rejectProcedure } from "./procedures.js";
import type { ReviewStatus } from "./review-state.js";
import {
  finishCapture,
  initializeCapture,
  markPartComplete,
  resumeCapture,
} from "./uploads.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new HttpError(400, `${field} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value as number;
}

function positivePathInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, `${field} must be a positive integer.`);
  }
  return integer(Number(value), field, 1);
}

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.post("/captures", async (request, response) => {
  const body = request.body as Record<string, unknown> | undefined;
  const idempotencyKeyValue = request.get("Idempotency-Key")?.trim();

  if (idempotencyKeyValue && idempotencyKeyValue.length > 200) {
    throw new HttpError(400, "Idempotency-Key must be at most 200 characters.");
  }

  const result = await initializeCapture(
    {
      machineId: requiredString(body?.machine_id, "machine_id"),
      operatorId: requiredString(body?.operator_id, "operator_id"),
      durationSeconds: integer(body?.duration_s, "duration_s", 0),
      totalBytes: integer(body?.total_bytes, "total_bytes", 1),
    },
    idempotencyKeyValue || null,
  );
  response.status(201).json(result);
});

app.post("/captures/:id/parts/:partNumber/complete", async (request, response) => {
  const body = request.body as Record<string, unknown> | undefined;
  const etag = requiredString(body?.etag, "etag");

  if (etag.length > 256) {
    throw new HttpError(400, "etag must be at most 256 characters.");
  }

  response.status(200).json(
    await markPartComplete(
      positivePathInteger(request.params.id, "capture id").toString(),
      positivePathInteger(request.params.partNumber, "part number"),
      etag,
    ),
  );
});

app.post("/captures/:id/complete", async (request, response) => {
  const captureId = positivePathInteger(request.params.id, "capture id").toString();
  const result = await finishCapture(captureId);
  triggerCapturePipeline(captureId);
  response.status(200).json(result);
});

app.get("/captures/:id/resume", async (request, response) => {
  response.status(200).json(
    await resumeCapture(
      positivePathInteger(request.params.id, "capture id").toString(),
    ),
  );
});

app.get("/captures/:id/pipeline", async (request, response) => {
  response.status(200).json(
    await getPipelineStatus(
      positivePathInteger(request.params.id, "capture id").toString(),
    ),
  );
});

app.post("/captures/:id/pipeline/retry", async (request, response) => {
  response.status(202).json(
    await retryCapturePipeline(
      positivePathInteger(request.params.id, "capture id").toString(),
    ),
  );
});

app.get("/procedures", async (request, response) => {
  const approvedValue = request.query.approved;
  const reviewStatusValue = request.query.review_status;
  if (approvedValue !== undefined && reviewStatusValue !== undefined) {
    throw new HttpError(400, "Use either approved or review_status, not both.");
  }
  let approved: boolean | null = null;
  if (approvedValue !== undefined) {
    if (approvedValue !== "true" && approvedValue !== "false") {
      throw new HttpError(400, "approved must be true or false.");
    }
    approved = approvedValue === "true";
  }
  let reviewStatus: ReviewStatus | null = null;
  if (reviewStatusValue !== undefined) {
    if (
      reviewStatusValue !== "pending" &&
      reviewStatusValue !== "approved" &&
      reviewStatusValue !== "rejected"
    ) {
      throw new HttpError(400, "review_status must be pending, approved, or rejected.");
    }
    reviewStatus = reviewStatusValue;
  }
  response.status(200).json(await listProcedures(reviewStatus, approved));
});

app.post("/procedures/:id/approve", async (request, response) => {
  response.status(200).json(
    await approveProcedure(
      positivePathInteger(request.params.id, "procedure id").toString(),
    ),
  );
});

app.post("/procedures/:id/reject", async (request, response) => {
  response.status(200).json(
    await rejectProcedure(
      positivePathInteger(request.params.id, "procedure id").toString(),
    ),
  );
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }

    console.error(error);
    response.status(500).json({ error: "Internal server error." });
  },
);

const server = app.listen(port, () => {
  console.log(`SmartOperator server listening on port ${port}`);
  void resumeInterruptedPipelines().catch((error) => {
    console.error("Could not resume interrupted capture pipelines:", error);
  });
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

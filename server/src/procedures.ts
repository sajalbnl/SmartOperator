import { db } from "./db.js";
import { HttpError } from "./http-error.js";
import { reviewStatus, type ReviewStatus } from "./review-state.js";

type ProcedureRow = {
  approved: boolean;
  capture_id: string;
  created_at: Date;
  id: string;
  machine_id: string;
  rejected_at: Date | null;
  safety_json: unknown;
  source: string;
  steps_json: unknown;
  title: string;
  tools_json: unknown;
  transcript: string;
};

function jsonStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Stored ${field} is not a string array.`);
  }
  return value as string[];
}

function serializeProcedure(row: ProcedureRow) {
  return {
    id: row.id,
    captureId: row.capture_id,
    machineId: row.machine_id,
    title: row.title,
    steps: jsonStringArray(row.steps_json, "steps_json"),
    tools: jsonStringArray(row.tools_json, "tools_json"),
    safety: jsonStringArray(row.safety_json, "safety_json"),
    source: row.source,
    approved: row.approved,
    rejectedAt: row.rejected_at?.toISOString() ?? null,
    reviewStatus: reviewStatus(row.approved, row.rejected_at),
    transcript: row.transcript,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listProcedures(reviewStatusFilter: ReviewStatus | null, approved: boolean | null) {
  const result = await db.query<ProcedureRow>(
    `SELECT procedure.id,
            procedure.capture_id,
            procedure.title,
            procedure.steps_json,
            procedure.tools_json,
            procedure.safety_json,
            procedure.source,
            procedure.approved,
            procedure.rejected_at,
            procedure.created_at,
            capture.machine_id,
            transcript.text AS transcript
     FROM procedures AS procedure
     JOIN captures AS capture ON capture.id = procedure.capture_id
     JOIN transcripts AS transcript ON transcript.capture_id = procedure.capture_id
     WHERE ($1::BOOLEAN IS NULL OR procedure.approved = $1)
       AND (
         $2::TEXT IS NULL OR
         ($2 = 'pending' AND procedure.approved = FALSE AND procedure.rejected_at IS NULL) OR
         ($2 = 'approved' AND procedure.approved = TRUE AND procedure.rejected_at IS NULL) OR
         ($2 = 'rejected' AND procedure.approved = FALSE AND procedure.rejected_at IS NOT NULL)
       )
     ORDER BY procedure.created_at DESC`,
    [approved, reviewStatusFilter],
  );
  return { procedures: result.rows.map(serializeProcedure) };
}

async function findProcedure(procedureId: string): Promise<ProcedureRow | null> {
  const result = await db.query<ProcedureRow>(
    `SELECT procedure.id,
            procedure.capture_id,
            procedure.title,
            procedure.steps_json,
            procedure.tools_json,
            procedure.safety_json,
            procedure.source,
            procedure.approved,
            procedure.rejected_at,
            procedure.created_at,
            capture.machine_id,
            transcript.text AS transcript
     FROM procedures AS procedure
     JOIN captures AS capture ON capture.id = procedure.capture_id
     JOIN transcripts AS transcript ON transcript.capture_id = procedure.capture_id
     WHERE procedure.id = $1`,
    [procedureId],
  );
  return result.rows[0] ?? null;
}

async function requireProcedure(procedureId: string): Promise<ProcedureRow> {
  const procedure = await findProcedure(procedureId);
  if (!procedure) {
    throw new HttpError(404, "Procedure not found.");
  }
  return procedure;
}

export async function approveProcedure(procedureId: string) {
  const result = await db.query<{ id: string }>(
    `UPDATE procedures
     SET approved = TRUE
     WHERE id = $1 AND rejected_at IS NULL
     RETURNING id`,
    [procedureId],
  );
  if (!result.rows[0]) {
    const procedure = await requireProcedure(procedureId);
    if (procedure.rejected_at) {
      throw new HttpError(409, "Rejected procedures cannot be approved.");
    }
  }
  const procedure = await requireProcedure(procedureId);
  return { procedure: serializeProcedure(procedure) };
}

export async function rejectProcedure(procedureId: string) {
  const result = await db.query<{ id: string }>(
    `UPDATE procedures
     SET rejected_at = COALESCE(rejected_at, NOW())
     WHERE id = $1 AND approved = FALSE
     RETURNING id`,
    [procedureId],
  );
  if (!result.rows[0]) {
    const procedure = await requireProcedure(procedureId);
    if (procedure.approved) {
      throw new HttpError(409, "Approved procedures cannot be rejected.");
    }
  }
  const procedure = await requireProcedure(procedureId);
  return { procedure: serializeProcedure(procedure) };
}

import { db } from "./db.js";
import {
  rankDocuments,
  type RetrievalCandidate,
  type RetrievedDocument,
} from "./retrieval-ranking.js";

export type { RetrievedDocument } from "./retrieval-ranking.js";

type SopRow = {
  body: string;
  code: string;
  title: string;
};

type ProcedureRow = {
  capture_id: string;
  created_at: Date;
  steps_json: unknown;
  title: string;
};

function procedureSteps(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((step) => typeof step !== "string")) {
    throw new Error("Stored procedure steps_json is not a string array.");
  }
  return value as string[];
}

export async function retrieveDocuments(
  question: string,
  machineId: string,
): Promise<RetrievedDocument[]> {
  // Deliberate prototype choice: at roughly 20 documents, loading one machine's
  // tiny corpus and applying explainable keyword scoring is simpler and more
  // reliable than embeddings/pgvector. The top handful are stuffed into Claude.
  const [sopsResult, proceduresResult] = await Promise.all([
    db.query<SopRow>(
      `SELECT code, title, body
       FROM sops
       WHERE machine_id = $1`,
      [machineId],
    ),
    db.query<ProcedureRow>(
      `SELECT procedure.capture_id,
              procedure.title,
              procedure.steps_json,
              procedure.created_at
       FROM procedures AS procedure
       JOIN captures AS capture ON capture.id = procedure.capture_id
       WHERE capture.machine_id = $1
         AND procedure.approved = TRUE
         AND procedure.rejected_at IS NULL`,
      [machineId],
    ),
  ]);

  const candidates: RetrievalCandidate[] = [
    ...sopsResult.rows.map((row) => ({
      content: row.body,
      createdAt: null,
      id: row.code,
      label: row.title,
      title: row.title,
      type: "sop" as const,
    })),
    ...proceduresResult.rows.map((row) => ({
      content: procedureSteps(row.steps_json).join("\n"),
      createdAt: row.created_at,
      id: `CAP-${row.capture_id}`,
      label: row.title,
      title: row.title,
      type: "capture" as const,
    })),
  ];

  return rankDocuments(question, machineId, candidates);
}

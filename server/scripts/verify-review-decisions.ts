import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../src/db.js";
import { responseError } from "./env.js";

const apiBaseUrl = (
  process.env.API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`
).replace(/\/$/, "");
const captureIds: string[] = [];

type Procedure = {
  approved: boolean;
  captureId: string;
  id: string;
  rejectedAt: string | null;
  reviewStatus: "pending" | "approved" | "rejected";
};

async function request<T>(path: string, method = "GET"): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { method });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${await responseError(response)}`);
  }
  return (await response.json()) as T;
}

async function expectConflict(path: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}${path}`, { method: "POST" });
  if (response.status !== 409) {
    throw new Error(`Expected POST ${path} to return 409; received ${response.status}.`);
  }
}

async function createDraft(label: string): Promise<Procedure> {
  const capture = await db.query<{ id: string }>(
    `INSERT INTO captures
       (machine_id, operator_id, status, duration_s, total_bytes, s3_key, pipeline_status)
     VALUES ('CNC-042', 'review-test', 'uploaded', 1, 1, $1, 'ready')
     RETURNING id`,
    [`captures/review-test-${randomUUID()}.mp4`],
  );
  const captureId = capture.rows[0]?.id;
  if (!captureId) {
    throw new Error("Could not create review-test capture.");
  }
  captureIds.push(captureId);

  await db.query(
    `INSERT INTO transcripts (capture_id, text)
     VALUES ($1, $2)`,
    [captureId, `Review decision test transcript: ${label}`],
  );
  const procedure = await db.query<{ id: string }>(
    `INSERT INTO procedures
       (capture_id, title, steps_json, tools_json, safety_json, source, approved)
     VALUES ($1, $2, '["Inspect the draft"]'::JSONB, '[]'::JSONB, '[]'::JSONB, 'capture', FALSE)
     RETURNING id`,
    [captureId, `Review decision test: ${label}`],
  );
  const procedureId = procedure.rows[0]?.id;
  if (!procedureId) {
    throw new Error("Could not create review-test procedure.");
  }

  const pending = await request<{ procedures: Procedure[] }>("/procedures?review_status=pending");
  const draft = pending.procedures.find((item) => item.id === procedureId);
  if (!draft || draft.reviewStatus !== "pending" || draft.rejectedAt !== null) {
    throw new Error(`New draft was not listed as pending: ${JSON.stringify(draft)}`);
  }
  return draft;
}

try {
  const approvalDraft = await createDraft("approve");
  const firstApproval = await request<{ procedure: Procedure }>(
    `/procedures/${approvalDraft.id}/approve`,
    "POST",
  );
  const secondApproval = await request<{ procedure: Procedure }>(
    `/procedures/${approvalDraft.id}/approve`,
    "POST",
  );
  if (
    firstApproval.procedure.reviewStatus !== "approved" ||
    secondApproval.procedure.reviewStatus !== "approved" ||
    !secondApproval.procedure.approved
  ) {
    throw new Error("Repeated approval did not remain approved.");
  }
  await expectConflict(`/procedures/${approvalDraft.id}/reject`);

  const rejectionDraft = await createDraft("reject");
  const firstRejection = await request<{ procedure: Procedure }>(
    `/procedures/${rejectionDraft.id}/reject`,
    "POST",
  );
  const secondRejection = await request<{ procedure: Procedure }>(
    `/procedures/${rejectionDraft.id}/reject`,
    "POST",
  );
  if (
    firstRejection.procedure.reviewStatus !== "rejected" ||
    secondRejection.procedure.reviewStatus !== "rejected" ||
    secondRejection.procedure.approved ||
    !secondRejection.procedure.rejectedAt ||
    firstRejection.procedure.rejectedAt !== secondRejection.procedure.rejectedAt
  ) {
    throw new Error("Repeated rejection did not preserve one rejection decision.");
  }
  await expectConflict(`/procedures/${rejectionDraft.id}/approve`);

  let constraintRejectedInvalidState = false;
  try {
    await db.query(
      "UPDATE procedures SET approved = TRUE WHERE id = $1",
      [rejectionDraft.id],
    );
  } catch (error) {
    constraintRejectedInvalidState =
      typeof error === "object" && error !== null && "code" in error && error.code === "23514";
  }
  if (!constraintRejectedInvalidState) {
    throw new Error("Database constraint allowed a procedure to be approved and rejected.");
  }

  const pending = await request<{ procedures: Procedure[] }>("/procedures?review_status=pending");
  if (pending.procedures.some((item) => item.id === approvalDraft.id || item.id === rejectionDraft.id)) {
    throw new Error("A reviewed procedure remained in the pending list.");
  }

  const approved = await request<{ procedures: Procedure[] }>("/procedures?review_status=approved");
  const rejected = await request<{ procedures: Procedure[] }>("/procedures?review_status=rejected");
  if (!approved.procedures.some((item) => item.id === approvalDraft.id)) {
    throw new Error("Approved filter did not return the approved test procedure.");
  }
  if (!rejected.procedures.some((item) => item.id === rejectionDraft.id)) {
    throw new Error("Rejected filter did not return the rejected test procedure.");
  }

  console.log(
    "Review decisions verified: idempotent approve/reject, 409 conflicts, DB constraint, filtered lists.",
  );
} finally {
  if (captureIds.length > 0) {
    await db.query("DELETE FROM captures WHERE id = ANY($1::BIGINT[])", [captureIds]);
  }
  await db.end();
}

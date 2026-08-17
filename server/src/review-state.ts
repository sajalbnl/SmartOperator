export type ReviewStatus = "pending" | "approved" | "rejected";

export function reviewStatus(approved: boolean, rejectedAt: Date | null): ReviewStatus {
  if (approved) {
    return "approved";
  }
  return rejectedAt ? "rejected" : "pending";
}

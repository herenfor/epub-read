/** Shared by the probe UI and the existing governor. Unknown is never zero. */
export type BudgetAssessment =
  | { status: "fits"; availableBytes: number }
  | { status: "unknown" | "invalid" | "insufficient"; availableBytes: number | null };

export function assessMemoryBudget(budgetBytes: number | null, usageBytes: number | null, requestedBytes: number): BudgetAssessment {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) return { status: "invalid", availableBytes: null };
  if (budgetBytes === null || usageBytes === null) return { status: "unknown", availableBytes: null };
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0 || !Number.isSafeInteger(usageBytes) || usageBytes < 0) {
    return { status: "invalid", availableBytes: null };
  }
  const availableBytes = Math.max(0, budgetBytes - usageBytes);
  return { status: requestedBytes <= availableBytes ? "fits" : "insufficient", availableBytes };
}

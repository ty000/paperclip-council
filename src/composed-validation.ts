/** Guidance uses the existing mandate and plan; it grants no new product scope. */
export function composedValidationGuidance(role: "planner" | "integration" | "review") {
  const action = role === "planner"
    ? "In the existing native plan, assign the lead the shared interfaces and wiring between contributions, their owned paths, and a composed acceptance check."
    : role === "integration"
      ? "Verify the planned interfaces and wiring between contributions on the final candidate, then run the composed acceptance check."
      : "Check the exact candidate's shared interfaces and wiring against the native plan and require the composed acceptance evidence before approval.";
  return `${action} Select at least one user-observable criterion already delegated by the mandate. Trace its actual delivered entry (HTTP, action, UI, command or scheduled trigger as applicable), services and execution mechanism; doubles belong only at necessary external boundaries. Verify a representative business refusal is visible at that same user-facing boundary when the delegated behavior includes one. Direct service tests or bypassed workflow steps alone cannot prove missing wiring. Record the exact entry, criterion, candidate and evidence, or the precise missing proof; do not invent a UI, expand product scope or silently waive a mandate criterion. Distinguish product behavior evidence from Council transport qualification and draft-pr/reviewed-pr/integrated-verified delivery proof.`;
}

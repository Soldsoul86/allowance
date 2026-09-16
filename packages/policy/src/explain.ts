/**
 * Turning a decision into something a person can read.
 *
 * Kept separate from the engine on purpose. `evaluate` produces a record;
 * rendering that record is presentation, and presentation must never be able
 * to change what was decided. The rendering is also lossless — every
 * evaluation the engine performed appears, including the ones that passed,
 * because "how close did the others come" is the question an operator asks
 * first when a payment is refused.
 */
import type { Decision, RuleEvaluation } from "./evaluate.js";

const MARK: Record<RuleEvaluation["verdict"], string> = {
  ALLOW: "ok  ",
  DENY: "DENY",
  REQUIRES_APPROVAL: "hold",
  NOT_APPLICABLE: "  - ",
};

function renderEvaluation(evaluation: RuleEvaluation): string {
  const measured =
    evaluation.observed === null
      ? ""
      : evaluation.limit === null
        ? `  [${evaluation.observed}]`
        : `  [${evaluation.observed} of ${evaluation.limit}]`;
  return `  ${MARK[evaluation.verdict]}  ${evaluation.ruleId} (${evaluation.kind})${measured}\n` +
    `        ${evaluation.detail}`;
}

/** A multi-line, human-readable account of a decision. */
export function explain(decision: Decision): string {
  const header =
    decision.outcome === "ALLOW"
      ? `ALLOW  ${decision.requestId}`
      : decision.outcome === "DENY"
        ? `DENY  ${decision.requestId}  (${decision.reason})\n  ${decision.detail}`
        : `REQUIRES APPROVAL  ${decision.requestId}\n  ${decision.detail}`;

  const provenance =
    `  policy v${decision.policyVersion} ${decision.policyDigest.slice(0, 12)}` +
    `  account ${decision.account}  at ${new Date(decision.evaluatedAt).toISOString()}`;

  const body =
    decision.evaluations.length === 0
      ? "  (no rules evaluated)"
      : decision.evaluations.map(renderEvaluation).join("\n");

  return `${header}\n${provenance}\n${body}`;
}

/** One line, for a log. */
export function summarize(decision: Decision): string {
  switch (decision.outcome) {
    case "ALLOW":
      return `ALLOW ${decision.requestId} policy=v${decision.policyVersion}`;
    case "DENY":
      return `DENY ${decision.requestId} reason=${decision.reason} rule=${decision.ruleId ?? "-"}`;
    case "REQUIRES_APPROVAL":
      return (
        `HOLD ${decision.requestId} rule=${decision.ruleId} ` +
        `approvals=${decision.approvalsHeld}/${decision.approvalsRequired}`
      );
  }
}

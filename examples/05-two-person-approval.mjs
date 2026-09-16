import { makeGuard, draft, spend, title, agent, ANY, T0 } from "./lib.mjs";
title(5, "USDC payments of 1,000 or more need two distinct approvers; the requester cannot self-approve twice");
const USDC = (n) => BigInt(n) * 1_000_000n; // 6 decimals
const policy = { account: "treasury", version: 1, rules: [
  { id: "two-eyes", kind: "APPROVAL_THRESHOLD", scope: ANY, asset: "usdc", atOrAboveAmount: USDC(1000), approvalsRequired: 2 },
]};
const { guard } = makeGuard(policy);
await spend(guard, "999.999999 USDC, no approvals", draft("treasury", agent("payroll"), "usdc", USDC(1000) - 1n));
await spend(guard, "1,000 USDC, no approvals", draft("treasury", agent("payroll"), "usdc", USDC(1000)));
await spend(guard, "1,000 USDC, one approver", draft("treasury", agent("payroll"), "usdc", USDC(1000), "vendor:x", { approvals: [{ approver: "cfo", at: T0 }] }));
await spend(guard, "1,000 USDC, same approver signed twice", draft("treasury", agent("payroll"), "usdc", USDC(1000), "vendor:x", { approvals: [{ approver: "cfo", at: T0 }, { approver: "cfo", at: T0 + 1 }] }));
await spend(guard, "1,000 USDC, cfo + coo", draft("treasury", agent("payroll"), "usdc", USDC(1000), "vendor:x", { approvals: [{ approver: "cfo", at: T0 }, { approver: "coo", at: T0 }] }));

/**
 * Fixtures for the policy tests.
 *
 * Every value here is fixed, including the instant `T0`: a test that reads the
 * wall clock is a test that can fail on a different day, and this engine's
 * whole claim is that it does not depend on when it runs.
 */
import type { LedgerEntry, Requester, Rule, SpendPolicy, SpendRequest } from "../src/index.js";
import { ANY_REQUESTER } from "../src/index.js";

/** 2026-03-10T12:00:00.000Z — a fixed instant, so nothing depends on when tests run. */
export const T0 = Date.UTC(2026, 2, 10, 12, 0, 0);

export const USDC = "USDC";
/** USDC has six decimals; 1 USDC is 1_000_000 base units. */
export const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n;

export const ACCOUNT = "acct:treasury";
export const AGENT: Requester = { kind: "AGENT", agentId: "researcher" };
export const OWNER: Requester = { kind: "OWNER" };

export function policy(rules: readonly Rule[], version = 1): SpendPolicy {
  return { account: ACCOUNT, version, rules };
}

export function request(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    requestId: "req-1",
    account: ACCOUNT,
    requester: OWNER,
    asset: USDC,
    amount: usdc(10),
    destination: "addr:vendor-a",
    requestedAt: T0,
    approvals: [],
    attestations: [],
    memo: null,
    ...overrides,
  };
}

export function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    requestId: "prior-1",
    account: ACCOUNT,
    asset: USDC,
    amount: usdc(10),
    destination: "addr:vendor-a",
    requester: OWNER,
    at: T0 - 60_000,
    state: "SETTLED",
    intent: "",
    decision: null,
    expiresAt: null,
    ...overrides,
  };
}

export const anywhere = ANY_REQUESTER;

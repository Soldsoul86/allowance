import { makeGuard, draft, spend, title, agent, ANY, T0, DAY } from "./lib.mjs";
title(7, "Release payment only when a named logistics party attests goods were received, within 7 days");
const policy = { account: "buyer", version: 1, rules: [
  { id: "delivered", kind: "ATTESTATION_REQUIRED", scope: ANY, claimId: "goods.received", attesters: ["carrier:dhl", "carrier:fedex"], maxAgeMs: 7 * DAY },
]};
const { guard } = makeGuard(policy);
const att = (attester, assertedAt) => ({ claimId: "goods.received", attester, assertedAt, evidenceDigest: "sha256:abc" });
await spend(guard, "no attestation", draft("buyer", agent("ap"), "usd:cents", 50_000n, "supplier:acme"));
await spend(guard, "attested by the supplier itself (not a permitted attester)", draft("buyer", agent("ap"), "usd:cents", 50_000n, "supplier:acme", { attestations: [att("supplier:acme", T0 - DAY)] }));
await spend(guard, "attested by DHL 10 days ago (stale)", draft("buyer", agent("ap"), "usd:cents", 50_000n, "supplier:acme", { attestations: [att("carrier:dhl", T0 - 10 * DAY)] }));
await spend(guard, "attested by DHL dated tomorrow (clock problem or forgery)", draft("buyer", agent("ap"), "usd:cents", 50_000n, "supplier:acme", { attestations: [att("carrier:dhl", T0 + DAY)] }));
await spend(guard, "attested by DHL yesterday", draft("buyer", agent("ap"), "usd:cents", 50_000n, "supplier:acme", { attestations: [att("carrier:dhl", T0 - DAY)] }));

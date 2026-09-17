import { randomUUID } from "node:crypto";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { guardX402 } from "@spendcap/x402";
import { makeGuard, title, agent, ANY, DAY } from "./lib.mjs";
title(12, "x402: a retry after a lost response pays once, not twice (x402-foundation/x402#3438)");

// A paid resource and the facilitator behind it, as one fake `fetch`. No
// chain, no keys: the scheme signs with a fresh nonce like a real one, and
// the facilitator settles each nonce once, like a real one.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const terms = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: "0xSeller", maxTimeoutSeconds: 60, extra: {} };
const makeServer = () => {
  const settled = new Map();
  let dropNext = false;
  const fetch = async (input, init) => {
    const req = new Request(input, init);
    const signature = req.headers.get("PAYMENT-SIGNATURE");
    if (!signature) {
      const required = { x402Version: 2, resource: { url: "https://data.example/quote" }, accepts: [terms] };
      return new Response("payment required", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } });
    }
    const { nonce } = decodePaymentSignatureHeader(signature).payload;
    if (!settled.has(nonce)) settled.set(nonce, { success: true, transaction: `0xtx${settled.size + 1}`, network: terms.network, payer: "0xAgent" });
    if (dropNext) { dropNext = false; throw new TypeError("fetch failed"); }   // settled, then the response is lost
    return new Response(JSON.stringify({ price: 42 }), { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled.get(nonce)) } });
  };
  return { fetch, settled, loseNextResponse: () => { dropNext = true; } };
};
const scheme = { scheme: "exact", createPaymentPayload: async (x402Version, req) => ({ x402Version, payload: { nonce: randomUUID(), amount: req.amount, signature: "0xsig" } }) };
// The client's own spend controls stay ON: `allowedAssets: true` admits this
// token, and the default $1 per-payment cap still applies. The double payment
// below is not the result of switching a safety feature off.
const newClient = () => new x402Client().register(terms.network, scheme).setSpendControls({ allowedAssets: true });
const buy = async (fetchWithPay) => {
  try { const r = await fetchWithPay("https://data.example/quote"); return `${r.status} ${await r.text()}`; }
  catch (e) { return `${e.name}: ${e.message}`; }
};

// The reference client, as shipped.
let server = makeServer();
let pay = wrapFetchWithPayment(server.fetch, newClient());
server.loseNextResponse();
console.log(`  attempt 1  ${(await buy(pay)).padEnd(48)} settled on chain: ${server.settled.size}`);
console.log(`  attempt 2  ${(await buy(pay)).padEnd(48)} settled on chain: ${server.settled.size}   <- the reference client signed again and paid twice`);

// The same client behind the guard: one policy, one ledger, one authorization per purchase.
const policy = { account: "acct:agent", version: 1, rules: [
  { id: "per-call",  kind: "PER_TRANSACTION_LIMIT",  scope: ANY, asset: `${terms.network}/${USDC}`, maxAmount: 50_000n },
  { id: "daily",     kind: "WINDOW_BUDGET",          scope: ANY, asset: `${terms.network}/${USDC}`, windowMs: DAY, maxTotal: 1_000_000n },
  { id: "services",  kind: "DESTINATION_ALLOWLIST",  scope: ANY, destinations: ["x402:data.example"] },
]};
const { guard, store } = makeGuard(policy);
server = makeServer();
let guarded = guardX402(newClient(), { guard, account: "acct:agent", requester: agent("buyer") });
pay = guarded.fetch(server.fetch);
server.loseNextResponse();
const ledger = async () => (await store.entries("acct:agent")).map((e) => e.state).join(",");
console.log(`\n  attempt 1  ${(await buy(pay)).padEnd(48)} settled on chain: ${server.settled.size}   ledger: ${await ledger()}`);
console.log(`  attempt 2  ${(await buy(pay)).padEnd(48)} settled on chain: ${server.settled.size}   ledger: ${await ledger()}   <- same authorization presented again`);

// The reference wrapper driving a guarded client: it cannot be made to sign twice either.
server = makeServer();
guarded = guardX402(newClient(), { guard: makeGuard(policy).guard, account: "acct:agent", requester: agent("buyer") });
pay = wrapFetchWithPayment(server.fetch, guarded.client);
server.loseNextResponse();
await buy(pay);
console.log(`\n  reference wrapper, guarded client, attempt 2:\n  ${await buy(pay)}\n  settled on chain: ${server.settled.size}`);

// A purchase the policy does not allow never reaches the scheme.
const spendy = makeServer();
spendy.fetch = ((inner) => async (i, init) => { const r = await inner(i, init); if (r.status !== 402) return r;
  const required = { x402Version: 2, resource: { url: "https://data.example/premium" }, accepts: [{ ...terms, amount: "5000000" }] };
  return new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } }); })(spendy.fetch);
console.log(`\n  $5.00 premium tier, per-call cap $0.05:\n  ${await buy(guarded.fetch(spendy.fetch))}`);

// After a restart nothing is held in memory, so the retry is refused rather
// than re-signed, and the ledger asks the chain what happened.
server = makeServer();
const durable = makeGuard(policy);
guarded = guardX402(newClient(), { guard: durable.guard, account: "acct:agent", requester: agent("buyer") });
server.loseNextResponse();
await buy(guarded.fetch(server.fetch));
const restarted = guardX402(newClient(), { guard: durable.guard, account: "acct:agent", requester: agent("buyer") });
console.log(`\n  process restarts with the reservation open; attempt 2 from the new process:\n  ${await buy(restarted.fetch(server.fetch))}`);
durable.clock.advance(1);
const report = await durable.guard.reconcile({ observe: async (entry) => server.settled.size > 0 ? { state: "SETTLED", actualAmount: entry.amount } : { state: "UNKNOWN" } }, 0);
console.log(`  reconcile: the chain shows the payment landed; settled ${report.settled.length}, still open ${report.unresolved.length}, on chain: ${server.settled.size}`);

#!/usr/bin/env node
/**
 * One command that turns the README claims into things you can check.
 *
 *   npm run check
 *
 * Every line below states a property the packages claim, exercises it against
 * the built output, and exits non-zero if reality disagrees. Read it as the
 * list of things a stranger does not have to take on trust.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  Journal, MemoryJournalStore, JournalIntegrityError,
  canonicalJson, verifyEvent, verifyLane,
} from "@soldsoul86/journal";
import {
  SpendGuard, MemoryLedgerStore, JournalLedgerStore, ManualClock, singlePolicy,
  evaluate, validatePolicy, PolicyConfigError, policyDigest, canonicalText,
  buildReceipt, verifyReceipt,
  LedgerCommitment, verifyInclusion, emptyRoot,
  BucketCommitment, coveringBuckets, buildBudgetBundle, checkBudgetRelation, IS_ZERO_KNOWLEDGE,
  ed25519Signer, MemoryKeyDirectory, signQuote, verifySignedQuote,
} from "@soldsoul86/policy";

let failures = 0;
const check = (claim, ok, detail = "") => {
  failures += ok ? 0 : 1;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${claim}${detail && !ok ? `\n        ${detail}` : ""}\n`);
};
const section = (title) => process.stdout.write(`\n${title}\n`);
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const cp = (...points) => String.fromCodePoint(...points);
const NOW = 1_758_000_000_000;
const DAY = 86_400_000;

/* ---------------------------------------------------------------- journal */
section("@soldsoul86/journal");
{
  // RFC 8785 section 3.2.3, the RFC's own worked example: its input, and its
  // expected output byte for byte.
  const input = {
    numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    string: cp(0x20ac) + "$" + cp(0x0f) + cp(0x0a) + "A'B" + cp(0x22) + cp(0x5c) + cp(0x5c) + cp(0x22) + "/",
    literals: [null, true, false],
  };
  const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"'
    + cp(0x20ac) + "$" + cp(0x5c) + "u000f" + cp(0x5c) + "n" + "A'B" + cp(0x5c) + '"' + cp(0x5c) + cp(0x5c) + cp(0x5c) + cp(0x5c) + cp(0x5c) + '"' + "/"
    + '"}';
  const got = canonicalJson(input);
  check("canonicalJson reproduces the RFC 8785 worked example", got === expected, `got ${got}`);

  // Same section: keys order by UTF-16 code unit, so the emoji (a surrogate
  // pair) sorts before U+FB33 even though its code point is higher.
  const ordering = {
    [cp(0x20ac)]: "Euro Sign", [cp(0x0d)]: "Carriage Return", [cp(0xfb33)]: "Hebrew Letter Dalet With Dagesh",
    "1": "One", [cp(0x1f600)]: "Emoji: Grinning Face", [cp(0x80)]: "Control", [cp(0xf6)]: "Latin Small Letter O With Diaeresis",
  };
  // Read the order back from the text itself: Object.keys would hoist "1".
  const keys = [...canonicalJson(ordering).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`));
  check("keys are ordered by UTF-16 code unit, as JCS requires",
    keys.join("") === [cp(0x0d), "1", cp(0x80), cp(0xf6), cp(0x20ac), cp(0x1f600), cp(0xfb33)].join(""));
  check("canonicalJson refuses NaN rather than encoding it", throws(() => canonicalJson({ n: NaN })) !== null);

  const journal = await Journal.open({ store: new MemoryJournalStore(), device: "a", lane: "a", now: () => NOW });
  for (const i of [1, 2, 3]) {
    await journal.appendOne({ type: "t", schema: { id: "s", version: 1 }, payload: { i } });
  }
  const lane = await journal.readLane("a");
  check("every event hashes to its own contents", lane.every(verifyEvent));
  check("each event commits to its predecessor",
    lane[0].integrity.previous === null && lane[1].integrity.previous === lane[0].integrity.hash
      && lane[2].integrity.previous === lane[1].integrity.hash);
  check("HLC is strictly increasing within a lane even at a frozen clock",
    lane[0].hlc.counter < lane[1].hlc.counter && lane[1].hlc.counter < lane[2].hlc.counter);

  const tampered = lane.map((e, i) => (i === 1 ? { ...e, payload: { i: 99 } } : e));
  check("a tampered payload no longer verifies", !verifyEvent(tampered[1]));
  const named = throws(() => verifyLane(tampered));
  check("verifyLane names the tampered event",
    named instanceof JournalIntegrityError && named.detail.eventId === lane[1].id);
  check("verifyLane detects a removed event",
    throws(() => verifyLane([lane[0], lane[2]])) instanceof JournalIntegrityError);
  check("a device refuses writes to its own lane via replicate",
    (await journal.replicate("a", []).then(() => null, (e) => e)) instanceof JournalIntegrityError);
}

/* ----------------------------------------------------------------- policy */
section("@soldsoul86/policy: the engine");
const policy = {
  account: "acct:agent", version: 1,
  rules: [
    { id: "daily", kind: "WINDOW_BUDGET", scope: { kind: "ANY" }, asset: "tok", windowMs: DAY, maxTotal: 50_000n },
    { id: "each", kind: "PER_TRANSACTION_LIMIT", scope: { kind: "ANY" }, asset: "tok", maxAmount: 30_000n },
  ],
};
const draft = (requestId, amount) => ({
  requestId, account: "acct:agent", requester: { kind: "AGENT", agentId: "r" },
  asset: "tok", amount, destination: "vendor:x",
});
const request = { ...draft("req-0", 1_000n), requestedAt: NOW, approvals: [], attestations: [], memo: null };
{
  const a = evaluate(request, policy, []);
  const b = evaluate(request, policy, []);
  check("same inputs give a byte-identical decision", canonicalText(a) === canonicalText(b));
  check("the decision records the policy by content hash", a.policyDigest === policyDigest(policy));
  check("every rule is evaluated and recorded, not just the first",
    a.evaluations.length === policy.rules.length && a.evaluations.every((e) => e.verdict !== "NOT_APPLICABLE"));
  check("no rules means deny, never allow",
    evaluate(request, { account: "acct:agent", version: 1, rules: [] }).outcome === "DENY");
  check("a request for another account is refused before any rule runs",
    evaluate({ ...request, account: "acct:other" }, policy).reason === "WRONG_ACCOUNT");
  check("a zero amount is refused", evaluate({ ...request, amount: 0n }, policy).reason === "INVALID_AMOUNT");
  check("a negative limit is rejected when the policy loads, not at 3am",
    throws(() => validatePolicy({ ...policy, rules: [{ ...policy.rules[1], maxAmount: -1n }] })) instanceof PolicyConfigError);

  const ledger = [{
    requestId: "p", account: "acct:agent", asset: "tok", amount: 30_000n, destination: "vendor:x",
    requester: request.requester, at: NOW - 1, state: "PENDING", intent: "", decision: null, expiresAt: null,
  }];
  check("PENDING spend consumes budget exactly as SETTLED does",
    evaluate({ ...request, amount: 25_000n }, policy, ledger).outcome === "DENY");
  check("only REVERSED gives budget back",
    evaluate({ ...request, amount: 25_000n }, policy, [{ ...ledger[0], state: "REVERSED" }]).outcome === "ALLOW");
  check("the request under evaluation is excluded from its own ledger",
    evaluate({ ...request, requestId: "p", amount: 25_000n }, policy, ledger).outcome === "ALLOW");
}

section("@soldsoul86/policy: the guard");
{
  const clock = new ManualClock(NOW);
  const guard = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(policy), clock });
  const first = await guard.run(draft("r1", 4_000n), async (grant) => { grant.report(4_231n); return "ok"; });
  check("the ledger records what was actually spent, not the estimate",
    first.outcome === "COMPLETED" && first.actual === 4_231n && first.overage === 231n);
  const retry = await guard.run(draft("r1", 4_000n), async () => "ran again");
  check("the same request id twice spends once and returns the original decision",
    retry.outcome === "DUPLICATE" && retry.decision !== null && retry.existing.amount === 4_231n);
  const mismatch = await guard.run(draft("r1", 9_000n), async () => "ran");
  check("a reused id with a different amount is refused, not absorbed", mismatch.outcome === "MISMATCH");
  const held = await guard.run(draft("r2", 1n), async () => { throw new Error("connection reset"); });
  clock.advance(1);
  check("a failure that reported nothing leaves the reservation open, not reversed",
    held.outcome === "INDETERMINATE" && (await guard.openReservations(0)).some((e) => e.requestId === "r2"));

  const racy = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(policy), clock: new ManualClock(NOW) });
  const outcomes = await Promise.all(
    Array.from({ length: 10 }, (_, i) => racy.run(draft(`c${i}`, 10_000n), async () => i)),
  );
  const completed = outcomes.filter((o) => o.outcome === "COMPLETED").length;
  check("ten concurrent 10,000 spends against a 50,000 budget complete exactly five times",
    completed === 5, `completed ${completed}`);
}

section("@soldsoul86/policy: receipts that verify without trusting the issuer");
let req, decision, facts, ledgerEntries;
{
  const journal = await Journal.open({ store: new MemoryJournalStore(), device: "a", lane: "a", now: () => NOW });
  const store = await JournalLedgerStore.open({ journal });
  const guard = new SpendGuard({ store, policyFor: singlePolicy(policy), clock: new ManualClock(NOW) });
  const auth = await guard.authorize(draft("rcpt", 4_000n));
  await auth.settle(3_500n);
  ({ request: req, decision } = auth);
  facts = store.factsFor("rcpt");
  ledgerEntries = await store.entries("acct:agent");
  const outcome = { state: "SETTLED", amount: 3_500n };
  const receipt = buildReceipt({ request: req, decision, outcome, facts, issuedAt: NOW, policy, ledgerContext: ledgerEntries });
  const full = verifyReceipt(receipt);
  check("a complete receipt verifies on all seven checks",
    full.verified && full.checks.length === 7,
    full.checks.filter((c) => c.status !== "PASS").map((c) => `${c.name}:${c.status}`).join(", "));
  check("the decision is recomputed independently, not read back",
    full.checks.find((c) => c.name === "DECISION_REPRODUCES").status === "PASS");
  const fails = (r, name) => verifyReceipt(r).checks.find((c) => c.name === name).status === "FAIL";
  check("a receipt claiming a different settled amount fails",
    fails({ ...receipt, outcome: { state: "SETTLED", amount: 1n } }, "OUTCOME_CONSISTENT"));
  check("a receipt with a swapped-in policy fails the binding check",
    fails({ ...receipt, policy: { ...policy, version: 2 } }, "POLICY_BINDING"));
  check("a receipt whose decision does not follow from its inputs fails",
    fails({ ...receipt, decision: { ...decision, evaluations: [] } }, "DECISION_REPRODUCES"));
  check("an edited journal event inside a receipt is caught",
    fails({ ...receipt, facts: [{ ...facts[0], payload: { ...facts[0].payload, amount: "1" } }, facts[1]] }, "FACTS_INTACT"));
  const redacted = verifyReceipt(buildReceipt({ request: req, decision, outcome, facts, issuedAt: NOW }));
  check("a redacted receipt is reported PARTIAL, never quietly verified", !redacted.verified && redacted.partial);
}

section("@soldsoul86/policy: signatures");
{
  const pem = (k) => k.export({ type: k.type === "private" ? "pkcs8" : "spki", format: "pem" });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const directory = new MemoryKeyDirectory([{
    keyId: "k1", algorithm: "ed25519", publicKeyPem: pem(publicKey),
    speaksFor: ["vendor:x"], notBefore: 0, notAfter: null, revoked: false,
  }]);
  const quote = {
    quoteId: "q", issuer: "vendor:x", subject: { kind: "api.call", digest: "d" }, asset: "tok",
    maxAmount: 5_000n, payTo: "vendor:x", issuedAt: NOW, expiresAt: NOW + 60_000, audience: null, requestId: null,
  };
  const signed = signQuote(quote, ed25519Signer("k1", pem(privateKey)), NOW);
  check("a quote signed by a key authorised for its issuer is authentic",
    verifySignedQuote(signed, directory).disposition === "authentic");
  check("a correct signature from a key not authorised for that issuer is refused",
    verifySignedQuote({ ...signed, payload: { ...quote, issuer: "vendor:y" } }, directory).disposition !== "authentic");
  check("a tampered payload reads as signature_invalid",
    verifySignedQuote({ ...signed, payload: { ...quote, maxAmount: 6_000n } }, directory).disposition === "signature_invalid");
  const offline = { publicKey: () => ({ found: false, reason: "UNAVAILABLE", detail: "down" }) };
  check("an unreachable key directory is reported as resolution failure, not forgery",
    verifySignedQuote(signed, offline).disposition === "signer_resolution_failed");
}

section("@soldsoul86/policy: commitments");
{
  const sha256empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  check("the empty tree root is SHA-256 of nothing, per RFC 6962", emptyRoot() === sha256empty);
  const abc = new LedgerCommitment(["a", "b", "c"]);
  check("odd levels are promoted, not duplicated: [a,b,c] and [a,b,c,c] have different roots",
    abc.root !== new LedgerCommitment(["a", "b", "c", "c"]).root);
  let all = true;
  for (let n = 1; n <= 9; n++) {
    const values = Array.from({ length: n }, (_, i) => ({ i }));
    const tree = new LedgerCommitment(values);
    for (let i = 0; i < n; i++) all &&= verifyInclusion(values[i], tree.prove(i), tree.root);
    all &&= !verifyInclusion({ i: 0 }, tree.prove(0), abc.root);
  }
  check("inclusion proofs verify for every leaf of every tree size 1..9, and not against another root", all);

  const rule = policy.rules[0];
  const bucketMs = DAY / 24;
  const range = coveringBuckets(NOW, rule.windowMs, bucketMs);
  const commitment = BucketCommitment.build(ledgerEntries, { account: "acct:agent", asset: "tok", bucketMs, ...range });
  const bundle = buildBudgetBundle({
    policy, request: { ...req, requestId: "zk" }, ruleId: "daily", commitment, windowMs: rule.windowMs,
  });
  const relation = checkBudgetRelation(bundle);
  check("the reference budget relation holds for an honest witness", relation.satisfied,
    relation.constraints.filter((c) => !c.satisfied).map((c) => `${c.id} ${c.detail}`).join("; "));
  check("it says plainly that it is not zero-knowledge", relation.zeroKnowledge === false && IS_ZERO_KNOWLEDGE === false);
  const over = checkBudgetRelation({
    ...bundle, witness: { ...bundle.witness, request: { ...bundle.witness.request, amount: 50_000n } },
  });
  check("an overspend fails the budget constraint C7",
    !over.satisfied && over.constraints.find((c) => c.id === "C7").satisfied === false);
  const short = checkBudgetRelation({ ...bundle, witness: { ...bundle.witness, buckets: bundle.witness.buckets.slice(1) } });
  check("omitting a bucket fails completeness C6 rather than shrinking the sum",
    short.constraints.find((c) => c.id === "C6").satisfied === false);
}

/* -------------------------------------------------------------- anthropic */
section("@soldsoul86/anthropic: the SDK behind the guard");
{
  // The real SDK client, with `fetch` replaced so no network is involved.
  // Everything else is genuine: APIPromise, MessageStream, the error classes.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { guardMessages, SpendRefusedError, SpendDuplicateError, estimateTokens } = await import("@soldsoul86/anthropic");

  const calls = [];
  let mode = "ok";
  const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
    content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_1" } });
  const sse = [
    ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

  const fakeFetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/count_tokens")) return json({ input_tokens: 123 });
    if (mode === "http400") return json({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }, 400);
    if (mode === "network") throw new TypeError("fetch failed");
    const body = JSON.parse(init.body);
    if (body.stream) return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    return json(message);
  };
  const client = new Anthropic({ apiKey: "test", fetch: fakeFetch, maxRetries: 0 });

  const policy = { account: "acct", version: 1, rules: [
    { id: "daily", kind: "WINDOW_BUDGET", scope: { kind: "ANY" }, asset: "anthropic:tokens", windowMs: DAY, maxTotal: 40_000n },
    { id: "models", kind: "DESTINATION_ALLOWLIST", scope: { kind: "ANY" }, destinations: ["anthropic:claude-opus-5"] },
  ]};
  const store = new MemoryLedgerStore();
  const guard = new SpendGuard({ store, policyFor: singlePolicy(policy), clock: new ManualClock(NOW) });
  let nextId = "";
  const claude = guardMessages(client, {
    guard, account: "acct", requester: { kind: "AGENT", agentId: "bot" }, requestId: () => nextId || crypto.randomUUID(),
  });
  const params = { model: "claude-opus-5", max_tokens: 16_000, messages: [{ role: "user", content: "hello" }] };
  const entry = async (id) => (await store.find(id));

  const before = calls.length;
  const { message: got, settlement } = await claude.createWithSettlement(params);
  check("an allowed call returns the SDK message and settles at the reported usage",
    got.content[0].text === "hi" && settlement.actual === 150n && (await entry(settlement.requestId)).state === "SETTLED"
      && calls.length === before + 1);
  check("the reservation was the estimate, the settlement the truth",
    settlement.reserved === estimateTokens(params) && settlement.reserved >= 16_000n && settlement.actual === 150n);

  const blocked = await claude.create({ ...params, model: "claude-haiku-4-5" }).then(() => null, (e) => e);
  check("a model outside the destination allowlist is refused before any request is made",
    blocked instanceof SpendRefusedError && blocked.decision.reason === "DESTINATION_NOT_ALLOWED" && calls.length === before + 1);

  mode = "http400";
  const bad = await claude.createWithSettlement(params).then(() => null, (e) => e);
  const reversed = (await store.entries("acct")).filter((e) => e.state === "REVERSED");
  check("an HTTP 400 propagates as the SDK's own error class and the reservation is reversed",
    bad instanceof Anthropic.BadRequestError && bad.status === 400 && reversed.length === 1);

  mode = "network";
  const lost = await claude.create(params).then(() => null, (e) => e);
  const open = (await store.entries("acct")).filter((e) => e.state === "PENDING");
  check("a connection failure propagates and leaves the reservation open for reconciliation",
    lost instanceof Anthropic.APIConnectionError && open.length === 1);
  mode = "ok";

  nextId = "same-id";
  await claude.create(params);
  const dup = await claude.create(params).then(() => null, (e) => e);
  check("a retried request id is refused as a duplicate without a second request",
    dup instanceof SpendDuplicateError && dup.existing.state === "SETTLED");
  nextId = "";

  const { stream, settled } = await claude.stream(params);
  let text = "";
  for await (const event of stream) if (event.type === "content_block_delta") text += event.delta.text;
  const streamed = await settled;
  check("a stream is the SDK's own MessageStream and settles once the final message arrives",
    text === "hi" && streamed.actual === 150n && (await entry(streamed.requestId)).state === "SETTLED");

  const counted = guardMessages(client, { guard, account: "acct", requester: { kind: "AGENT", agentId: "bot" }, estimate: "count" });
  check("estimate: \"count\" uses the token counting endpoint plus max_tokens",
    (await counted.estimate(params)) === 123n + 16_000n && calls.at(-1).endsWith("/count_tokens"));

  const cheapPolicy = { ...policy, rules: [{ id: "spend", kind: "WINDOW_BUDGET", scope: { kind: "ANY" }, asset: "usd:microcents", windowMs: DAY, maxTotal: 10_000_000n }] };
  const g2 = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(cheapPolicy), clock: new ManualClock(NOW) });
  const p2 = guardMessages(client, { guard: g2, account: "acct", requester: { kind: "AGENT", agentId: "bot" }, asset: "usd:microcents",
    measure: (u) => BigInt(u.input_tokens * 500 + u.output_tokens * 2_500) });
  const s2 = await p2.createWithSettlement(params);
  check("measure lets the ledger settle in a currency instead of tokens",
    s2.settlement.actual === 100n * 500n + 50n * 2_500n);

  const total = (await store.entries("acct")).filter((e) => e.state !== "REVERSED").reduce((n, e) => n + e.amount, 0n);
  const exhausted = await claude.create({ ...params, max_tokens: 40_000 }).then(() => null, (e) => e);
  check("the daily budget is judged against settled usage, and an oversized call is refused",
    exhausted instanceof SpendRefusedError && exhausted.decision.reason === "BUDGET_EXHAUSTED" && total < 40_000n);
}

process.stdout.write(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

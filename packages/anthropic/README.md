# @soldsoul86/anthropic

The Anthropic SDK behind a spend guard. One import changes; every call is then
decided by your policy before it is sent, reserved against your budget, and
settled at the token count the API actually reports.

```bash
npm install @soldsoul86/anthropic @soldsoul86/policy @anthropic-ai/sdk
```

```ts
import Anthropic from "@anthropic-ai/sdk";
import { SpendGuard, MemoryLedgerStore, singlePolicy } from "@soldsoul86/policy";
import { guardMessages, SpendRefusedError } from "@soldsoul86/anthropic";

const policy = {
  account: "acct:research", version: 1,
  rules: [
    { id: "daily", kind: "WINDOW_BUDGET", scope: { kind: "ANY" },
      asset: "anthropic:tokens", windowMs: 86_400_000, maxTotal: 2_000_000n },
    { id: "models", kind: "DESTINATION_ALLOWLIST", scope: { kind: "ANY" },
      destinations: ["anthropic:claude-opus-5"] },
  ],
};

const guard = new SpendGuard({ store: new MemoryLedgerStore(), policyFor: singlePolicy(policy) });
const claude = guardMessages(new Anthropic(), {
  guard, account: "acct:research", requester: { kind: "AGENT", agentId: "researcher" },
});

try {
  const message = await claude.create({
    model: "claude-opus-5", max_tokens: 16_000,
    messages: [{ role: "user", content: "Summarise this quarter's incidents." }],
  });
} catch (error) {
  if (error instanceof SpendRefusedError) console.log(error.message); // "DENY  ...  (BUDGET_EXHAUSTED)"
  else throw error;
}
```

**What is counted.** Input, output, cache creation and cache read tokens,
summed, in the asset `anthropic:tokens`. Pass `measure` to weight them or to
settle in a currency instead; pass `asset` to name it.

**The destination is the model.** Each call is recorded against
`anthropic:<model>`, so a destination allowlist is a model allowlist and a
destination denylist blocks a model. Override with `destination`.

**Before the call, an estimate; after it, the truth.** The reservation is
about four characters per token of input plus `max_tokens`. Set
`estimate: "count"` to use the token counting endpoint instead. Either way the
ledger settles at `message.usage`.

**When the API says no, budget comes back.** An error with an HTTP status
reverses the reservation, since nothing was billed. A connection reset or a
timeout leaves it open, because a response lost after the tokens were spent
looks identical from here; reconcile those against your usage report.

**Streaming.** `await claude.stream(params)` returns the SDK's own
`MessageStream` plus a `settled` promise that resolves once the final message
has arrived and the ledger is updated.

**Retries are free.** Pass `requestId` to derive a stable id from your own
request, and a retry returns the original decision without spending twice.

The SDK is a peer dependency used for its types only. Nothing here imports it
at runtime; any object with the same `messages` shape works.

Ships without a test suite. `npm run check` at the repository root exercises
the claims above against the built output.

Apache-2.0.

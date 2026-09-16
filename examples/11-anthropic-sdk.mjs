import Anthropic from "@anthropic-ai/sdk";
import { guardMessages, SpendRefusedError } from "@soldsoul86/anthropic";
import { makeGuard, title, agent, ANY, DAY } from "./lib.mjs";
title(11, "The Anthropic SDK behind the guard: one import changes, every call is decided, reserved and settled");

// No API key is needed to run this example: `fetch` is replaced with a stub
// that answers like the API. Delete the `fetch` option to talk to Anthropic.
const reply = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text: "Three incidents, all resolved." }],
  usage: { input_tokens: 1_200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
const client = new Anthropic({ apiKey: "example", maxRetries: 0,
  fetch: async () => new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }) });

const policy = { account: "acct:research", version: 1, rules: [
  { id: "daily",  kind: "WINDOW_BUDGET",         scope: ANY, asset: "anthropic:tokens", windowMs: DAY, maxTotal: 20_000n },
  { id: "models", kind: "DESTINATION_ALLOWLIST", scope: ANY, destinations: ["anthropic:claude-opus-5"] },
]};
const { guard } = makeGuard(policy);

// This is the swap. `claude.create` takes exactly what `client.messages.create` takes.
const claude = guardMessages(client, { guard, account: "acct:research", requester: agent("researcher") });

const ask = async (label, params) => {
  try {
    const { message, settlement } = await claude.createWithSettlement(params);
    console.log(`  ALLOW   ${label.padEnd(58)} reserved ${settlement.reserved}, settled ${settlement.actual} tokens: "${message.content[0].text}"`);
  } catch (error) {
    if (!(error instanceof SpendRefusedError)) throw error;
    console.log(`  DENY    ${label.padEnd(58)} ${error.message}`);
  }
};

const messages = [{ role: "user", content: "Summarise this quarter's incidents." }];
await ask("opus, max_tokens 8,000", { model: "claude-opus-5", max_tokens: 8_000, messages });
await ask("haiku (not on the model allowlist)", { model: "claude-haiku-4-5", max_tokens: 8_000, messages });
await ask("opus again, max_tokens 8,000 (1,500 used so far, fits)", { model: "claude-opus-5", max_tokens: 8_000, messages });
await ask("opus, max_tokens 19,000 (3,000 used; reservation would reach 22,000)", { model: "claude-opus-5", max_tokens: 19_000, messages });
console.log("          the reservation is max_tokens plus the input estimate; the ledger keeps only what was actually used");

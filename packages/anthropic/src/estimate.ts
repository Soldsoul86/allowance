/**
 * Sizing a reservation before the call.
 *
 * The reservation only has to be close: the ledger settles at the usage the
 * API reports, and a budget rule is judged against the real figure from then
 * on. What matters is that the estimate is never wildly small, so a request
 * that would blow the budget is refused before it is sent rather than after.
 *
 * Text is counted at about four characters per token. Images and documents
 * are charged a flat allowance each, which is generous for small ones and
 * about right for a page. The reply is charged at `max_tokens`, its ceiling.
 */
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { Amount } from "@soldsoul86/policy";

const CHARS_PER_TOKEN = 4;
const MEDIA_BLOCK_CHARS = 1_600 * CHARS_PER_TOKEN;

function charsOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + charsOf(v), 0);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record["type"] === "image" || record["type"] === "document") return MEDIA_BLOCK_CHARS;
    return Object.values(record).reduce<number>((n, v) => n + charsOf(v), 0);
  }
  return 0;
}

/** Input estimate plus the reply ceiling, in tokens. */
export function estimateTokens(params: MessageCreateParamsNonStreaming): Amount {
  const input =
    charsOf(params.messages) +
    charsOf(params.system ?? "") +
    (params.tools === undefined ? 0 : JSON.stringify(params.tools).length);
  return BigInt(Math.ceil(input / CHARS_PER_TOKEN) + params.max_tokens);
}

/**
 * @soldsoul86/anthropic — the Anthropic SDK behind a spend guard.
 *
 * Swap `client.messages.create(...)` for `guarded.create(...)` and every call
 * is decided by your policy first, reserved against your budget, and settled
 * at the token count the API actually reports.
 */
export { guardMessages, GuardedMessages, defaultMeasure } from "./guarded.js";
export {
  SpendRefusedError,
  SpendDuplicateError,
  SpendMismatchError,
} from "./guarded.js";
export type {
  AnthropicLike,
  MessagesPort,
  FinalMessageSource,
  GuardedMessagesOptions,
  Settlement,
} from "./guarded.js";
export { estimateTokens } from "./estimate.js";

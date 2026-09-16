/**
 * The Anthropic SDK behind a spend guard.
 *
 * Every call to `messages.create` or `messages.stream` becomes a spend: the
 * policy decides before the request leaves, the budget is reserved durably,
 * the request runs, and the reservation settles at the token count the API
 * actually reports. Refusals throw before any network traffic.
 *
 * The SDK is a peer dependency used for its types only. Nothing here imports
 * it at runtime; the caller passes in the client they already have, and any
 * object with the same `messages` shape works.
 */
import { randomUUID } from "node:crypto";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageCountTokensParams,
  MessageTokensCount,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";
import type { Amount, Decision, LedgerEntry, Requester, SpendGuard, SpendRequest } from "@soldsoul86/policy";
import { explain } from "@soldsoul86/policy";

import { estimateTokens } from "./estimate.js";

/** The one thing the SDK's `MessageStream` needs to provide. */
export interface FinalMessageSource {
  finalMessage(): Promise<Message>;
}

/** The slice of an Anthropic client this package touches. */
export interface MessagesPort {
  create(params: MessageCreateParamsNonStreaming, options?: unknown): PromiseLike<Message>;
  stream(params: MessageCreateParamsNonStreaming, options?: unknown): FinalMessageSource;
  countTokens?(params: MessageCountTokensParams, options?: unknown): PromiseLike<MessageTokensCount>;
}

export interface AnthropicLike {
  readonly messages: MessagesPort;
}

export interface GuardedMessagesOptions {
  readonly guard: SpendGuard;
  /** The account whose policy governs these calls. */
  readonly account: string;
  /** Who is calling. Scopes rules and appears in every ledger entry. */
  readonly requester: Requester;
  /** The asset every call is measured in. Default `"anthropic:tokens"`. */
  readonly asset?: string;
  /**
   * The destination recorded for a call. Default `anthropic:<model>`, so an
   * ordinary `DESTINATION_ALLOWLIST` rule becomes a model allowlist.
   */
  readonly destination?: (params: MessageCreateParamsNonStreaming) => string;
  /** The idempotency key for a call. Default a fresh UUID per call. */
  readonly requestId?: (params: MessageCreateParamsNonStreaming) => string;
  /**
   * How the reservation is sized before the call.
   *
   * `"heuristic"` (default) counts characters locally: about four per token,
   * plus `max_tokens` for the reply. `"count"` calls the token counting
   * endpoint for an exact input figure, at the cost of one extra request.
   * Either way the ledger settles at the real usage afterwards.
   */
  readonly estimate?: "heuristic" | "count";
  /**
   * Turns the API's usage report into the amount settled. Default sums input,
   * output, cache creation and cache read tokens. Supply your own to weight
   * them, or to convert to a currency in base units.
   */
  readonly measure?: (usage: Usage) => Amount;
  /** Reservation deadline for one call, if the guard's default is not right. */
  readonly ttlMs?: number;
}

/** What the ledger recorded for one completed call. */
export interface Settlement {
  readonly requestId: string;
  readonly reserved: Amount;
  readonly actual: Amount;
  readonly usage: Usage;
  readonly decision: Decision;
}

/** The policy said no. Nothing was sent. */
export class SpendRefusedError extends Error {
  override readonly name = "SpendRefusedError";
  constructor(readonly decision: Decision, readonly request: SpendRequest) {
    super(explain(decision).split("\n")[0]);
  }
}

/** This request id was already spent. Nothing was sent; the original decision is attached. */
export class SpendDuplicateError extends Error {
  override readonly name = "SpendDuplicateError";
  constructor(readonly existing: LedgerEntry, readonly decision: Decision | null) {
    super(`request ${existing.requestId} was already spent (${existing.state})`);
  }
}

/** This request id was reused for a different call. Nothing was sent. */
export class SpendMismatchError extends Error {
  override readonly name = "SpendMismatchError";
  constructor(readonly existing: LedgerEntry, detail: string) {
    super(detail);
  }
}

export function defaultMeasure(usage: Usage): Amount {
  return BigInt(
    usage.input_tokens +
      usage.output_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
  );
}

/**
 * An HTTP error from the API means the request was rejected before any
 * tokens were billed, so the reservation can be reversed. Anything without a
 * status (a connection reset, a timeout) is left open: from here it cannot be
 * told apart from a response that was lost after the tokens were consumed.
 */
function rejectedByApi(error: unknown): boolean {
  return typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number";
}

export class GuardedMessages<C extends AnthropicLike> {
  readonly #client: C;
  readonly #options: GuardedMessagesOptions;

  constructor(client: C, options: GuardedMessagesOptions) {
    this.#client = client;
    this.#options = options;
  }

  /**
   * `messages.create`, guarded. Returns the SDK's message on success and
   * throws a `SpendRefusedError`, `SpendDuplicateError` or `SpendMismatchError`
   * before sending anything when the ledger says no. API errors propagate
   * unchanged.
   */
  async create(params: MessageCreateParamsNonStreaming, options?: unknown): Promise<Message> {
    const { message } = await this.createWithSettlement(params, options);
    return message;
  }

  /** As `create`, also returning what the ledger recorded. */
  async createWithSettlement(
    params: MessageCreateParamsNonStreaming,
    options?: unknown,
  ): Promise<{ readonly message: Message; readonly settlement: Settlement }> {
    const auth = await this.#authorize(params);

    let message: Message;
    try {
      message = await this.#client.messages.create(params, options);
    } catch (error) {
      if (rejectedByApi(error)) await auth.reverse();
      throw error;
    }

    const settlement = await this.#settle(auth, message.usage);
    return { message, settlement };
  }

  /**
   * `messages.stream`, guarded. The policy is consulted before the stream
   * opens. The returned stream is the SDK's own; `settled` resolves once the
   * final message has arrived and the ledger has been updated, and rejects
   * with the stream's error if it fails.
   */
  async stream(
    params: MessageCreateParamsNonStreaming,
    options?: unknown,
  ): Promise<{ readonly stream: ReturnType<C["messages"]["stream"]>; readonly settled: Promise<Settlement> }> {
    const auth = await this.#authorize(params);

    const stream = this.#client.messages.stream(params, options) as ReturnType<C["messages"]["stream"]>;
    const settled = stream.finalMessage().then(
      (message) => this.#settle(auth, message.usage),
      async (error: unknown) => {
        if (rejectedByApi(error)) await auth.reverse();
        throw error;
      },
    );
    // A caller who never awaits `settled` must not crash the process when the
    // stream fails; the rejection is still delivered to anyone who does.
    settled.catch(() => undefined);

    return { stream, settled };
  }

  /** The reservation a call would ask for, in the configured asset. */
  async estimate(params: MessageCreateParamsNonStreaming): Promise<Amount> {
    if (this.#options.estimate === "count" && this.#client.messages.countTokens) {
      const { input_tokens } = await this.#client.messages.countTokens({
        model: params.model,
        messages: params.messages,
        ...(params.system === undefined ? {} : { system: params.system }),
        ...(params.tools === undefined ? {} : { tools: params.tools }),
      });
      return BigInt(input_tokens + params.max_tokens);
    }
    return estimateTokens(params);
  }

  async #authorize(params: MessageCreateParamsNonStreaming) {
    const o = this.#options;
    const auth = await o.guard.authorize({
      requestId: o.requestId?.(params) ?? randomUUID(),
      account: o.account,
      requester: o.requester,
      asset: o.asset ?? "anthropic:tokens",
      amount: await this.estimate(params),
      destination: o.destination?.(params) ?? `anthropic:${params.model}`,
      ...(o.ttlMs === undefined ? {} : { ttlMs: o.ttlMs }),
    });

    if (auth.granted) return auth;
    switch (auth.refusal) {
      case "DENIED":
        throw new SpendRefusedError(auth.decision, auth.request);
      case "DUPLICATE":
        throw new SpendDuplicateError(auth.existing, auth.decision);
      case "MISMATCH":
        throw new SpendMismatchError(auth.existing, auth.detail);
    }
  }

  async #settle(
    auth: { readonly request: SpendRequest; readonly decision: Decision; settle(actual: Amount): Promise<void> },
    usage: Usage,
  ): Promise<Settlement> {
    const actual = (this.#options.measure ?? defaultMeasure)(usage);
    await auth.settle(actual);
    return {
      requestId: auth.request.requestId,
      reserved: auth.request.amount,
      actual,
      usage,
      decision: auth.decision,
    };
  }
}

/** Wraps a client. The result stands in for `client.messages` wherever money is involved. */
export function guardMessages<C extends AnthropicLike>(client: C, options: GuardedMessagesOptions): GuardedMessages<C> {
  return new GuardedMessages(client, options);
}

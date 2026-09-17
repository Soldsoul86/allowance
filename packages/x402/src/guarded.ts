/**
 * x402 behind a spend guard.
 *
 * The reference x402 client signs a fresh authorization every time it sees a
 * 402. That is right for a first purchase and wrong for a retry: a response
 * lost after the facilitator settled looks, from the client, exactly like a
 * response lost before the request left, and a client that answers both by
 * signing again has paid twice for one resource. The x402 maintainers have
 * this on file as x402-foundation/x402#3438; the fix, as the report says,
 * lives in the client.
 *
 * So the guard goes in front of the signature. A purchase is identified
 * before anything is signed; the policy decides; the budget is reserved
 * durably; only then is an authorization minted, and it is kept, so that a
 * retry of the same purchase presents the same authorization rather than a
 * new one. What the server reports settled is what the ledger records.
 *
 * Two layers, because there are two ways to use it:
 *
 * - {@link guardX402} registers hooks on an `x402Client`. Whatever wrapper
 *   drives that client — the reference `wrapFetchWithPayment`, axios, your
 *   own — the policy runs before every signature, and a second signature for
 *   an unresolved purchase is refused. That alone closes the double-spend.
 * - {@link GuardedX402.fetch} is a fetch wrapper that additionally *reuses*
 *   the authorization on retry, so the retry completes the purchase instead
 *   of being refused, and settles the ledger from the server's response.
 *
 * `@x402/core` is a peer dependency used at runtime for the client hooks and
 * the header codecs. Nothing about the wire format is reimplemented here.
 */
import { x402HTTPClient } from "@x402/core/client";
import type {
  x402Client,
  PaymentCreationContext,
  PaymentCreatedContext,
  PaymentCreationFailureContext,
  PaymentResponseContext,
} from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { Authorization, Decision, LedgerEntry, Requester, SpendGuard, SpendRequest } from "@soldsoul86/policy";
import { digestOf, explain, readAmount } from "@soldsoul86/policy";

export interface GuardX402Options {
  readonly guard: SpendGuard;
  /** The account whose policy governs these purchases. */
  readonly account: string;
  /** Who is buying. Scopes rules and appears in every ledger entry. */
  readonly requester: Requester;
  /**
   * The ledger asset a requirement is recorded in. Default `<network>/<asset>`,
   * for example `eip155:8453/0x8335…2913`, so a budget names one token on one
   * chain. Map several to one name here if your policy is written that way.
   */
  readonly asset?: (requirements: PaymentRequirements) => string;
  /**
   * The destination recorded for a purchase. Default `x402:<host>` of the
   * resource URL, so a `DESTINATION_ALLOWLIST` rule is a list of services you
   * will pay. Use `requirements.payTo` here to allowlist payees instead.
   */
  readonly destination?: (paymentRequired: PaymentRequired, requirements: PaymentRequirements) => string;
  /**
   * What makes two 402s the same purchase. Default {@link purchaseId}: the
   * account, the requester, the resource URL and the terms offered. A retry
   * derives the same id and is absorbed; buying the same resource again on
   * purpose needs a `purchase` key on the request, or a different rule here.
   */
  readonly requestId?: (paymentRequired: PaymentRequired) => string;
  /** Reservation deadline for one purchase, if the guard's default is not right. */
  readonly ttlMs?: number;
}

/** The policy said no. Nothing was signed. */
export class SpendRefusedError extends Error {
  override readonly name = "SpendRefusedError";
  constructor(readonly decision: Decision, readonly request: SpendRequest) {
    super(explain(decision).split("\n")[0]);
  }
}

/**
 * This purchase already has a reservation. Nothing was signed.
 *
 * `existing.state` says which case: `SETTLED` means the purchase completed
 * and the response was lost; `PENDING` means the outcome is unknown. A
 * `PENDING` retry through {@link GuardedX402.fetch} presents the original
 * authorization instead of raising this; any other path, and any process
 * that no longer holds that authorization, gets this error, because a fresh
 * signature is the one thing that must not happen.
 */
export class SpendDuplicateError extends Error {
  override readonly name = "SpendDuplicateError";
  constructor(readonly existing: LedgerEntry, readonly decision: Decision | null) {
    super(
      existing.state === "PENDING"
        ? `purchase ${existing.requestId} has an open reservation; signing again would pay twice. ` +
          `Retry it through the guarded fetch to present the original authorization, or reconcile it`
        : `purchase ${existing.requestId} was already ${existing.state.toLowerCase()}`,
    );
  }
}

/** The same purchase id came back with different terms. Nothing was signed. */
export class SpendMismatchError extends Error {
  override readonly name = "SpendMismatchError";
  constructor(readonly existing: LedgerEntry, detail: string) {
    super(detail);
  }
}

/**
 * The default identity of a purchase.
 *
 * Deliberately excludes anything the client mints — a nonce, a timestamp —
 * because the point is that two attempts at one purchase must agree. It
 * includes every offered term, so a server that quotes a different price on
 * the retry produces a different purchase, and the mismatch is refused rather
 * than absorbed under the old reservation.
 */
export function purchaseId(account: string, requester: Requester, paymentRequired: PaymentRequired): string {
  return digestOf({
    kind: "x402-purchase",
    account,
    requester,
    resource: paymentRequired.resource.url,
    accepts: paymentRequired.accepts.map((a) => ({
      scheme: a.scheme,
      network: a.network,
      asset: a.asset,
      amount: a.amount,
      payTo: a.payTo,
    })),
  });
}

type Granted = Extract<Authorization, { granted: true }>;

/** A purchase this instance has signed for and not yet seen the outcome of. */
export interface Purchase {
  readonly requestId: string;
  readonly reservation: LedgerEntry;
  /** Present once signed. Presented again on retry. */
  readonly authorized: boolean;
}

export type GuardedRequestInit = RequestInit & {
  /**
   * Names this purchase. Two requests with the same key are one purchase;
   * omitted, the key is derived from the resource and its terms.
   */
  readonly purchase?: string;
};

export type GuardedFetch = (input: string | URL | Request, init?: GuardedRequestInit) => Promise<Response>;

interface Held {
  readonly auth: Granted;
  payload: PaymentPayload | null;
  /** How many times the authorization has been sent. A refusal proves nothing moved only on the first. */
  presented: number;
  /** The server has refused a re-presented authorization; only reconciliation can say what happened. */
  stuck: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class GuardedX402 {
  readonly client: x402Client;
  readonly #http: x402HTTPClient;
  readonly #o: GuardX402Options;
  /** Purchase ids assigned to a 402 before signing, by the fetch wrapper or by the hook. */
  readonly #ids = new WeakMap<PaymentRequired, string>();
  /** Reservations this instance holds, with the authorization once minted. */
  readonly #held = new Map<string, Held>();
  /** Which purchase a payload belongs to, so the response hook can find it. */
  readonly #payloads = new WeakMap<PaymentPayload, string>();
  /** The typed refusal behind a hook abort, for the fetch wrapper to rethrow. */
  readonly #refusals = new WeakMap<PaymentRequired, Error>();

  constructor(client: x402Client, options: GuardX402Options) {
    this.client = client;
    this.#o = options;
    this.#http = new x402HTTPClient(client);
    client.onBeforePaymentCreation((ctx) => this.#beforeSigning(ctx));
    client.onAfterPaymentCreation((ctx) => this.#afterSigning(ctx));
    client.onPaymentCreationFailure((ctx) => this.#signingFailed(ctx));
    client.onPaymentResponse((ctx) => this.#responded(ctx));
  }

  /** The purchase id this instance would assign to a 402. */
  idFor(paymentRequired: PaymentRequired): string {
    return this.#ids.get(paymentRequired)
      ?? this.#o.requestId?.(paymentRequired)
      ?? purchaseId(this.#o.account, this.#o.requester, paymentRequired);
  }

  /** Purchases signed for whose outcome has not yet been recorded. */
  unresolved(): readonly Purchase[] {
    return [...this.#held].map(([requestId, h]) => ({
      requestId,
      reservation: h.auth.reservation,
      authorized: h.payload !== null,
    }));
  }

  /**
   * A fetch that pays, and pays once.
   *
   * On a 402 the purchase is identified first. If this instance already holds
   * an authorization for it — the retry after a lost response — that same
   * authorization is presented again and nothing new is signed. Otherwise the
   * policy decides, the budget is reserved, and the scheme signs. The ledger
   * settles from the server's `PAYMENT-RESPONSE`; a request that fails
   * without one leaves the reservation open on purpose.
   */
  fetch(fetch: typeof globalThis.fetch): GuardedFetch {
    return async (input, init) => {
      const { purchase, ...rest } = init ?? {};
      const request = new Request(input, rest);
      if (request.headers.has("PAYMENT-SIGNATURE") || request.headers.has("X-PAYMENT")) {
        throw new Error("Payment already attempted");
      }

      const first = await fetch(request.clone());
      if (first.status !== 402) return first;

      let body: unknown;
      try {
        const text = await first.text();
        if (text) body = JSON.parse(text);
      } catch {
        // A 402 with an unreadable body still carries its terms in the header.
      }
      const paymentRequired = this.#http.getPaymentRequiredResponse((name) => first.headers.get(name), body);
      const requestId = purchase ?? this.idFor(paymentRequired);
      this.#ids.set(paymentRequired, requestId);

      const held = this.#held.get(requestId);
      if (held?.stuck) throw new SpendDuplicateError(held.auth.reservation, held.auth.decision);
      let payload = held?.payload ?? null;
      if (payload === null) {
        try {
          payload = await this.client.createPaymentPayload(paymentRequired);
        } catch (error) {
          throw this.#refusals.get(paymentRequired) ?? error;
        }
      }

      const paid = request.clone();
      for (const [name, value] of Object.entries(this.#http.encodePaymentSignatureHeader(payload))) {
        paid.headers.set(name, value);
      }
      paid.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");
      const sending = this.#held.get(requestId);
      if (sending !== undefined) sending.presented += 1;

      // A failure here is the ambiguous case: the authorization may or may not
      // have reached the facilitator. It stays held, and the next attempt at
      // this purchase presents it again.
      const response = await fetch(paid);
      await this.#http.processPaymentResult(payload, (name) => response.headers.get(name), response.status);
      return response;
    };
  }

  async #beforeSigning(ctx: PaymentCreationContext): Promise<void | { abort: true; reason: string }> {
    const o = this.#o;
    const requestId = this.idFor(ctx.paymentRequired);
    this.#ids.set(ctx.paymentRequired, requestId);
    const terms = ctx.selectedRequirements;

    const amount = readAmount(terms.amount);
    if (amount === null) {
      const reason = `x402 amount ${JSON.stringify(terms.amount)} is not a canonical decimal; refusing to sign for it`;
      this.#refusals.set(ctx.paymentRequired, new Error(reason));
      return { abort: true, reason };
    }

    const auth = await o.guard.authorize({
      requestId,
      account: o.account,
      requester: o.requester,
      asset: o.asset?.(terms) ?? `${terms.network}/${terms.asset}`,
      amount,
      destination: o.destination?.(ctx.paymentRequired, terms) ?? `x402:${hostOf(ctx.paymentRequired.resource.url)}`,
      ...(o.ttlMs === undefined ? {} : { ttlMs: o.ttlMs }),
    });

    if (auth.granted) {
      this.#held.set(requestId, { auth, payload: null, presented: 0, stuck: false });
      return undefined;
    }
    const error =
      auth.refusal === "DENIED" ? new SpendRefusedError(auth.decision, auth.request)
      : auth.refusal === "DUPLICATE" ? new SpendDuplicateError(auth.existing, auth.decision)
      : new SpendMismatchError(auth.existing, auth.detail);
    this.#refusals.set(ctx.paymentRequired, error);
    return { abort: true, reason: error.message };
  }

  async #afterSigning(ctx: PaymentCreatedContext): Promise<void> {
    const requestId = this.#ids.get(ctx.paymentRequired);
    const held = requestId === undefined ? undefined : this.#held.get(requestId);
    if (requestId === undefined || held === undefined) return;
    held.payload = ctx.paymentPayload;
    this.#payloads.set(ctx.paymentPayload, requestId);
  }

  /** The scheme could not sign. Nothing left the process, so the budget comes back. */
  async #signingFailed(ctx: PaymentCreationFailureContext): Promise<void> {
    const requestId = this.#ids.get(ctx.paymentRequired);
    const held = requestId === undefined ? undefined : this.#held.get(requestId);
    if (requestId === undefined || held === undefined || held.payload !== null) return;
    this.#held.delete(requestId);
    await held.auth.reverse();
  }

  /**
   * What the server said happened, mapped onto the ledger:
   *
   * - settled → settle at the amount the facilitator reports, or the terms.
   * - settlement failed → nothing moved; reverse.
   * - a fresh 402 with no settlement → verification failed. On the first
   *   presentation nothing moved; reverse. On a re-presentation it proves
   *   nothing: a facilitator that already settled the nonce refuses it the
   *   same way. Hold, and stop presenting it; reconciliation decides.
   * - anything else (a transport error, a response with no payment header) →
   *   hold. The authorization stays available for the next attempt.
   */
  async #responded(ctx: PaymentResponseContext): Promise<void> {
    const requestId = this.#payloads.get(ctx.paymentPayload);
    const held = requestId === undefined ? undefined : this.#held.get(requestId);
    if (requestId === undefined || held === undefined) return;

    const settle = ctx.settleResponse;
    if (settle !== undefined) {
      this.#held.delete(requestId);
      if (settle.success) {
        const reported = settle.amount === undefined ? null : readAmount(settle.amount);
        await held.auth.settle(reported ?? held.auth.request.amount);
      } else {
        await held.auth.reverse();
      }
      return;
    }
    if (ctx.paymentRequired !== undefined) {
      if (held.presented <= 1) {
        this.#held.delete(requestId);
        await held.auth.reverse();
      } else {
        held.stuck = true;
      }
    }
  }
}

/**
 * Puts the guard in front of an x402 client's signature.
 *
 * The client is returned inside a {@link GuardedX402}: keep using it with any
 * wrapper you already have, or take `.fetch(fetch)` for one that also reuses
 * authorizations on retry.
 */
export function guardX402(client: x402Client, options: GuardX402Options): GuardedX402 {
  return new GuardedX402(client, options);
}

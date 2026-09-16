/**
 * The Event contract.
 *
 * EVENT_MODEL.md §3 and `contracts/Event.md`. The journal treats `payload` as
 * opaque; meaning is assigned by projections. Nothing here may be mutated:
 * Constitution Art. I §2, "history is never mutated".
 */
import type { Hlc } from "./hlc.js";

/** Identifies the append-only lane owned by exactly one device. */
export type LaneId = string;

/** Identifies the payload shape, so readers can upcast forward-only. */
export interface SchemaRef {
  readonly id: string;
  readonly version: number;
}

/** Per-lane hash chaining, giving tamper-evidence (Constitution Art. I §5). */
export interface Integrity {
  /** Hash of the preceding event in this lane; `null` for the lane's first event. */
  readonly previous: string | null;
  /** SHA-256 over this event's canonical encoding, including `previous`. */
  readonly hash: string;
}

/** The immutable atomic unit of history. */
export interface OrbEvent<Payload = unknown> {
  readonly id: string;
  readonly lane: LaneId;
  readonly device: string;
  readonly hlc: Hlc;
  /** Best-effort physical timestamp. Human-facing only; never used for ordering. */
  readonly wallClock: number;
  readonly type: string;
  /** Event ids this event was derived from or reacted to. */
  readonly causes: readonly string[];
  readonly schema: SchemaRef;
  readonly payload: Payload;
  readonly integrity: Integrity;
}

/** What a caller supplies; the journal assigns identity, ordering and integrity. */
export interface EventDraft<Payload = unknown> {
  readonly type: string;
  readonly schema: SchemaRef;
  readonly payload: Payload;
  readonly causes?: readonly string[];
}

/** Raised when an append would violate an append-only or integrity invariant. */
export class JournalIntegrityError extends Error {
  override readonly name = "JournalIntegrityError";
  constructor(message: string, readonly detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
  }
}

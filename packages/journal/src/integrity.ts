/**
 * Tamper-evidence for the journal.
 *
 * Constitution Art. I §5: lanes are hash-chained so that any corruption or
 * rewriting is detectable. The hash covers every field of the event except the
 * hash itself, and commits to the predecessor's hash.
 */
import { createHash } from "node:crypto";
import type { OrbEvent } from "./types.js";
import { JournalIntegrityError } from "./types.js";

/**
 * Deterministic JSON encoding: object keys sorted, no incidental whitespace.
 *
 * Two devices must derive byte-identical encodings for the same event, so
 * insertion order must not matter.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number in event: ${value}`);
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError("undefined is not representable in an event");
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`unsupported value in event: ${typeof value}`);
  }
}

/** The bytes an event commits to. Excludes `integrity.hash`, includes `integrity.previous`. */
export function eventPreimage(event: Omit<OrbEvent, "integrity"> & { previous: string | null }): string {
  return canonicalJson({
    id: event.id,
    lane: event.lane,
    device: event.device,
    hlc: event.hlc,
    wallClock: event.wallClock,
    type: event.type,
    causes: event.causes,
    schema: event.schema,
    payload: event.payload,
    previous: event.previous,
  });
}

export function hashEvent(event: Omit<OrbEvent, "integrity"> & { previous: string | null }): string {
  return createHash("sha256").update(eventPreimage(event), "utf8").digest("hex");
}

/** Recomputes an event's hash and checks it against the recorded one. */
export function verifyEvent(event: OrbEvent): boolean {
  return hashEvent({ ...event, previous: event.integrity.previous }) === event.integrity.hash;
}

/**
 * Verifies a full lane: every hash is self-consistent and every event commits
 * to its predecessor, with strictly increasing HLC.
 *
 * @throws {JournalIntegrityError} naming the first event that fails.
 */
export function verifyLane(events: readonly OrbEvent[]): void {
  let previousHash: string | null = null;
  let previousPhysical = -1;
  let previousCounter = -1;

  for (const [index, event] of events.entries()) {
    if (!verifyEvent(event)) {
      throw new JournalIntegrityError("event hash does not match its contents", {
        eventId: event.id,
        index,
      });
    }
    if (event.integrity.previous !== previousHash) {
      throw new JournalIntegrityError("lane hash chain is broken", {
        eventId: event.id,
        index,
        expectedPrevious: previousHash,
        actualPrevious: event.integrity.previous,
      });
    }
    const goesBackwards =
      event.hlc.physical < previousPhysical ||
      (event.hlc.physical === previousPhysical && event.hlc.counter <= previousCounter);
    if (index > 0 && goesBackwards) {
      throw new JournalIntegrityError("lane HLC is not strictly increasing", {
        eventId: event.id,
        index,
      });
    }

    previousHash = event.integrity.hash;
    previousPhysical = event.hlc.physical;
    previousCounter = event.hlc.counter;
  }
}

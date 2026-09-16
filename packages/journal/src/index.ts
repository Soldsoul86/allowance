/**
 * @allowance/journal — the Event Journal.
 *
 * Orb's single source of truth: append-only, hash-chained, HLC-ordered.
 * Everything else in the runtime is a projection of what passes through here.
 */
export { HybridLogicalClock, HLC_ZERO, compareHlc, encodeHlc, decodeHlc } from "./hlc.js";
export type { Hlc, PhysicalClock } from "./hlc.js";

export { newEventId, isEventId } from "./ids.js";

export type { OrbEvent, EventDraft, LaneId, SchemaRef, Integrity } from "./types.js";
export { JournalIntegrityError } from "./types.js";

export { canonicalJson, eventPreimage, hashEvent, verifyEvent, verifyLane } from "./integrity.js";

export type { JournalStore } from "./store.js";
export { MemoryJournalStore } from "./store.js";
export { FileJournalStore } from "./file-store.js";

export { Journal } from "./journal.js";
export type { JournalOptions, JournalListener } from "./journal.js";

export { compareEventOrder, orderEvents, fold, replay } from "./replay.js";
export type { Projection } from "./replay.js";

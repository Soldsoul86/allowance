/**
 * @allowance/journal — an append-only, hash-chained, HLC-ordered event journal.
 *
 * A single source of truth. Everything else is a projection of what passes
 * through here, and may be discarded and rebuilt.
 */
export { HybridLogicalClock, HLC_ZERO, compareHlc, encodeHlc, decodeHlc } from "./hlc.js";
export type { Hlc, PhysicalClock } from "./hlc.js";

export { newEventId, isEventId } from "./ids.js";

export type { JournalEvent, EventDraft, LaneId, SchemaRef, Integrity } from "./types.js";
export { JournalIntegrityError } from "./types.js";

export { canonicalJson, eventPreimage, hashEvent, verifyEvent, verifyLane } from "./integrity.js";

export type { JournalStore } from "./store.js";
export { MemoryJournalStore } from "./store.js";
export { FileJournalStore } from "./file-store.js";

export { Journal } from "./journal.js";
export type { JournalOptions, JournalListener } from "./journal.js";

export { compareEventOrder, orderEvents, fold, replay } from "./replay.js";
export type { Projection } from "./replay.js";

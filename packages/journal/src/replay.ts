/**
 * Replay — folding the union of all lanes into a derived view.
 *
 * Order is derived here, on read, and never stored. That is what keeps devices
 * equal peers: no device is authoritative.
 */
import { compareHlc } from "./hlc.js";
import type { JournalEvent } from "./types.js";
import type { Journal } from "./journal.js";

/**
 * The public total order: `(hlc, lane)`.
 *
 * The lane tiebreak makes the order identical on every device even when two
 * lanes produce the same HLC.
 */
export function compareEventOrder(a: JournalEvent, b: JournalEvent): number {
  const byHlc = compareHlc(a.hlc, b.hlc);
  if (byHlc !== 0) return byHlc;
  if (a.lane !== b.lane) return a.lane < b.lane ? -1 : 1;
  // Same lane and same HLC cannot happen in a valid journal; ordering by id
  // keeps the comparator total rather than letting sort order go undefined.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function orderEvents(events: readonly JournalEvent[]): readonly JournalEvent[] {
  return [...events].sort(compareEventOrder);
}

/** A pure fold from history to derived state. */
export type Projection<State> = (state: State, event: JournalEvent) => State;

/** Folds `events` in public order through `project`. */
export function fold<State>(
  events: readonly JournalEvent[],
  initial: State,
  project: Projection<State>,
): State {
  let state = initial;
  for (const event of orderEvents(events)) state = project(state, event);
  return state;
}

/** Rebuilds a projection from the whole journal. */
export async function replay<State>(
  journal: Journal,
  initial: State,
  project: Projection<State>,
): Promise<State> {
  return fold(await journal.readAll(), initial, project);
}

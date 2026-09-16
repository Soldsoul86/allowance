/**
 * Replay — folding the union of all lanes into a derived view.
 *
 * EVENT_MODEL.md §7. Order is derived here, on read, and never stored: that is
 * what keeps devices equal peers (Constitution Art. IV §17).
 */
import { compareHlc } from "./hlc.js";
import type { OrbEvent } from "./types.js";
import type { Journal } from "./journal.js";

/**
 * The public total order: `(hlc, lane)`.
 *
 * The lane tiebreak makes the order identical on every device even when two
 * lanes produce the same HLC.
 */
export function compareEventOrder(a: OrbEvent, b: OrbEvent): number {
  const byHlc = compareHlc(a.hlc, b.hlc);
  if (byHlc !== 0) return byHlc;
  if (a.lane !== b.lane) return a.lane < b.lane ? -1 : 1;
  // Same lane and same HLC cannot happen in a valid journal; ordering by id
  // keeps the comparator total rather than letting sort order go undefined.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function orderEvents(events: readonly OrbEvent[]): readonly OrbEvent[] {
  return [...events].sort(compareEventOrder);
}

/** A pure fold from history to derived state. */
export type Projection<State> = (state: State, event: OrbEvent) => State;

/** Folds `events` in public order through `project`. */
export function fold<State>(
  events: readonly OrbEvent[],
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

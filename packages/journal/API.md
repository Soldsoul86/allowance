# API — `@allowance/journal`

## `Journal`

```ts
static open(options: JournalOptions): Promise<Journal>
```
Opens a journal over a store, restoring the local lane's head and clock so a
restarted process continues the same chain rather than forking it. Verifies the
local lane's integrity on open.

```ts
append(drafts: readonly EventDraft[]): Promise<readonly OrbEvent[]>
appendOne<P>(draft: EventDraft<P>): Promise<OrbEvent<P>>
```
Appends to the local lane as one atomic, durable batch. Concurrent callers are
serialised. Assigns `id`, `hlc`, `wallClock` and `integrity`.

```ts
replicate(lane: LaneId, events: readonly OrbEvent[]): Promise<void>
```
Adopts events from a foreign lane. Idempotent — already-known events are
skipped. Throws `JournalIntegrityError` for the local lane, for events that do
not belong to the named lane, and for a batch that breaks the chain.

```ts
readAll(): Promise<readonly OrbEvent[]>
readLane(lane: LaneId): Promise<readonly OrbEvent[]>
lanes(): Promise<readonly LaneId[]>
verify(): Promise<void>
subscribe(listener: JournalListener): () => void
close(): Promise<void>
get clock(): Hlc
```

## Ordering and replay

```ts
compareEventOrder(a: OrbEvent, b: OrbEvent): number   // (hlc, lane)
orderEvents(events: readonly OrbEvent[]): readonly OrbEvent[]
fold<S>(events: readonly OrbEvent[], initial: S, project: Projection<S>): S
replay<S>(journal: Journal, initial: S, project: Projection<S>): Promise<S>
```

## Hybrid Logical Clocks

```ts
class HybridLogicalClock {
  constructor(now: PhysicalClock, initial?: Hlc)
  tick(): Hlc                 // local append
  merge(incoming: Hlc): Hlc   // replicated event
  get last(): Hlc
}
compareHlc(a: Hlc, b: Hlc): number
encodeHlc(hlc: Hlc): string   // fixed-width, lexicographically ordered
decodeHlc(encoded: string): Hlc
```

## Integrity

```ts
canonicalJson(value: unknown): string
hashEvent(event: Omit<OrbEvent, "integrity"> & { previous: string | null }): string
verifyEvent(event: OrbEvent): boolean
verifyLane(events: readonly OrbEvent[]): void   // throws JournalIntegrityError
```

## Stores

```ts
interface JournalStore {
  append(lane: LaneId, events: readonly OrbEvent[]): Promise<void>;
  read(lane: LaneId): Promise<readonly OrbEvent[]>;
  lanes(): Promise<readonly LaneId[]>;
  close(): Promise<void>;
}

class MemoryJournalStore implements JournalStore {}
class FileJournalStore implements JournalStore {
  static open(directory: string): Promise<FileJournalStore>
}
```

`append` must be atomic per call and durable before it resolves.

## Types

```ts
interface OrbEvent<Payload = unknown> {
  readonly id: string;              // ULID-class, never reused
  readonly lane: LaneId;
  readonly device: string;
  readonly hlc: Hlc;
  readonly wallClock: number;       // human-facing only; never used for ordering
  readonly type: string;
  readonly causes: readonly string[];
  readonly schema: SchemaRef;
  readonly payload: Payload;        // opaque to the journal
  readonly integrity: Integrity;
}

interface EventDraft<Payload = unknown> {
  readonly type: string;
  readonly schema: SchemaRef;
  readonly payload: Payload;
  readonly causes?: readonly string[];
}
```

## Errors

`JournalIntegrityError` — a broken hash chain, a non-increasing HLC within a
lane, a write to a foreign lane, or a mismatched lane on replication. Carries a
`detail` object naming the offending event.

# Design — `@allowance/journal`

> Governed by `CONSTITUTION.md` Article I (History), Article IV (Distribution)
> and `docs/EVENT_MODEL.md`. This document explains the *why*; the laws
> themselves are not restated here.

## 1. The shape of the problem

Orb is multi-writer by construction: every device is an equal peer and none is
authoritative (Art. IV §14). That rules out the usual answer — a single
append point with a monotonic sequence number — because a single append point
*is* an authority.

The structure that survives this is a **multi-lane, single-writer-per-lane
log**. Each device owns exactly one lane and appends only to it; other lanes
arrive by replication and are read-only. The global journal is the set union of
lanes, which makes merging trivially associative and commutative: there is
nothing to reconcile, because no two devices ever write the same lane.

## 2. Ordering is derived, never stored

Physical clocks across devices disagree. Pure logical clocks lose human-
meaningful time. Hybrid Logical Clocks give both: a logical counter bounded
close to physical time, such that if A causally precedes B then `A.hlc < B.hlc`.

The public order is `(hlc, lane)` — HLC first, lane id as a deterministic
tiebreak — computed **on read**. Persisting a global order would reintroduce the
authority we just removed, so we do not.

`compareEventOrder` also breaks a same-lane, same-HLC tie by event id. That
case cannot occur in a valid journal; the tiebreak exists so the comparator is
total rather than leaving `Array.sort` undefined on corrupt input.

## 3. Integrity

Each event commits to its predecessor's hash, so a lane is a chain. Removing,
reordering or editing an event breaks it detectably. The hash covers a
**canonical** JSON encoding — keys sorted, no incidental whitespace — because
two devices must derive byte-identical encodings for the same event, and
JavaScript object key order is insertion order.

`canonicalJson` refuses `NaN`, `Infinity`, `undefined` and functions. These are
not representable in a way that survives a round trip, and a value that changes
on replay is worse than one that fails to append.

## 4. Concurrency

`Journal.append` serialises through a promise chain. Identity, HLC and hash
must advance atomically: two concurrent appends that each read the same head
would produce a fork, not a chain. The chain is kept alive across failures
(`.catch(() => undefined)`) so that one failed append does not strand every
later one.

## 5. Durability, and what a crash looks like

`FileJournalStore` writes newline-delimited JSON and `fsync`s before resolving,
so a resolved append has survived the process and the machine.

A crash mid-write leaves a **torn final line**. On read that line is discarded,
not repaired: a partial line was never a complete event, and Art. I §2 forbids
mutating history in any case. An unparsable line that is *not* last is genuine
corruption and throws.

Lane ids become filenames, so they are validated against an allowlist pattern
before they touch the filesystem.

## 6. What this deliberately does not do

- **No encryption at rest.** That is `STORAGE.md` / `SECURITY.md` and a later
  phase. The `JournalStore` port is where it will live.
- **No replication protocol.** `replicate()` accepts events a peer hands over;
  how they get there is `SYNC_PROTOCOL.md`.
- **No indexes or queries.** Projections are folds. When a fold becomes too
  slow, the answer is a cached projection rebuilt from the journal — never a
  second source of truth (Art. IX §33).
- **No compaction.** History is not garbage.

## 7. Trade-offs taken

| Decision | Cost | Why anyway |
| --- | --- | --- |
| `fsync` on every append | Throughput | A trade-execution audit trail that loses its last record is not an audit trail. Batching at the sink amortises it. |
| Full replay for every projection | O(history) | Correctness and simplicity first. A cached projection is a later optimisation, not an architectural change. |
| JSON rather than a binary encoding | Size | Inspectable by hand, and forward-compatible through `schema.version`. |
| SHA-256 per event | CPU | Negligible next to the fsync it accompanies. |

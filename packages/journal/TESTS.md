# Tests — `@allowance/journal`

`npm test --workspace @allowance/journal`

26 tests across 8 suites.

## Covered

**Hybrid Logical Clocks**
- Counter advances within one physical millisecond; resets when time moves on.
- `merge` carries a remote clock that is ahead of local physical time, so a
  local append never appears to precede something already known.
- Tie-breaking takes the greater counter.
- Encoding is fixed-width, lexicographically ordered, and round-trips.

**Identifiers** — uniqueness across 2,000 generations at a single timestamp,
time-sortability, and well-formedness.

**Canonical encoding** — independent of key insertion order; rejects `NaN`,
`Infinity` and functions.

**Append** — stamps identity, lane, device, HLC and chain; batches are atomic
and consecutively chained; **50 concurrent appends produce one unbroken chain
with no repeated HLC**; subscribers fire after durability.

**Integrity** — detects a mutated payload, a removed event, and a reordered
lane.

**Lanes and replication** — a device refuses writes to its own lane;
replication merges a peer's clock; replication is idempotent; a batch whose
events do not match the named lane is refused.

**Ordering and replay** — public order is `(hlc, lane)` and identical
regardless of input order; replay folds the union of lanes; a projection can be
discarded and rebuilt identically.

**Durability** — a file-backed journal survives a restart and continues its
chain; **a torn trailing line from a crash is discarded, not repaired**; a lane
id that would escape the journal directory is refused.

## Not covered, deliberately

- **Encryption at rest** — not implemented yet (`STORAGE.md`, `SECURITY.md`).
- **Replication transport** — `replicate()` is tested; how events reach a peer
  is `SYNC_PROTOCOL.md` and a later phase.
- **Byzantine peers** — a replicated lane is verified for chain integrity, but
  a peer that signs a *valid* chain of false statements is an identity and
  trust problem, not a journal one.
- **Performance** — no benchmarks. `fsync`-per-append is a deliberate
  correctness choice; if it becomes a bottleneck the sink batches.
- **Clock adversaries** — HLC tolerates skew, not a peer deliberately
  reporting a far-future timestamp. That is a trust boundary question.

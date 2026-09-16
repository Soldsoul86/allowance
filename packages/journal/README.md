# `@allowance/journal`

The Event Journal — Orb's single source of truth.

Append-only, hash-chained, HLC-ordered history. Everything else in the runtime
is a projection of what passes through here, and any projection can be deleted
and rebuilt by replaying it.

This is the first executable component of Orb (ROADMAP Phase 4), and the
substrate the Hyperliquid trade executor records its audit trail on.

## Quick start

```ts
import { Journal, FileJournalStore, replay } from "@allowance/journal";

const store = await FileJournalStore.open(".orb-local/journal");
const journal = await Journal.open({ lane: "mac", device: "mac-01", store });

await journal.appendOne({
  type: "note",
  schema: { id: "example.note", version: 1 },
  payload: { text: "hello" },
});

// Any derived view is a fold over history.
const count = await replay(journal, 0, (n) => n + 1);
```

## What it guarantees

| Guarantee | Where |
| --- | --- |
| Appends only; history is never mutated | `journal.ts` |
| One writer per lane; foreign lanes are replicated read-only | `journal.ts` |
| Tamper-evidence through a per-lane hash chain | `integrity.ts` |
| Causal ordering across unsynchronised clocks | `hlc.ts` |
| Public order derived on read, never stored | `replay.ts` |
| Durability across process and machine restart | `file-store.ts` |

## Documents

- [`DESIGN.md`](DESIGN.md) — why it is built this way.
- [`API.md`](API.md) — the public surface.
- [`TESTS.md`](TESTS.md) — what is covered and what is not.

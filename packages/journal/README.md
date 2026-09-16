# @soldsoul86/journal

An append-only, hash-chained, HLC-ordered event journal. Zero dependencies.

```bash
npm install @soldsoul86/journal
```

```ts
import { Journal, MemoryJournalStore } from "@soldsoul86/journal";

const journal = await Journal.open({
  store: new MemoryJournalStore(),
  device: "laptop",
  lane: "laptop",
});

await journal.appendOne({
  type: "note.written",
  schema: { id: "note", version: 1 },
  payload: { text: "hello" },
});
const events = await journal.readAll();
```

**History is never mutated.** Events are never edited, reordered or deleted.
Everything else is a projection of this and may be discarded and rebuilt.

**Tamper-evident.** Each lane is hash-chained, so corruption or rewriting is
detectable rather than silent.

**No authoritative device.** Each device writes only its own lane and
replicates foreign ones; merge is a set union of immutable lanes and never
rewrites history.

**Global order is derived on read, never stored** — computed from Hybrid
Logical Clocks. Persisting an order would reintroduce an authority.

Stores are ports: `MemoryJournalStore` and `FileJournalStore` ship; bring your
own for anything else.

Ships without a test suite. `npm run check` at the repository root exercises
the claims above against the built output.

Apache-2.0.

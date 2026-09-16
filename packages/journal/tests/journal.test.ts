/** Tests for the Event Journal: append-only, hash-chained, HLC-ordered, replayable. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Journal,
  MemoryJournalStore,
  FileJournalStore,
  HybridLogicalClock,
  compareHlc,
  encodeHlc,
  decodeHlc,
  canonicalJson,
  verifyEvent,
  verifyLane,
  orderEvents,
  replay,
  newEventId,
  isEventId,
  JournalIntegrityError,
  type OrbEvent,
  type EventDraft,
} from "../src/index.js";

const SCHEMA = { id: "test.note", version: 1 } as const;
const note = (text: string): EventDraft<{ text: string }> => ({
  type: "note",
  schema: SCHEMA,
  payload: { text },
});

/** A clock that advances only when told, so every test is deterministic. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("hybrid logical clock", () => {
  test("advances the counter within one physical millisecond", () => {
    const clock = fakeClock();
    const hlc = new HybridLogicalClock(clock.now);
    assert.deepEqual(hlc.tick(), { physical: clock.now(), counter: 0 });
    assert.deepEqual(hlc.tick(), { physical: clock.now(), counter: 1 });
    assert.deepEqual(hlc.tick(), { physical: clock.now(), counter: 2 });
  });

  test("resets the counter when physical time moves forward", () => {
    const clock = fakeClock();
    const hlc = new HybridLogicalClock(clock.now);
    hlc.tick();
    clock.advance(5);
    assert.deepEqual(hlc.tick(), { physical: clock.now(), counter: 0 });
  });

  test("merge carries a remote clock that is ahead of local physical time", () => {
    const clock = fakeClock();
    const hlc = new HybridLogicalClock(clock.now);
    const remote = { physical: clock.now() + 10_000, counter: 3 };
    assert.deepEqual(hlc.merge(remote), { physical: remote.physical, counter: 4 });
    // The next local tick must not go backwards behind what we already know.
    assert.equal(hlc.tick().physical, remote.physical);
  });

  test("merge breaks ties by taking the greater counter", () => {
    const clock = fakeClock();
    const hlc = new HybridLogicalClock(clock.now);
    hlc.tick();
    hlc.tick();
    const merged = hlc.merge({ physical: clock.now(), counter: 7 });
    assert.deepEqual(merged, { physical: clock.now(), counter: 8 });
  });

  test("encoding is lexicographically ordered and round-trips", () => {
    const a = { physical: 9, counter: 1 };
    const b = { physical: 10, counter: 0 };
    assert.ok(encodeHlc(a) < encodeHlc(b));
    assert.ok(compareHlc(a, b) < 0);
    assert.deepEqual(decodeHlc(encodeHlc(a)), a);
  });
});

describe("event identifiers", () => {
  test("are unique, sortable by time and well-formed", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newEventId(1_700_000_000_000)));
    assert.equal(ids.size, 2000);
    assert.ok([...ids].every(isEventId));
    assert.ok(newEventId(1_700_000_000_000) < newEventId(1_700_000_001_000));
  });
});

describe("canonical encoding", () => {
  test("is independent of key insertion order", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.equal(canonicalJson({ a: { z: 1, y: 2 } }), '{"a":{"y":2,"z":1}}');
  });

  test("rejects values that cannot be replayed faithfully", () => {
    assert.throws(() => canonicalJson({ a: Number.NaN }), TypeError);
    assert.throws(() => canonicalJson({ a: Number.POSITIVE_INFINITY }), TypeError);
    assert.throws(() => canonicalJson(() => 1), TypeError);
  });
});

describe("append", () => {
  test("stamps identity, lane, device, HLC and a hash chain", async () => {
    const clock = fakeClock();
    const journal = await Journal.open({ lane: "mac", device: "mac-01", now: clock.now });

    const first = await journal.appendOne(note("one"));
    const second = await journal.appendOne(note("two"));

    assert.equal(first.lane, "mac");
    assert.equal(first.device, "mac-01");
    assert.equal(first.integrity.previous, null);
    assert.equal(second.integrity.previous, first.integrity.hash);
    assert.ok(compareHlc(first.hlc, second.hlc) < 0);
    assert.ok(verifyEvent(first) && verifyEvent(second));
  });

  test("an appended batch is atomic and consecutively chained", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });
    const events = await journal.append([note("a"), note("b"), note("c")]);

    assert.equal(events.length, 3);
    verifyLane(events);
    assert.equal(events[1]!.integrity.previous, events[0]!.integrity.hash);
    assert.equal(events[2]!.integrity.previous, events[1]!.integrity.hash);
  });

  test("concurrent appends are serialised into one unbroken chain", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });

    await Promise.all(Array.from({ length: 50 }, (_, i) => journal.appendOne(note(`n${i}`))));

    const lane = await journal.readLane("mac");
    assert.equal(lane.length, 50);
    verifyLane(lane); // would throw on any interleaved hash or repeated HLC
    assert.equal(new Set(lane.map((e) => e.id)).size, 50);
  });

  test("notifies subscribers after events are durable", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });
    const seen: string[] = [];
    const unsubscribe = journal.subscribe((events) => seen.push(...events.map((e) => e.type)));

    await journal.appendOne(note("a"));
    unsubscribe();
    await journal.appendOne(note("b"));

    assert.deepEqual(seen, ["note"]);
  });
});

describe("integrity", () => {
  test("detects a mutated payload", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });
    const event = await journal.appendOne(note("original"));

    const tampered = { ...event, payload: { text: "rewritten" } } as OrbEvent;
    assert.equal(verifyEvent(tampered), false);
    assert.throws(() => verifyLane([tampered]), JournalIntegrityError);
  });

  test("detects a removed event", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });
    const events = await journal.append([note("a"), note("b"), note("c")]);
    assert.throws(() => verifyLane([events[0]!, events[2]!]), JournalIntegrityError);
  });

  test("detects a reordered lane", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });
    const events = await journal.append([note("a"), note("b")]);
    assert.throws(() => verifyLane([events[1]!, events[0]!]), JournalIntegrityError);
  });
});

describe("lanes and replication", () => {
  test("a device refuses writes to its own lane from outside", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });
    const event = await journal.appendOne(note("mine"));
    await assert.rejects(() => journal.replicate("mac", [event]), JournalIntegrityError);
  });

  test("replicates a foreign lane and merges its clock", async () => {
    const clock = fakeClock();
    const pixel = await Journal.open({ lane: "pixel", device: "pixel-01", now: () => clock.now() + 60_000 });
    const foreign = await pixel.append([note("p1"), note("p2")]);

    const mac = await Journal.open({ lane: "mac", device: "mac-01", now: clock.now });
    await mac.appendOne(note("m1"));
    await mac.replicate("pixel", foreign);

    assert.deepEqual([...(await mac.lanes())], ["mac", "pixel"]);
    assert.equal((await mac.readLane("pixel")).length, 2);
    // The local clock now knows about the future-dated peer.
    assert.ok(compareHlc(mac.clock, foreign[1]!.hlc) >= 0);
  });

  test("replication is idempotent — a replayed batch adds nothing", async () => {
    const pixel = await Journal.open({ lane: "pixel", device: "pixel-01" });
    const foreign = await pixel.append([note("p1"), note("p2")]);

    const mac = await Journal.open({ lane: "mac", device: "mac-01" });
    await mac.replicate("pixel", foreign);
    await mac.replicate("pixel", foreign);
    await mac.replicate("pixel", [...foreign, ...foreign]);

    assert.equal((await mac.readLane("pixel")).length, 2);
  });

  test("rejects a batch whose events do not belong to the named lane", async () => {
    const pixel = await Journal.open({ lane: "pixel", device: "pixel-01" });
    const foreign = await pixel.append([note("p1")]);
    const mac = await Journal.open({ lane: "mac", device: "mac-01" });
    await assert.rejects(() => mac.replicate("watch", foreign), JournalIntegrityError);
  });
});

describe("ordering and replay", () => {
  test("public order is (hlc, lane) and identical regardless of input order", async () => {
    const clock = fakeClock();
    const mac = await Journal.open({ lane: "mac", device: "mac-01", now: clock.now });
    const pixel = await Journal.open({ lane: "pixel", device: "pixel-01", now: clock.now });

    // Same physical millisecond on both devices: the lane tiebreak decides.
    const m = await mac.appendOne(note("m"));
    const p = await pixel.appendOne(note("p"));

    const forwards = orderEvents([m, p]).map((e) => e.lane);
    const backwards = orderEvents([p, m]).map((e) => e.lane);
    assert.deepEqual(forwards, ["mac", "pixel"]);
    assert.deepEqual(forwards, backwards);
  });

  test("replay rebuilds a projection from the union of all lanes", async () => {
    const clock = fakeClock();
    const pixel = await Journal.open({ lane: "pixel", device: "pixel-01", now: clock.now });
    const p1 = await pixel.appendOne(note("p1"));
    clock.advance(10);

    const mac = await Journal.open({ lane: "mac", device: "mac-01", now: clock.now });
    await mac.replicate("pixel", [p1]);
    await mac.appendOne(note("m1"));
    clock.advance(10);
    await mac.appendOne(note("m2"));

    const texts = await replay(mac, [] as string[], (state, event) => [
      ...state,
      (event.payload as { text: string }).text,
    ]);
    assert.deepEqual(texts, ["p1", "m1", "m2"]);
  });

  test("a projection can be discarded and rebuilt identically", async () => {
    const journal = await Journal.open({ lane: "mac", device: "mac-01" });
    await journal.append([note("a"), note("b"), note("c")]);

    const count = (events: readonly OrbEvent[]) => events.length;
    const first = await replay(journal, 0, (n) => n + 1);
    const second = await replay(journal, 0, (n) => n + 1);
    assert.equal(first, second);
    assert.equal(first, count(await journal.readAll()));
  });
});

describe("durability", () => {
  test("a file-backed journal survives a restart and continues its chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orb-journal-"));
    try {
      const store = await FileJournalStore.open(dir);
      const journal = await Journal.open({ lane: "mac", device: "mac-01", store });
      const before = await journal.append([note("a"), note("b")]);
      await journal.close();

      const reopenedStore = await FileJournalStore.open(dir);
      const reopened = await Journal.open({ lane: "mac", device: "mac-01", store: reopenedStore });
      const after = await reopened.appendOne(note("c"));

      assert.equal(after.integrity.previous, before[1]!.integrity.hash);
      const lane = await reopened.readLane("mac");
      assert.equal(lane.length, 3);
      verifyLane(lane);
      await reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a torn trailing line from a crash is discarded, not repaired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orb-journal-"));
    try {
      const store = await FileJournalStore.open(dir);
      const journal = await Journal.open({ lane: "mac", device: "mac-01", store });
      await journal.append([note("a"), note("b")]);
      await journal.close();

      const file = join(dir, "mac.lane.jsonl");
      await writeFile(file, (await readFile(file, "utf8")) + '{"id":"TORN","lane":"ma');

      const recoveredStore = await FileJournalStore.open(dir);
      const recovered = await Journal.open({ lane: "mac", device: "mac-01", store: recoveredStore });
      assert.equal((await recovered.readLane("mac")).length, 2);
      await recovered.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a lane id that would escape the journal directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orb-journal-"));
    try {
      const store = await FileJournalStore.open(dir);
      await assert.rejects(() => store.append("../escape", []).then(() => store.read("../escape")), TypeError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a memory store keeps lanes separate", async () => {
    const store = new MemoryJournalStore();
    const journal = await Journal.open({ lane: "mac", device: "mac-01", store });
    await journal.append([note("a"), note("b")]);
    assert.equal(store.size, 2);
    assert.deepEqual([...(await store.lanes())], ["mac"]);
  });
});

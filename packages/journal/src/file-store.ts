/**
 * Append-only file store: one newline-delimited JSON file per lane.
 *
 * Durability matters here because crash recovery reads this back (§12 of the
 * executor's requirements). Every append is `write` + `fsync` before resolving,
 * so a resolved append survives process and machine death.
 *
 * A torn trailing line — the signature of a crash mid-write — is discarded on
 * read rather than repaired, because Art. I §2 forbids mutating history and a
 * partial line was never a complete event.
 */
import { open, mkdir, readFile, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { JournalStore } from "./store.js";
import type { LaneId, OrbEvent } from "./types.js";

const LANE_FILE_SUFFIX = ".lane.jsonl";

/** Lane ids become filenames, so they must not escape the journal directory. */
function laneFile(directory: string, lane: LaneId): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(lane) || lane === "." || lane === "..") {
    throw new TypeError(`unsafe lane id: ${JSON.stringify(lane)}`);
  }
  return join(directory, `${lane}${LANE_FILE_SUFFIX}`);
}

export class FileJournalStore implements JournalStore {
  readonly #directory: string;
  readonly #handles = new Map<LaneId, FileHandle>();
  /** Serialises appends per lane so concurrent callers cannot interleave writes. */
  readonly #writeQueues = new Map<LaneId, Promise<void>>();
  #closed = false;

  private constructor(directory: string) {
    this.#directory = directory;
  }

  static async open(directory: string): Promise<FileJournalStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new FileJournalStore(directory);
  }

  async #handle(lane: LaneId): Promise<FileHandle> {
    const existing = this.#handles.get(lane);
    if (existing) return existing;
    const handle = await open(laneFile(this.#directory, lane), "a", 0o600);
    this.#handles.set(lane, handle);
    return handle;
  }

  async append(lane: LaneId, events: readonly OrbEvent[]): Promise<void> {
    if (this.#closed) throw new Error("journal store is closed");
    if (events.length === 0) return;

    const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const previous = this.#writeQueues.get(lane) ?? Promise.resolve();
    const next = previous.then(async () => {
      const handle = await this.#handle(lane);
      await handle.write(body);
      await handle.sync();
    });

    // Keep the chain alive even when one append fails, so later appends still
    // serialise behind it rather than racing.
    this.#writeQueues.set(lane, next.catch(() => undefined));
    await next;
  }

  async read(lane: LaneId): Promise<readonly OrbEvent[]> {
    let text: string;
    try {
      text = await readFile(laneFile(this.#directory, lane), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const events: OrbEvent[] = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        events.push(JSON.parse(line) as OrbEvent);
      } catch {
        // A torn final line is a crash artefact, not history. Anything earlier
        // being unparsable is corruption, and must surface.
        if (!text.endsWith(line)) throw new Error(`corrupt journal line in lane ${lane}`);
      }
    }
    return events;
  }

  async lanes(): Promise<readonly LaneId[]> {
    const entries = await readdir(this.#directory).catch(() => [] as string[]);
    return entries
      .filter((name) => name.endsWith(LANE_FILE_SUFFIX))
      .map((name) => name.slice(0, -LANE_FILE_SUFFIX.length))
      .sort();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#writeQueues.values()]);
    await Promise.all([...this.#handles.values()].map((handle) => handle.close()));
    this.#handles.clear();
  }
}

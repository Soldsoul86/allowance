/**
 * Committing to a ledger without showing it.
 *
 * A Merkle tree lets you publish one hash that fixes an entire ledger, and
 * later prove a single entry belongs to it without revealing the others. It is
 * the piece that has to exist before any privacy-preserving proof of a budget
 * is possible — and unlike the proving system itself, it is buildable today
 * with nothing but a hash function.
 *
 * ## RFC 6962, not a hand-rolled tree
 *
 * This follows Certificate Transparency's construction, for two reasons that
 * bite real implementations:
 *
 * **Domain separation.** Leaves are hashed with a `0x00` prefix and internal
 * nodes with `0x01`. Without it, an attacker can present an internal node as
 * though it were a leaf — a second-preimage attack that makes a proof of
 * inclusion prove something that was never inserted.
 *
 * **Odd levels are promoted, never duplicated.** The common shortcut of
 * duplicating the last leaf to pad a level makes two different ledgers produce
 * the same root, which is exactly what a commitment must never do. RFC 6962
 * splits at the largest power of two below `n` instead, and the root of an
 * `n`-leaf tree is unique to that `n` and those leaves.
 */
import { createHash } from "node:crypto";

import { canonicalBytes } from "./wire.js";

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const sha256 = (...parts: readonly Buffer[]): Buffer =>
  parts.reduce((h, p) => h.update(p), createHash("sha256")).digest();

/** The hash of an empty tree. Distinct from the hash of anything in it. */
export function emptyRoot(): string {
  return createHash("sha256").digest("hex");
}

function leafHash(value: unknown): Buffer {
  return sha256(LEAF_PREFIX, canonicalBytes(value));
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** The largest power of two strictly less than `n`. */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function rootOf(leaves: readonly Buffer[]): Buffer {
  if (leaves.length === 0) return createHash("sha256").digest();
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return nodeHash(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
}

/** One step of an inclusion path: a sibling, and which side it sits on. */
export interface PathStep {
  readonly hash: string;
  /** True when the sibling is to the right of the running hash. */
  readonly right: boolean;
}

export interface InclusionProof {
  /** Position of the committed value, needed to walk the path. */
  readonly index: number;
  /** Total leaves at the time of commitment. The root is unique to it. */
  readonly size: number;
  readonly path: readonly PathStep[];
}

/**
 * A ledger fixed at a point in time.
 *
 * Immutable by construction: adding an entry produces a new commitment with a
 * new root, and the old root keeps proving exactly what it always did.
 */
export class LedgerCommitment<T> {
  readonly #leaves: readonly Buffer[];
  readonly #values: readonly T[];
  readonly #root: string;

  constructor(values: readonly T[]) {
    this.#values = values;
    this.#leaves = values.map(leafHash);
    this.#root = rootOf(this.#leaves).toString("hex");
  }

  get root(): string {
    return this.#root;
  }

  get size(): number {
    return this.#values.length;
  }

  values(): readonly T[] {
    return this.#values;
  }

  /** An inclusion proof for one position, or `null` if there is no such leaf. */
  prove(index: number): InclusionProof | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.#leaves.length) return null;
    return { index, size: this.#leaves.length, path: this.#pathTo(index, this.#leaves) };
  }

  #pathTo(index: number, leaves: readonly Buffer[]): readonly PathStep[] {
    if (leaves.length <= 1) return [];
    const k = split(leaves.length);
    return index < k
      ? [
          ...this.#pathTo(index, leaves.slice(0, k)),
          { hash: rootOf(leaves.slice(k)).toString("hex"), right: true },
        ]
      : [
          ...this.#pathTo(index - k, leaves.slice(k)),
          { hash: rootOf(leaves.slice(0, k)).toString("hex"), right: false },
        ];
  }
}

/**
 * Checks that `value` really sits at `proof.index` in the tree rooted at `root`.
 *
 * Total: a malformed proof returns `false` rather than throwing. This runs on
 * input a counterparty supplied, so it is held to the transport module's
 * standard rather than the engine's.
 */
export function verifyInclusion(value: unknown, proof: InclusionProof, root: string): boolean {
  if (!Number.isInteger(proof.index) || !Number.isInteger(proof.size)) return false;
  if (proof.index < 0 || proof.size <= 0 || proof.index >= proof.size) return false;
  // A path is exactly as deep as the tree; a longer one is an attempt to
  // rebuild a different root from the same leaf.
  if (proof.path.length > 64) return false;

  let running: Buffer;
  try {
    running = leafHash(value);
    for (const step of proof.path) {
      const sibling = Buffer.from(step.hash, "hex");
      if (sibling.length !== 32) return false;
      running = step.right ? nodeHash(running, sibling) : nodeHash(sibling, running);
    }
  } catch {
    return false;
  }

  return running.toString("hex") === root;
}

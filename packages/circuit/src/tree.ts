/**
 * A Poseidon Merkle tree, built to match the circuit exactly.
 *
 * `@soldsoul86/policy` commits with SHA-256, which is right for a commitment
 * people verify on a CPU and wrong for one verified inside a circuit: a
 * SHA-256 compression is tens of thousands of constraints, and a 32-leaf tree
 * would need hundreds of them. Poseidon is designed for the field and costs
 * a couple of hundred.
 *
 * So the tree is rebuilt here rather than reused, and the two must agree on
 * *shape* even though they disagree on hash. The circuit is the specification:
 *
 * - the tree is **perfect** — exactly `2^depth` leaves, zero-filled;
 * - a leaf is `Poseidon(account, asset, index, total)`, carrying its own key
 *   so it cannot be lifted into another commitment;
 * - a node is `Poseidon(left, right)`;
 * - position `i`'s path directions are the bits of `i`, which are constants
 *   in the circuit and therefore not something a prover can choose.
 *
 * That last property is why completeness needs no separate check here: every
 * position exists, and each is verified where it sits.
 */
import { buildPoseidon } from "circomlibjs";

export interface PoseidonHasher {
  hash(inputs: readonly bigint[]): bigint;
}

/** Loads the hasher. Async once, then reusable — the WASM init is not free. */
export async function loadPoseidon(): Promise<PoseidonHasher> {
  const poseidon = await buildPoseidon();
  return {
    hash(inputs) {
      return poseidon.F.toObject(poseidon(inputs)) as bigint;
    },
  };
}

export interface LeafKey {
  readonly account: bigint;
  readonly asset: bigint;
  readonly baseIndex: bigint;
}

export class PoseidonBucketTree {
  readonly depth: number;
  readonly leafCount: number;
  readonly #totals: readonly bigint[];
  readonly #levels: bigint[][];

  constructor(hasher: PoseidonHasher, key: LeafKey, totals: readonly bigint[], depth: number) {
    const leafCount = 1 << depth;
    if (totals.length !== leafCount) {
      throw new Error(`tree of depth ${depth} needs exactly ${leafCount} totals, got ${totals.length}`);
    }
    this.depth = depth;
    this.leafCount = leafCount;
    this.#totals = totals;

    const leaves = totals.map((total, i) =>
      hasher.hash([key.account, key.asset, key.baseIndex + BigInt(i), total]),
    );
    this.#levels = [leaves];
    for (let d = 0; d < depth; d++) {
      const below = this.#levels[d]!;
      const above: bigint[] = [];
      for (let i = 0; i < below.length; i += 2) {
        above.push(hasher.hash([below[i]!, below[i + 1]!]));
      }
      this.#levels.push(above);
    }
  }

  get root(): bigint {
    return this.#levels[this.depth]![0]!;
  }

  totals(): readonly bigint[] {
    return this.#totals;
  }

  /**
   * Sibling hashes from a leaf up to the root, bottom first.
   *
   * Only the siblings: the directions are the bits of `index`, which the
   * circuit already knows. Supplying them would hand the prover a choice the
   * design deliberately removes.
   */
  siblings(index: number): readonly bigint[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.leafCount) {
      throw new Error(`no leaf at ${index}`);
    }
    const out: bigint[] = [];
    let position = index;
    for (let d = 0; d < this.depth; d++) {
      out.push(this.#levels[d]![position ^ 1]!);
      position >>= 1;
    }
    return out;
  }
}

/**
 * Minimal types for snarkjs, which ships none.
 *
 * Narrow on purpose: only what this package calls, so an upstream change
 * surfaces as a compile error here instead of an `any` leaking through the
 * one path that decides whether a proof is accepted.
 */
declare module "snarkjs" {
  export interface Groth16Proof {
    readonly pi_a: readonly string[];
    readonly pi_b: readonly (readonly string[])[];
    readonly pi_c: readonly string[];
    readonly protocol: string;
    readonly curve: string;
  }

  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(
      verificationKey: unknown,
      publicSignals: readonly string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
}

declare module "circomlibjs" {
  export function buildPoseidon(): Promise<{
    (inputs: readonly bigint[]): unknown;
    F: { toObject(value: unknown): unknown };
  }>;
}

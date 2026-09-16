# Principles

The rules this code is built on. They are cited by article and section
throughout the source — `Art. XI §42` and so on — and this is where those
citations resolve.

They are carried here, with their original numbering intact, from the
constitution of [Orb](https://github.com/Soldsoul86/orb), where these packages
were first written. Only the laws this code actually depends on are reproduced;
the numbering is kept rather than tidied so that a reader following a comment
lands on the right rule, and so the two repositories cannot drift into meaning
different things by the same name.

They are stated as constraints, not aspirations. Where the code appears to
violate one, that is a bug report.

---

## Article I — History

2. **History is never mutated.** Events are never edited, reordered, or
   deleted.
3. **The Event Journal is the single source of truth.** All other state is a
   derived projection and may be discarded and rebuilt.
4. **Every feature must be replayable from events.** Nothing of value exists
   that cannot be reconstructed from the journal.
5. **History is tamper-evident.** Lanes are hash-chained so that any corruption
   or rewriting is detectable.

> The ledger of what has been spent is a **projection**, never a store. Delete
> it and it rebuilds identically. This is what makes a receipt checkable by
> someone who does not trust the issuer: the decision recomputes from the same
> events.

## Article II — Truth and Interpretation

9. **Understanding is always recomputable.** The interpretation layer can be
   rebuilt from history at any time and holds no source-of-truth state.
10. **Every decision is explainable.** Any conclusion or action can be traced to
    its interpretations, evidence, and reasoning provenance.

> `evaluate()` is pure and total. The same request, policy and ledger produce
> the same decision and the same explanation, forever. A policy engine that
> cannot say *why* it refused is not auditable, and an unauditable refusal is
> indistinguishable from a bug.

## Article IV — Distribution

14. **Devices are equal peers.** No device is authoritative.
15. **Every device owns its own append-only lane** and writes only that lane.
17. **Global ordering is derived, never stored.** Order is computed from Hybrid
    Logical Clocks on read; persisting a global order would reintroduce an
    authority.
18. **Merge never rewrites history.** Replication is the set union of immutable
    lanes; semantic contradictions are resolved in interpretation, never in
    history.

## Article VII — Capabilities and Human Agency

29. **Every action is recorded.** An action, once taken, is appended to history
    as a new observation. There are no silent actions.

## Article IX — Engineering

33. **Never duplicate sources of truth.** There is one journal; everything else
    derives from it.
35. **Every module must be independently testable** and must compile
    independently.
36. **Build the simplest correct implementation** that preserves the long-term
    architecture. Never optimize prematurely.

## Article X — The Kernel

37. **The kernel evolves through addition, never through mutation.** New
    capability arrives as new contracts or new versions alongside the old —
    never by changing the meaning of an existing contract.
38. **Breaking changes require a new version.** A contract accepted at v1 is
    permanent.

> A signed receipt must still verify in ten years. That forbids quietly
> redefining a field, and it is why verification reports a *version* check
> rather than assuming the reader and the writer agree.

## Article XI — Reality and Confidence

42. **Reality is updated only through observation.** Never assume an Action
    changed reality. The loop closes only when a Sensor confirms that reality
    occurred as expected; an issued Action that is never confirmed never
    updates reality.
43. **An Observation owns confidence, not truth.** Every Observation carries a
    confidence in `[0, 1]` describing the reliability of its perception. Truth
    is never resolved into certainty and never silently upgraded.

> **The load-bearing one.** A payment is *authorised*, then *attempted*, then —
> only if something independent confirms it — *settled*. An authorisation is
> not a spend. A request that returned 200 is not a spend. The reconciler
> settles on a confirmation and on nothing else, and an observer that answers
> `UNKNOWN` resolves nothing in either direction: settling would record money
> that may not have moved, reversing would free money that may be gone.
>
> Almost every payment bug worth having is a violation of §42.

---

## The governing rule

> A payment may be requested by anyone — a person, a schedule, an autonomous
> agent. **Spend authority belongs to the policy.**

Nothing a requester sends can raise a limit, skip an approval, or widen a
window. Everything else here is machinery in service of that sentence.

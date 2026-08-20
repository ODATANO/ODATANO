# FR: Per-action mint policies + extraOutputs on BuildMintTransaction

Status: IMPLEMENTED locally (2026-08-20), pending review + release.
LIVE-PROVEN on preview via the rc.4 tarball from the DAYPASS consumer
(`DAYPASS/scripts/e2e-cart-multimint.mts`): one BuildMintTransaction with 2
mint actions under 2 different Groth16 verifier policies (per-action script
+ redeemer) and 2 extraOutputs (each token with its own inline datum), both
scripts evaluated locally in one build, tx `fe458143...83a9` confirmed with
valid_contract true. Operational note for consumers: a multi-verify fee
(~1.2 ADA for 2 proofs) needs collateral above 150% of it, so the wallet
must hold an ADA-only UTxO at the 5 ADA floor.
Requested by: DAYPASS (proof cart: N zero-knowledge predicate tokens in ONE
transaction, mirroring NIGHTPASS's proof cart on Midnight)

Implementation notes (all backward compatible):
- `parseMintActionPolicyFields` in `srv/utils/tx-request-parsers.ts` (shared
  by the sync handler and the wallet-worker lane): per-action
  `mintingPolicyScript` (CBOR hex, pre-applied) + `redeemerJson`
  (JSON-encoded string, the extraOutputs `inlineDatumJson` convention);
  a redeemer without its script is rejected.
- `MintAction` type carries the optional per-action fields; bare asset names
  expand with the per-action script's OWN policy id, and full units must
  prefix-match it (BUG 9 mirror per action). The global top-level prefix
  check skips per-action-script actions.
- `_buildMintEntries` resolves per-action script/redeemer with fallback to
  the request-level ones and rejects actions that resolve to the SAME
  policy with DIFFERENT redeemers (the ledger carries one redeemer per
  policy); the comparison is canonical over the encoded PlutusData CBOR,
  so JSON key order does not matter and a JSON `{int:0}` equals the
  `DataI(0)` fallback (review finding). Both the mint-only and the combined
  spend+mint flow use it; per-action redeemers get the same `__INPUT_IDX__`
  placeholder resolution.
- The synchronous `BuildPlutusSpendTransaction` handler parses the same
  per-action fields as `BuildMintTransaction` (review finding: it initially
  dropped them, so the combined flow only worked via the worker lane), and
  its top-level prefix check skips per-action-script actions.
- The CIP-14 fingerprint of the first minted asset derives its policy id
  from the UNIT, not from the top-level script hash (review finding: a
  per-action policy on the first action produced a wrong fingerprint).
- `extraOutputsJson` accepted on `BuildMintTransaction` (parser reused from
  the Plutus-spend action). When extra outputs are present THEY carry the
  minted assets and the primary output stays ADA(+datum)-only; coin
  selection requests extra-output lovelace plus, per unit, the aggregated
  output demand MINUS the aggregated positive mint quantity (only a
  positive remainder is requested from the wallet; review finding P2).
- Tests: parser suite (`parseMintActionPolicyFields`), builder suite
  (multi-policy `_buildMintEntries` incl. same-policy redeemer conflict),
  wallet-worker suite (per-action fields, bare-name expansion under the
  action policy, own-policy prefix rejection, extraOutputs passthrough).

## What

Two additive extensions to `BuildMintTransaction`, both reusing machinery
that already exists elsewhere in the codebase:

### 1. Per-action minting policy + redeemer

Today the action takes ONE `mintingPolicyScript` + ONE `mintRedeemerJson`
applied to every entry of `mintActionsJson`. Cardano transactions natively
support minting under multiple policies at once (the mint field is a map
policyId -> assets, with one redeemer per policy), and the Buildooor layer
already models it: `_buildMintEntries` produces per-entry
`{ value, script: { inline, redeemer } }` objects. Only the service surface
collapses everything onto a single script.

Proposal: `mintActionsJson` entries accept optional per-action fields

```json
[
  { "assetUnit": "<policyA + name1>", "quantity": "1",
    "mintingPolicyScript": "<cborHexA>", "redeemerJson": "<plutusDataJson>" },
  { "assetUnit": "<policyB + name2>", "quantity": "1",
    "mintingPolicyScript": "<cborHexB>", "redeemerJson": "<plutusDataJson>" }
]
```

falling back to the top-level `mintingPolicyScript`/`mintRedeemerJson` when
absent (fully backward compatible). Validation: each action's assetUnit
policyId must equal the hash of the script that applies to it. Note the
current entry parser already tolerates an `action.redeemer` integer
fallback; the new field carries full PlutusData JSON like the top-level
param.

### 2. `extraOutputsJson` on BuildMintTransaction

The parser (`parseExtraOutputs`, per-entry address / lovelaceAmount /
assets / inlineDatumJson / referenceScriptHex, MAX 32) exists and is wired
into `BuildPlutusSpendTransaction` only. Minting policies that bind the
token to the inline datum of the output CARRYING it (the DAYPASS predicate
policy: asset name = blake2b-224 over the serialised datum) need one output
per token, each with its own datum. With N tokens in one tx that is
impossible today (single recipient output, single `inlineDatumJson`).

Proposal: accept `extraOutputsJson` on `BuildMintTransaction`; entries list
their minted token in `assets`, and the balancer places minted value on the
declared outputs instead of the primary recipient output.

## Why

DAYPASS proof cart: prove several confidential claims (for example
"CO2 <= 4000" + "capacity >= 60" + "chemistry in published list") and mint
all predicate tokens in ONE transaction: one fee, one confirmation wait,
one atomic all-or-nothing settlement (simpler than Midnight's
PARTIAL_SUCCESS handling). Each claim's Groth16 proof is the redeemer of
its own verifier policy, and each token needs its own datum output.

## Constraints established by the consumer (for sizing)

- The DAYPASS verifier policies enforce EXACTLY ONE token per policy per tx
  (`expect [Pair(name, 1)]`), so a cart holds at most one claim per
  operator (4 distinct v2 operators today). Same-operator batching would
  need a policy redesign (new policyIds) and is out of scope here.
- One on-chain Groth16 verify costs ~2.71B steps (~27% of the 10B tx
  budget): a cart caps at 3 verifies per tx regardless of API shape.
  So the concrete target is "up to 3 mint actions under 3 distinct
  policies, each with its own redeemer and datum output".
- Collateral: 3 script executions raise the fee, not the 5 ADA collateral
  floor logic; no change expected, worth a test.
- Local Plutus evaluation must evaluate one redeemer per policy (3 BLS
  pairing checks per build); the Ogmios fallback path should behave
  identically.

## Acceptance

- One BuildMintTransaction with 2 actions under 2 different Plutus
  policies, each with its own redeemer, plus 2 extraOutputs each carrying
  one token + its inline datum: builds, evaluates locally, submits, and
  both policies see exactly their token/datum.
- Backward compatibility: existing single-policy calls (top-level script +
  redeemer, no extraOutputs) build byte-identically.
- Validation errors: action whose assetUnit policyId does not match its
  script; extraOutputs declaring an asset that is not minted or sent.

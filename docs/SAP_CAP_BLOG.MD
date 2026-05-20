# Adding Immutable Blockchain Proofs to SAP with CAP, Cardano, and OData V4

> _ODATANO: Turning Cardano into a CAP Plugin_
>
> 📝 Originally published on the SAP Community:
> [Adding immutable blockchain proofs to SAP with CAP, Cardano, and OData V4](https://community.sap.com/t5/sap-cap-blog-posts/adding-immutable-blockchain-proofs-to-sap-with-cap-cardano-and-odata-v4/ba-p/14370241)

Hi everyone. I'm Max, a SAP developer for 10 years. In my spare time, I've been experimenting with blockchain and immutable data proofs a lot lately. In particular, with Cardano, because it's one of the few public blockchains built on peer-reviewed research and formal methods, which matters a lot when you're thinking about anchoring any kind of enterprise data. So I tried to work out a way to bring the two worlds together.

This is a write-up of what came out of it. I hope this is useful. Feedback and pushbacks are very welcome.

## Why is blockchain next to SAP at all?

SAP systems are trusted but mutable. An admin can edit records, a migration can rewrite values, and an audit trail living in the same database as the data it tracks is only as trustworthy as the permissions around it.

A public blockchain solves that one specific problem: immutable, externally verifiable proof that a piece of data existed at a given moment, outside any one organization's trust boundary.

The use cases aren't exotic at all. Audit anchoring, batch traceability, cross-company verification, and regulatory compliance are just a few. So the hard part isn't the use case. It's the integration. Chain-specific SDKs, raw cryptographic payloads, wallet protocols, and provider APIs have nothing in common with the OData services that SAP systems are used to consuming.

As I got more familiar with CAP, I thought to myself: what if the blockchain were just another data source behind a CAP service?

## The CAP reflex

Anyone who's worked with CAP knows the regular pattern. Model the domain in CDS, write service handlers, let the framework handle OData, routing, metadata, and authentication.

Cardano's domain maps surprisingly cleanly to CDS. Blocks, Transactions, UTxOs, Assets, Stake Pools, and Epochs are all typed entities with relationships. A Cardano transaction, for example, always has an input and output composition. And one output has a composition of different assets. An asset has `policyId`, `assetName`, `fingerprint`, and `quantity`. Conceptually, no further from SAP than, say, an external material service with detailed classifications.

If the domain can be modeled, the rest can too.

## What ODATANO is

ODATANO is a CAP application that exposes Cardano as three OData V4 services. More importantly, it's packaged as a CAP plugin (`@odatano/core` on npm). If you've used `@cap-js/sqlite` or `@sap/cds-hana`, you know the drill: install the package, add a config block, and the plugin self-registers at startup.

No custom middleware. No manual route wiring. No code changes in your host app.

## Setup

```bash
npm install @odatano/core @cap-js/sqlite
```

An example of the `cds` section in a consumer project's `package.json` might look like this:

```json
{
  "cds": {
    "requires": {
      "[development]": {
        "auth": { "kind": "dummy" }
      },
      "db": {
        "kind": "sqlite",
        "credentials": { "url": "db.sqlite" }
      },
      "odatano-core": {
        "network": "preview",
        "backends": ["koios"],
        "txBuilders": ["buildooor"]
      }
    }
  }
}
```

The plugin auto-registers and is available after:

```bash
cds deploy --to sqlite && cds watch
```

Three OData services are now live alongside your own — same CAP runtime, same auth middleware, full `$metadata` discovery.

## The three services

- **Read** (`/odata/v4/cardano-odata`) — 18 entities: Blocks, Transactions, Addresses, UTxOs, Assets, Stake Pools, Epochs, Accounts, DReps, Protocol Parameters. Full OData V4 query surface: `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`, `$count`.
- **Transaction** (`/odata/v4/cardano-transaction`) — 11 actions covering the full Build/Sign/Submit lifecycle. ADA transfers, multi-asset, native token minting, CIP-20 metadata, Plutus V3. Each action returns a `TransactionBuilds` entity with fee estimate, unsigned CBOR, and outputs.
- **Signing** (`/odata/v4/cardano-sign`) — 8 actions implementing external signing as a state machine (`pending → verified → submitted`). CIP-30 wallets, Cardano CLI, PKCS#11 HSMs. The service never touches private keys.

**Total: 31 entities, 34 actions, three services.**

## Why OData & typed entities matter

Every Cardano entity is a proper CDS model with associations and compositions. That changes what consumers can do:

```http
GET /odata/v4/cardano-odata/Transactions('abc123')?$expand=inputs,outputs($expand=assets)
```

The response is structured and typed. Fiori, Excel, Power BI, custom consumers — nobody has to parse raw blockchain data.

Same principle for actions. Every parameter has a name, type, and annotations. API Business Hub and Gateway Client render input forms from the `$metadata` document alone.

## CAP architecture patterns

I tried not to invent much. Where CAP had a pattern, I used it.

- **Service handlers** wrap business logic in `handleRequest()`, which catches blockchain-specific errors and maps them to OData responses. For example, 400 for validation, 404 for missing UTxOs, 503 for backend outages — so service consumers never see a raw chain exception.
- **Lazy on-demand indexing.** No bulk replication. The first query for a block, transaction, or address fetches from the backend, persists via UPSERT in the database, and serves subsequent requests from cache until TTL expires.
- **Multi-backend failover.** Three backends (Blockfrost, Koios, Ogmios). The orchestrator picks the right one per request type (Ogmios for live UTxOs, Blockfrost for historical) and fails over on timeout. Transparent to the consumer.
- **Database-agnostic.** CDS entities and standard CAP persistence. SQLite locally, HANA on BTP. No code change, no schema migration. The CDS compiler handles the DDL.

## TRACE: a concrete use case

To make this less abstract and to test the plugin firsthand, I built a second CAP app: **TRACE**, a Fiori frontend for pharmaceutical supply chain tracking. TRACE just consumes `@odatano/core` as a plugin and can use all of the available services for interacting with the Cardano blockchain without having to write one line of custom blockchain code.

**Business scenario:** A manufacturer produces a batch. Regulation requires tamper-proof evidence of every custody transfer from the manufacturer to the distributor to the pharmacy. Nobody can rewrite history afterward.

- The manufacturer mints the batch as an NFT via ODATANO's `BuildMintTransaction` OData action. The NFT carries an inline datum (manufacturer ID, batch ID, custody state) written on-chain at creation.
- Each batch handover calls the OData action `BuildPlutusSpendTransaction`. The Plutus V3 Cardano smart-contract validator enforces on-chain who's allowed to transfer. `inlineDatumJson` carries the updated custody state to the continuing output.
- Any party — manufacturer, regulator, pharmacy, or end consumer — can read the full custody chain without access to anyone's SAP system, because the data lives on Cardano, not in any vendor database.

## Conclusion

ODATANO started as a personal question: could a public blockchain like Cardano, with smart contracts and transaction logic, feel like another OData service? After half a year of building, I think the answer is yes. Three OData services, familiar CAP patterns, and TRACE as proof that a real consumer app doesn't need a single line of blockchain-specific code.

What excites me most is that, this way, Cardano just shows up as another service in the stack — with the same `$metadata`, the same query syntax, and the same handlers as any other CAP service, just with tamper-proof storage and cryptographic guarantees by design.

## Status

Funded by Cardano Catalyst Fund 14 (Open Developers). Apache 2.0. Final milestone approved late April, no reviewer refusals, about two months before the deadline.

| | |
|---|---|
| **Version** | v1.7.8 (`@odatano/core` on npm) |
| **Tests** | 1,285 tests across 31 suites, 97% statement coverage |
| **Cardano Networks** | mainnet, preview, preprod |
| **Backends** | Blockfrost, Koios, Ogmios (with a real Cardano node) |
| **CAP compatibility** | `@sap/cds` 9.x, Node.js 18+ |
| **Main Repo** | [github.com/ODATANO/ODATANO](https://github.com/ODATANO/ODATANO) |
| **TRACE** (example consumer app) | TRACE |
| **Homepage** | [https://odatano.dev/](https://odatano.dev/) |

If anyone wants to poke at it, try it, or tear it apart, please do. I'm especially interested in feedback from people deep in CAP, because I'm never quite sure which patterns are the most idiomatic. Issues, threads, and messages are all welcome.

Thanks and best regards,

Max

---

## References

- **Published blog post (SAP Community):** [Adding immutable blockchain proofs to SAP with CAP, Cardano, and OData V4](https://community.sap.com/t5/sap-cap-blog-posts/adding-immutable-blockchain-proofs-to-sap-with-cap-cardano-and-odata-v4/ba-p/14370241)
- **Main repository:** [github.com/ODATANO/ODATANO](https://github.com/ODATANO/ODATANO)
- **Homepage:** [https://odatano.dev/](https://odatano.dev/)

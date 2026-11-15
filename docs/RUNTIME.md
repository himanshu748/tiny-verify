# Runtime and privacy

The default commands run locally without a key. The reviewed Florida page is a saved observation from 15 November 2026. Opening it, downloading its JSON/CSV, planning a request and replaying saved evidence make no provider calls.

## Offline entry points

Requires Node.js 22 or newer and npm. Node 22.14.0 was used for the release checks.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run demo
npm run plan -- examples/request-gb.json
npm run demo:florida
mkdir -p outputs
npm run replay -- tiny-verify/evidence/live-fetch-proof.json outputs/historical-review
npm run build
node dist/tiny-verify/src/cli.js plan examples/request-au.json
npm run verify
```

`demo` and `demo:florida` use synthetic fixtures. The fictional cancellation and example complaint rows are not observed registry events. `replay` reads two genuine saved UK/AU observations from 8 November and writes reports into a new directory; it does not contact either registry. Use a new output path each time. `verify` makes a clean temporary copy, installs pinned dependencies, runs 129 tests and the local checks, then writes a dated public-safe receipt under `evidence/`. npm installation contacts the package registry; the application checks use a fetch guard and live flags set to `0`.

## Supported workflows

| Workflow                  | Commands                                              | Selection and scope                                                                                                                               |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK/AU registration        | `discover`, `inspect`, `watch`                        | Business name, supported record type and explicit returned identifier. Registration does not establish professional licence expiry or discipline. |
| Florida corporate licence | `fl-discover`, `fl-inspect`, `fl-history`, `fl-watch` | `US-FL` / `real_estate_corporation`; explicit CQ number and its actually observed detail URL.                                                     |

The real command contracts are implemented in [operator.ts](../tiny-verify/src/operator.ts). The Florida sequence is:

1. `fl-discover REQUEST OUT` returns candidates from the actual public name form and first visible corporate page, at most eight candidates. It may click the company-name button in a qualifying CQ row to observe the actual URL. This is not proof that one result is unique.
2. A reviewer selects the exact observed licence number and detail URL. `fl-inspect DISCOVERY LICENCE EXACT_DETAIL_URL OUT` independently Fetches that public GET detail and checks name, type, licence, native status, expiry and complaint-form binding.
3. `fl-history RECORD OUT` uses a separate anonymous Agent to reopen that detail, check the binding and submit its native public complaint form. It reads at most twenty visible corporate rows. There is no pagination, case-detail navigation or extraction of addresses/associated people.
4. `fl-watch RECORD OUT` compares status/expiry on the exact GET detail. It does not refresh the separate POST complaint listing.

With live disabled, the operator returns before reading inputs or credentials. For example:

```sh
TINYVERIFY_LIVE=0 npm run operator -- fl-discover examples/request-florida.json /unread-output
TINYVERIFY_LIVE=0 npm run operator -- fl-history /unread-record /unread-output
TINYVERIFY_LIVE=0 npm run operator -- fl-watch /unread-record /unread-output
```

## Live controls

No working key, permit, private output or provider session is included. A new real run needs the operator's account, separately authorized finite scope, pricing/tier verification, confirmed Agent beta access and private controls. This candidate grants no provider authority and includes no automated live-enable recipe.

The [runtime permit schema](../tiny-verify/src/runtime-controls.ts) binds exact absolute file/state paths, validity times, key hash, Fetch tier, aggregate reservations, operation counts and one optional Monitor target/window. `TINYVERIFY_PERMIT_FILE` and `TINYFISH_KEY_FILE` refer to owner-only files outside the public workspace. `TINYVERIFY_LIVE=1` alone is insufficient. Permits cannot be reset by deleting state or editing their binding.

Agent calls have a hard twenty-step limit, a 150-second remote duration and a 175-second client window. Goal instructions restrict public navigation; there is no server-side action allowlist attesting every click. Fetch uses an exact official URL, selected DOM, finite body, exact final URL, a 45-second source timeout and 60-second client timeout.

The Monitor test creates a baseline, immediately pauses an annual schedule outside the approved window, performs one manual check and confirms the final pause. Pause and cleanup are client controls, not a provider-enforced lifetime or check cap. A process failure can leave an owned resource needing reconciliation. Known IDs are persisted before baseline parsing; only an exact owned claim can be reconciled. No deletion, resume, webhook or ongoing scheduled monitoring is implied.

The private ledger retains reservations after success, failure and uncertainty. It permits one content operation at a time and halts on failure, uncertain remote state or unconfirmed cleanup. It offers no automatic retry, refund, reset or unhalt operation. Current implementation reservation ceilings are safety checks, not a provider quote or invoice. The completed reviewed Florida scope is closed and its Monitor was confirmed paused.

## Privacy and interpretation

Original source HTML and Agent selected-text captures are private review material. They can contain incidental public addresses or associated people and do not belong in this package. The public example includes selected corporate fields, public published rows, source URLs and observation times only. Live private output uses new owner-only directories and must be reviewed before any export is made public.

Complaint text is Agent-reported selected text, separately corroborated in ordinary signed-out Chrome. That corroboration is not a new TinyFish Browser transport claim. The listing is non-exhaustive; an empty table, blank action field, closed case or Final Order does not establish clean history. Placeholder incident dates stay unknown. Client Monitor comparison and provider-reported outcome metadata remain separate.

See [verification](VERIFICATION.md) for exactly what was observed and [sources](SOURCES.md) for the source and contract references.

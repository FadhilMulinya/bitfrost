# QA Report — bifrost OrderEngine adversarial attack

- **Date:** 2026-07-15 · **Branch:** main · **Mode:** targeted attack (user-directed, daemon-level; no browser surface involved)
- **Scope:** (1) live refund path under node failure, (2) SYSTEM-DESIGN §6 threat table, line by line, with emphasis on the timelock race.
- **Environment:** deploy/docker-compose.dev.yml live stack (fiber 0.9.0-rc7, lnd 0.19.2-beta, regtest).

## Verdict

Both attacks were defeated by the engine. 1 real bug found and fixed (event pump death on handler error), 11 new adversarial tests added and passing, 1 live kill-test script added and green. Suite: 74 passed / 6 IT-gated skipped.

## Attack 1 — kill lnd-hub mid-swap (refund path, §5.3 / rule R3)

`deploy/scripts/qa-attack-refund.sh` (repeatable): order created → `lnd-hub` container stopped → client pays the Fiber hold invoice → dispatch to the dead node fails → expiry sweep crosses the safety threshold → R3.

Evidence (live run):
```
trail: PENDING → INCOMING_HELD → OUTGOING_IN_FLIGHT → REFUNDING → FAILED
failure: EXPIRY_INVARIANT_VIOLATION — incoming expiry entered the safety window (R3)
hub hold invoice: Cancelled ✓
client offered-TLC balance: 0 ✓ (funds released, hub never possessed them)
```

Bug found during this attack — **ISSUE-001 (high, fixed, verified):** a rejected `onLegEvent` (dispatch failure against the dead node) killed the event pump loop, so the later `INCOMING_CANCELLED` event would never reach the engine. Fix: per-event catch in the pump (`bifrostd/src/smoke/runner.ts`), commit `dafde56`. Verified by the live attack completing through `FAILED`.

Design note (correct, not a bug): with the outgoing node unreachable there is no *definitive* failure signal, so the engine parks in `OUTGOING_IN_FLIGHT` until the R3 window opens rather than guessing — I3 forbids retry/refund on a non-definitive signal. The failure code is therefore `EXPIRY_INVARIANT_VIOLATION` (sweep-triggered), not `OUTGOING_FAILED`.

## Attack 2 — §6 threat table, line by line

| Row | Threat | Attack performed | Result |
|---|---|---|---|
| 1 | Settle incoming, never pay outgoing | Forged `INCOMING_SETTLED` in every pre-settlement state; cross-order preimage replay (order B fed order A's *valid* preimage); duplicate `paymentHash` order; late valid preimage after refund | Defeated — 0 settle calls in all cases (`threat-table.test.ts`) |
| 2 | Timelock race | Exact-boundary orders (±1 ms both sides); conversion-direction attacks where the *optimistic* CLTV reading passes but the conservative one must reject (both legs); expiry crossing the threshold exactly at `INCOMING_HELD` | Defeated — rejects at boundary, refunds instead of dispatching, and does not over-reject 1 ms early |
| 3 | Stale/manipulated feed | Already attacked in `rfq.test.ts` (stale feed → `PRICING_UNAVAILABLE`; rates exact rationals, signed) | Covered elsewhere |
| 4 | Client griefing (liquidity lock) | **Gap (deferred):** the `guard/` module's max-hold-window and rate limits are not built; only the expiry sweep bounds a PENDING order's life | Deferred → TODOS.md |
| 5 | Quote forgery / registry MITM | Already attacked in `registry.e2e.test.ts` (tamper → 401, wrong key → 401, replay window) and sdk §9 tests | Covered elsewhere |
| 6 | RPC exposure | Inspection: compose publishes **no** ports to the host (no `ports:` stanzas); registry binds 127.0.0.1; LND dev nodes run no-macaroons/no-TLS — acceptable for the dev stack, flagged for testnet topology | Pass (dev scope) |
| 7 | Crash mid-swap | Crash between persisting `OUTGOING_SETTLED` and the settle call (recovery must settle exactly once with the verified preimage); hand-poisoned event log claiming a settled outgoing with a wrong preimage | Defeated — recovery settles once; poisoned log refused because `settleIncoming` re-verifies `sha256(P)==H` against the persisted value |
| 8 | Channel-state cheating | Delegated to network watchtowers per spec; `/v1/health` watchtower surfacing not built (api/ not started) | Deferred → TODOS.md |

## Fix log

| Issue | Severity | Status | Commit |
|---|---|---|---|
| ISSUE-001 pump dies on handler error | high | fixed, verified live | `dafde56` |
| ISSUE-002 no max-hold-window / rate limits (threat row 4) | medium | deferred (guard/ module scope) | — |
| ISSUE-003 watchtower health not surfaced (threat row 8) | low | deferred (api/ module scope) | — |
| ISSUE-004 transport errors from a dead node surface as raw `TypeError`, not `AdapterError` (behavior correct, typing sloppy) | low | deferred | — |

## PR summary

> QA attacked the OrderEngine (live node-kill + §6 threat table): found 1 bug, fixed and verified it; 11 new adversarial tests all pass; refund path proven on the live stack (REFUNDING → FAILED, hold cancelled, client funds released).

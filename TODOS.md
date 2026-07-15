# TODOS

## Deferred by /autoplan 2026-07-15 (Milestone 1 Part A review)
- [ ] CI: run deploy/scripts/smoke-cch.sh as the bifrostd non-interference gate (after Milestone 2 starts)
- [ ] CI: automated fresh-clone rehearsal of deploy/README quick start
- [ ] Revisit fiber pin if v0.9.0 final ships before hackathon submission

## Deferred by /qa 2026-07-15 (OrderEngine attack session)
- [ ] guard/: max-hold-window + per-key rate limits + exposure caps (threat row 4 — client griefing); today only the expiry sweep bounds a PENDING order's life
- [ ] api/health: surface watchtower health for both networks (threat row 8)
- [ ] adapters: wrap undici fetch failures as AdapterError (dead-node errors currently surface as raw TypeError; behavior is correct — treated as non-definitive — but typing is sloppy)

# Bifrost

A production-grade **Fiber ⇄ Lightning edge-node daemon**: pay any BOLT11 invoice from Fiber (CKB) assets and vice versa, via trust-minimized HTLC atomic swaps with signed RFQ quotes.

Built for the "Gone in 60ms" Fiber Network Infrastructure Hackathon.

## Repo map
- `spec/PROTOCOL.md` — the bifrost/0.1 wire protocol (the contract; read first)
- `spec/SYSTEM-DESIGN.md` — full architecture: modules, flows, security, deployment
- `CLAUDE.md` — project context for Claude Code / gstack agents
- `sdk/` — `@bifrost/sdk` TypeScript client **(current workstream — types, canonical JSON, BIP-340 verification, client facade: DONE; see STATUS)**
- `bifrostd/`, `registry/`, `dashboard/` — next workstreams (see SYSTEM-DESIGN §8 milestones)

## SDK quickstart
```bash
cd sdk && npm install && npm test && npm run build
```

## Working with gstack
Install gstack into Claude Code, open this repo, and start with `/office-hours` referencing `CLAUDE.md`. The current sprint definition lives in CLAUDE.md ("Current sprint").

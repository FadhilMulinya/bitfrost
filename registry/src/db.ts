/**
 * Ad store. One row per hubPubkey (a republish replaces the previous ad).
 * The ad JSON is stored VERBATIM and served verbatim — registries MUST NOT
 * modify ads (PROTOCOL §4.5); clients re-verify signatures locally.
 */
import Database from "better-sqlite3";
import type { Advertisement } from "@bifrost/sdk";

export interface AdStore {
  upsert(ad: Advertisement): void;
  /** all unexpired ads as stored (verbatim) */
  fresh(now: number): Advertisement[];
  close(): void;
}

export function openStore(path = ":memory:"): AdStore {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ads (
      hub_pubkey TEXT PRIMARY KEY,
      body       TEXT NOT NULL,   -- verbatim signed ad JSON
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ads_expires ON ads (expires_at);
  `);
  const up = db.prepare(
    `INSERT INTO ads (hub_pubkey, body, issued_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(hub_pubkey) DO UPDATE SET body=excluded.body,
       issued_at=excluded.issued_at, expires_at=excluded.expires_at
     WHERE excluded.issued_at >= ads.issued_at`, // never regress to an older ad
  );
  const sel = db.prepare(`SELECT body FROM ads WHERE expires_at > ?`);
  return {
    upsert(ad) {
      up.run(ad.hubPubkey, JSON.stringify(ad), ad.issuedAt, ad.issuedAt + ad.ttlMs);
    },
    fresh(now) {
      return (sel.all(now) as Array<{ body: string }>).map((r) => JSON.parse(r.body) as Advertisement);
    },
    close() {
      db.close();
    },
  };
}

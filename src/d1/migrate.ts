/**
 * Apply Kestrel's migrations (its `migrations/*.sql`, bundled through the generated
 * `kestrel` module) to a Durable Object's SQLite, the way `wrangler d1 migrations apply`
 * does to D1: in name order, each file in one transaction, each recorded so it runs once.
 *
 * DO SQLite refuses `BEGIN`/`COMMIT` in `sql.exec`, so the transaction is
 * `transactionSync`; Kestrel's migrations carry no transaction statements of their own.
 *
 * The record is wrangler's own table, `d1_migrations`, in wrangler's shape, because Kestrel
 * reads it: since v1.8.0 it refuses to serve a database missing a migration it ships
 * (`schema_behind`). A sandbox migrated before then kept its record in `demo_migrations`,
 * which is carried over once.
 */

import { runnable } from "./adapter";

export interface Migration {
  /** The file name, e.g. `0001_init.sql`. Names order the migrations, as wrangler's do. */
  name: string;
  sql: string;
}

const TABLE = "d1_migrations";
const LEGACY = "demo_migrations";

/** Apply every migration not yet applied; returns the names applied by this call. */
export function migrate(storage: DurableObjectStorage, migrations: Migration[]): string[] {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );
  const legacy = storage.sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", LEGACY)
    .toArray();
  if (legacy.length > 0) {
    storage.transactionSync(() => {
      storage.sql.exec(
        `INSERT OR IGNORE INTO ${TABLE} (name) SELECT name FROM ${LEGACY} ORDER BY name`,
      );
      storage.sql.exec(`DROP TABLE ${LEGACY}`);
    });
  }
  const done = new Set(
    storage.sql
      .exec<{ name: string }>(`SELECT name FROM ${TABLE}`)
      .toArray()
      .map((r) => r.name),
  );
  const applied: string[] = [];
  // Code-unit order, as the build script sorts the files (and as wrangler orders by name).
  for (const m of [...migrations].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (done.has(m.name)) {
      continue;
    }
    storage.transactionSync(() => {
      storage.sql.exec(runnable(m.sql));
      storage.sql.exec(`INSERT INTO ${TABLE} (name) VALUES (?)`, m.name);
    });
    applied.push(m.name);
  }
  return applied;
}

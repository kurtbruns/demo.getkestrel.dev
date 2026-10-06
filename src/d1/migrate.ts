/**
 * Apply Kestrel's migrations (its `migrations/*.sql`, bundled through the generated
 * `kestrel` module) to a Durable Object's SQLite, the way `wrangler d1 migrations apply`
 * does to D1: in name order, each file in one transaction, each recorded so it runs once.
 *
 * DO SQLite refuses `BEGIN`/`COMMIT` in `sql.exec`, so the transaction is
 * `transactionSync`; Kestrel's migrations carry no transaction statements of their own.
 */

export interface Migration {
  /** The file name, e.g. `0001_init.sql`. Names order the migrations, as wrangler's do. */
  name: string;
  sql: string;
}

const TABLE = "demo_migrations";

/** Apply every migration not yet applied; returns the names applied by this call. */
export function migrate(storage: DurableObjectStorage, migrations: Migration[]): string[] {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`,
  );
  const done = new Set(
    storage.sql
      .exec<{ name: string }>(`SELECT name FROM ${TABLE}`)
      .toArray()
      .map((r) => r.name),
  );
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) {
      continue;
    }
    storage.transactionSync(() => {
      storage.sql.exec(m.sql);
      storage.sql.exec(`INSERT INTO ${TABLE} (name, applied_at) VALUES (?, ?)`, m.name, Date.now());
    });
    applied.push(m.name);
  }
  return applied;
}

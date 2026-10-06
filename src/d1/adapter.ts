/**
 * A D1 database over a Durable Object's own SQLite (`ctx.storage.sql`), so Kestrel's queries
 * run unchanged inside a visitor's sandbox (DESIGN.md, "The D1-compatible adapter").
 *
 * It implements the slice of D1 Kestrel uses: `prepare` → `bind` → `first` / `all` / `run` /
 * `raw`, plus `batch` and `exec`. It is held to what production D1 enforces, so the demo is
 * no more lenient than a real deployment: at most 100 bound parameters, `undefined` refused
 * as a bind value, and `first(column)` refusing an unknown column. SQLite's own error text
 * passes through unchanged, which Kestrel relies on (it recognizes a second active send by
 * `UNIQUE constraint failed: sends.post_id`).
 *
 * `batch` runs inside `transactionSync`: every statement commits or none does, and its
 * SELECTs read one consistent snapshot, which Kestrel's send list and feed depend on.
 *
 * Everything here is synchronous underneath (DO SQLite is), wrapped in promises because
 * D1's API is asynchronous.
 */

/** D1's cap on bound parameters in one statement; local SQLite allows far more. */
export const D1_MAX_BOUND_PARAMETERS = 100;

type Row = Record<string, SqlStorageValue>;

interface Executed {
  columns: string[];
  rows: SqlStorageValue[][];
  meta: D1Meta & Record<string, unknown>;
}

/** A D1 bind value as DO SQLite takes it: booleans as 0/1, byte views as their bytes. */
function toSqlValue(value: unknown, sql: string, index: number): SqlStorageValue {
  if (value === undefined) {
    throw new Error(
      `D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parameter ${index + 1} of: ${sql.slice(0, 120)})`,
    );
  }
  if (value === null || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new Error(
    `D1_TYPE_ERROR: Type '${typeof value}' not supported for parameter ${index + 1} of: ${sql.slice(0, 120)}`,
  );
}

class Statement {
  constructor(
    private readonly db: DurableObjectD1,
    readonly sql: string,
    readonly params: SqlStorageValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    if (values.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(
        `D1_ERROR: too many SQL variables: D1 accepts at most ${D1_MAX_BOUND_PARAMETERS} bound parameters, and this statement binds ${values.length}: ${this.sql.slice(0, 120)}`,
      );
    }
    return new Statement(
      this.db,
      this.sql,
      values.map((v, i) => toSqlValue(v, this.sql, i)),
    );
  }

  /** Run now, reading every row, and report what D1's `meta` would. */
  execute(): Executed {
    return this.db.execute(this.sql, this.params);
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const { columns, rows } = this.execute();
    const row = rows[0];
    if (column === undefined) {
      return row ? (toObject(columns, row) as T) : null;
    }
    if (!columns.includes(column)) {
      throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    }
    return row ? ((row[columns.indexOf(column)] ?? null) as T) : null;
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return toResult<T>(this.execute());
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return toResult<T>(this.execute());
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const { columns, rows } = this.execute();
    return (options?.columnNames ? [columns, ...rows] : rows) as T[];
  }
}

function toObject(columns: string[], row: SqlStorageValue[]): Row {
  const out: Row = {};
  columns.forEach((c, i) => {
    out[c] = row[i] ?? null;
  });
  return out;
}

function toResult<T>({ columns, rows, meta }: Executed): D1Result<T> {
  return { success: true, results: rows.map((r) => toObject(columns, r)) as T[], meta };
}

/** The adapter. Construct one per Durable Object, over its `ctx.storage`. */
export class DurableObjectD1 {
  constructor(private readonly storage: DurableObjectStorage) {}

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  async batch<T = Row>(statements: Statement[]): Promise<D1Result<T>[]> {
    for (const s of statements) {
      if (!(s instanceof Statement)) {
        throw new Error("D1_ERROR: batch() takes statements prepared on this database");
      }
    }
    return this.storage.transactionSync(() => statements.map((s) => toResult<T>(s.execute())));
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = Date.now();
    const cursor = this.storage.sql.exec(sql);
    cursor.toArray();
    // D1 reports the statements it ran; DO SQLite runs them as one call.
    const count = sql.split(";").filter((s) => s.trim() !== "").length;
    return { count, duration: Date.now() - start };
  }

  withSession(): never {
    throw new Error("D1_ERROR: withSession() is not supported by the demo's D1 adapter");
  }

  dump(): never {
    throw new Error("D1_ERROR: dump() is not supported by the demo's D1 adapter");
  }

  /** Run one statement, reading every row first so its writes have happened. */
  execute(sql: string, params: SqlStorageValue[]): Executed {
    const start = Date.now();
    const cursor = this.storage.sql.exec(sql, ...params);
    const columns = cursor.columnNames;
    const rows = Array.from(cursor.raw());
    const written = cursor.rowsWritten;
    // D1's `changes` counts the rows the statement changed. `rowsWritten` also counts index
    // writes, so it only says whether anything changed; SQLite's changes() says how many.
    const { changes, last_row_id } = this.storage.sql
      .exec<{ changes: number; last_row_id: number }>(
        "SELECT changes() AS changes, last_insert_rowid() AS last_row_id",
      )
      .one();
    return {
      columns,
      rows,
      meta: {
        duration: Date.now() - start,
        size_after: this.storage.sql.databaseSize,
        rows_read: cursor.rowsRead,
        rows_written: written,
        last_row_id,
        changed_db: written > 0,
        changes: written > 0 ? changes : 0,
      },
    };
  }

  /** As Kestrel's code sees it: the `D1Database` type. */
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

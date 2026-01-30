/**
 * Courier SQLite Driver (node:sqlite)
 *
 * Stable, zero-FFI SQLite driver built on Deno's built-in `node:sqlite` module.
 * This avoids native shared-library downloads and SIGSEGV issues.
 *
 * URL scheme:
 *   courier:sqlite:
 *
 * Supported forms:
 * - courier:sqlite::memory:
 * - courier:sqlite:file:./path/to/db.sqlite
 * - courier:sqlite:///absolute/or/relative/path.db
 */

import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
  type StatementSync,
} from "node:sqlite";
import {
  Courier,
  type CourierCapabilities,
  type CourierConnection,
  type CourierDropIn,
  CourierError,
  type CourierExecResult,
  type CourierFeature,
  type CourierMeta,
  type CourierObjectRowOptions,
  type CourierParams,
  type CourierResult,
  type CourierRowArray,
  type CourierRowObject,
  type CourierRowShape,
  type CourierTxOptions,
  toCourierError,
} from "./courier.ts";

/* ---------------------------------------------
 * URL parsing
 * ------------------------------------------- */

function parseSqliteUrl(url: string): string {
  const prefix = "courier:sqlite:";
  if (!url.startsWith(prefix)) {
    throw new CourierError(`Invalid sqlite URL: ${url}`, {
      code: "CONNECTION",
    });
  }

  const rest = url.slice(prefix.length);

  if (rest === ":memory:" || rest === "file::memory:") return ":memory:";
  if (rest.startsWith("file:")) return rest.slice("file:".length);
  if (rest.startsWith("//")) {
    const u = new URL("sqlite:" + rest);
    const p = decodeURIComponent(u.pathname || "");
    return p.startsWith("/") ? p.slice(1) : p;
  }

  return rest;
}

/* ---------------------------------------------
 * Helpers
 * ------------------------------------------- */

function toSqlNamedParams(
  params?: CourierParams,
): Record<string, SQLInputValue> | undefined {
  if (!params || Array.isArray(params)) return undefined;
  return params as Record<string, SQLInputValue>;
}

function toSqlPositionalParams(
  params?: CourierParams,
): readonly SQLInputValue[] | undefined {
  if (!params || !Array.isArray(params)) return undefined;
  return params as readonly SQLInputValue[];
}

function iterateRowsWithParams(
  stmt: StatementSync,
  params?: CourierParams,
): Iterable<Record<string, SQLOutputValue>> {
  const named = toSqlNamedParams(params);
  if (named) return stmt.iterate(named);
  const positional = toSqlPositionalParams(params);
  if (positional) {
    const args = [...positional] as SQLInputValue[];
    return stmt.iterate(...args);
  }
  return stmt.iterate();
}

function runStatementWithParams(
  stmt: StatementSync,
  params?: CourierParams,
): StatementResultingChanges {
  const named = toSqlNamedParams(params);
  if (named) return stmt.run(named);
  const positional = toSqlPositionalParams(params);
  if (positional) {
    const args = [...positional] as SQLInputValue[];
    return stmt.run(...args);
  }
  return stmt.run();
}

/* ---------------------------------------------
 * Drop-ins
 * ------------------------------------------- */

const DROPINS_TABLE = `".courier.d"`;

const DROPINS_SQL = `
CREATE TABLE IF NOT EXISTS ${DROPINS_TABLE} (
  path TEXT PRIMARY KEY,
  contents,
  elaboration TEXT,
  lastModified TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

function parseElaboration(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const parsed = JSON.parse(v);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------
 * Result implementation
 * ------------------------------------------- */

class SqliteCourierResult implements CourierResult {
  readonly columns?: readonly string[];
  readonly rowCount?: number;

  #stmt: StatementSync;
  #params?: CourierParams;
  #closed = false;

  constructor(stmt: StatementSync, params?: CourierParams) {
    this.#stmt = stmt;
    this.#params = params;
    this.columns = stmt.columns().map((c) => c.name);
  }

  #iterate() {
    return iterateRowsWithParams(this.#stmt, this.#params);
  }

  rows(): AsyncIterable<CourierRowArray>;
  rows(shape: "array"): AsyncIterable<CourierRowArray>;
  rows(shape: "object"): AsyncIterable<CourierRowObject>;
  rows<T>(shape: "object", opts: CourierObjectRowOptions<T>): AsyncIterable<T>;
  rows<T>(
    shape?: CourierRowShape,
    opts?: CourierObjectRowOptions<T>,
  ): AsyncIterable<CourierRowArray | CourierRowObject | T> {
    return this.#rowsImpl(shape, opts);
  }

  #rowsImpl<T>(
    shape?: CourierRowShape,
    opts?: CourierObjectRowOptions<T>,
  ): AsyncIterable<CourierRowArray | CourierRowObject | T> {
    const effective = shape ?? "array";
    const iterate = () => this.#iterate();
    const isClosed = () => this.#closed;

    if (effective === "array") {
      return (async function* () {
        for (const record of iterate()) {
          if (isClosed()) return;
          yield Object.values(record) as CourierRowArray;
        }
      })();
    }

    const transform = opts?.transform;
    if (transform) {
      return (async function* () {
        for (const record of iterate()) {
          if (isClosed()) return;
          yield transform(record as CourierRowObject);
        }
      })();
    }

    return (async function* () {
      for (const record of iterate()) {
        if (isClosed()) return;
        yield record as CourierRowObject;
      }
    })();
  }

  async all(): Promise<readonly CourierRowArray[]>;
  async all(shape: "array"): Promise<readonly CourierRowArray[]>;
  async all(shape: "object"): Promise<readonly CourierRowObject[]>;
  async all<T>(
    shape: "object",
    opts: CourierObjectRowOptions<T>,
  ): Promise<readonly T[]>;
  async all<T>(
    shape?: CourierRowShape,
    opts?: CourierObjectRowOptions<T>,
  ): Promise<readonly (CourierRowArray | CourierRowObject | T)[]> {
    const out: (CourierRowArray | CourierRowObject | T)[] = [];
    for await (const r of this.#rowsImpl(shape, opts)) out.push(r);
    return out;
  }

  async first(): Promise<CourierRowArray | undefined>;
  async first(shape: "array"): Promise<CourierRowArray | undefined>;
  async first(shape: "object"): Promise<CourierRowObject | undefined>;
  async first<T>(
    shape: "object",
    opts: CourierObjectRowOptions<T>,
  ): Promise<T | undefined>;
  async first<T>(
    shape?: CourierRowShape,
    opts?: CourierObjectRowOptions<T>,
  ): Promise<(CourierRowArray | CourierRowObject | T) | undefined> {
    for await (const r of this.#rowsImpl(shape, opts)) return r;
    return undefined;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return Promise.resolve();
  }
}

/* ---------------------------------------------
 * Connection implementation
 * ------------------------------------------- */

class SqliteCourierConnection implements CourierConnection {
  readonly url: string;
  readonly events = new EventTarget();
  readonly capabilities: CourierCapabilities;

  #db: DatabaseSync;
  #closed = false;

  constructor(url: string, db: DatabaseSync) {
    this.url = url;
    this.#db = db;
    this.capabilities = {
      supports: new Set<CourierFeature>([
        "transactions",
        "streaming",
        "namedParameters",
        "metadata.tables",
        "metadata.columns",
        "metadata.primaryKeys",
        "metadata.dropIns",
      ]),
    };
  }

  isClosed(): boolean {
    return this.#closed;
  }

  unwrap<T = unknown>(): T | undefined {
    return this.#db as unknown as T;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#db.close();
    this.#closed = true;
    return Promise.resolve();
  }

  query(sql: string, params?: CourierParams): Promise<CourierResult> {
    try {
      const stmt = this.#db.prepare(sql);
      return Promise.resolve(new SqliteCourierResult(stmt, params));
    } catch (e) {
      throw toCourierError(e);
    }
  }

  exec(sql: string, params?: CourierParams): Promise<CourierExecResult> {
    try {
      const stmt = this.#db.prepare(sql);
      const result = runStatementWithParams(stmt, params);
      return Promise.resolve({ changes: Number(result.changes) });
    } catch (e) {
      throw toCourierError(e);
    }
  }

  async tx<T>(
    fn: (c: CourierConnection) => Promise<T>,
    options?: CourierTxOptions,
  ): Promise<T> {
    const mode = options?.mode ?? "deferred";
    const begin = mode === "exclusive"
      ? "BEGIN EXCLUSIVE"
      : mode === "immediate"
      ? "BEGIN IMMEDIATE"
      : "BEGIN";

    await this.exec(begin);
    try {
      const out = await fn(this);
      await this.exec("COMMIT");
      return out;
    } catch (e) {
      await this.exec("ROLLBACK");
      throw e;
    }
  }

  meta(): Promise<CourierMeta> {
    const db = this.#db;
    const meta: CourierMeta = {
      product: { name: "SQLite" },
      driver: { name: "courier-sqlite-node", version: "1.0.0" },
      url: this.url,

      tables: () =>
        Promise.resolve(
          db
            .prepare(
              `select name, type from sqlite_master where name not like 'sqlite_%'`,
            )
            .all()
            .map((r: Record<string, SQLOutputValue>) => ({
              name: String(r.name ?? ""),
              type: String(r.type ?? ""),
            })),
        ),

      columns: ({ table }) =>
        Promise.resolve(
          db
            .prepare(`pragma table_info("${table}")`)
            .all()
            .map((r: Record<string, SQLOutputValue>) => ({
              table,
              name: String(r.name ?? ""),
              type: r.type ? String(r.type) : undefined,
              nullable: !(r.notnull ?? 0),
              default: r.dflt_value ?? undefined,
            })),
        ),

      primaryKeys: ({ table }) =>
        Promise.resolve(
          db
            .prepare(`pragma table_info("${table}")`)
            .all()
            .filter((r: Record<string, SQLOutputValue>) =>
              Number(r.pk ?? 0) > 0
            )
            .map((r: Record<string, SQLOutputValue>) => ({
              table,
              column: String(r.name ?? ""),
              seq: Number(r.pk ?? 0),
            })),
        ),

      dropIns: (filter) => {
        const stmt = db.prepare(
          `select path, contents, elaboration, lastModified from ${DROPINS_TABLE}`,
        );

        function* gen(
          filter?: (di: CourierDropIn) => boolean,
        ): IterableIterator<CourierDropIn> {
          for (const r of stmt.iterate()) {
            const path = typeof r.path === "string"
              ? r.path
              : String(r.path ?? "");
            const di: CourierDropIn = {
              path,
              contents: r.contents,
              elaboration: parseElaboration(r.elaboration),
              lastModified: toDate(r.lastModified),
            };
            if (!filter || filter(di)) yield di;
          }
        }

        return gen(filter);
      },
    };

    return Promise.resolve(meta);
  }
}

/* ---------------------------------------------
 * Driver registration
 * ------------------------------------------- */

export function registerCourierSqliteDriver() {
  Courier.register({
    name: "courier-sqlite-node",
    version: "1.0.0",

    accepts(url: string) {
      return url.startsWith("courier:sqlite:");
    },

    connect(url: string): Promise<CourierConnection> {
      const path = parseSqliteUrl(url);
      const db = new DatabaseSync(path);
      db.exec(DROPINS_SQL);
      return Promise.resolve(new SqliteCourierConnection(url, db));
    },
  });
}

registerCourierSqliteDriver();

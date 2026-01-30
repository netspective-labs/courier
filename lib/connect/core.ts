// lib/courier/courier.ts
/**
 * @module core
 * Courier Data Federation Library (Courier)
 *
 * Purpose
 * Courier is a JDBC-inspired, TypeScript-first federation surface for connecting to multiple data sources
 * (databases, engines, and future “drivers”) from Deno/TypeScript using a consistent API.
 *
 * Courier’s design goals are:
 * - Familiar conceptual model (Driver registry, Connection, Result, Metadata) similar to JDBC/ODBC
 * - Web-native observability (EventTarget + CustomEvent)
 * - TypeScript-native ergonomics (functional consumption, async iterables, typed transforms)
 * - Performance first by default (array rows)
 * - Safety when desired (object rows and typed transforms)
 * - Minimal v1 footprint (small number of files, minimal ceremony)
 *
 * Mental model (JDBC mapping)
 * - DriverManager        -> Courier (global singleton with register/connect)
 * - Driver              -> CourierDriver
 * - Connection          -> CourierConnection
 * - ResultSet           -> CourierResult (async iterable oriented)
 * - DatabaseMetaData    -> CourierMeta (subset, practical v1)
 * - SQLException        -> CourierError
 *
 * Row shapes (performance vs safety)
 * Courier supports two row representations. The consumer chooses at read time, similar to JDBC where you can
 * consume by column index or column name.
 *
 * 1) Arrays (default): `CourierRowArray`
 *    - Fastest representation
 *    - Equivalent to JDBC get-by-index usage
 *    - Consumer code uses numeric positions
 *
 * 2) Objects (opt-in): `CourierRowObject`
 *    - Safer representation (column names)
 *    - Equivalent to JDBC get-by-name usage
 *    - Can be further enhanced to typed objects via a transform callback
 *
 * Typed object enhancement
 * When consuming object rows, callers may supply a transform callback:
 *   result.rows<MyType>("object", { transform: (raw) => ({ ... }) })
 * This is intentionally consumer-defined. Drivers should not guess types. Drivers may normalize obvious values
 * (e.g., SQLite parseJson/int64 options), but typed output is a caller responsibility.
 *
 * Driver hints
 * Courier exposes query-time hints via `options.hints`, allowing a driver to select a more optimal internal
 * strategy without changing semantics. In v1, the primary hint is:
 *   hints.rowMode: "array" | "object"
 *
 * Notes:
 * - The consumer still chooses the final shape at read time via result.rows()/rows("object").
 * - Hints are advisory; drivers may ignore them.
 *
 * Observability and events
 * Courier uses EventTarget + CustomEvent for instrumentation. There are two event scopes:
 * - Courier.events (global)
 * - connection.events (per-connection)
 *
 * Drivers should aim to surface meaningful timing and error information. Courier wraps connection operations
 * so that a consistent set of events is emitted even if a driver implementation is minimal.
 *
 * Events (v1)
 * - courier:driver-registered
 * - courier:connect
 * - courier:close
 * - courier:query
 * - courier:exec
 * - courier:tx
 * - courier:error
 *
 * Result lifecycle
 * `CourierResult.close()` is always available so consumers can stop early and free underlying resources.
 * Drivers should finalize/close prepared statements when results are closed.
 *
 * Cancellation and timeouts
 * - `CourierQueryOptions.signal` should cause operations to abort quickly when possible.
 * - `CourierQueryOptions.timeoutMs` is enforced by Courier via a race.
 * - A driver may also implement its own tighter timeouts if supported.
 *
 * Metadata (CourierMeta)
 * CourierMeta is a practical subset of JDBC DatabaseMetaData that is sufficient to power basic tooling,
 * introspection, and UIs. Not all drivers can support all metadata calls.
 *
 * Drop Ins: CourierMeta.dropIns
 * Drop Ins are a Courier concept: a simple “filesystem-like” configuration abstraction embedded inside the data source.
 * It provides rows shaped like:
 *   { path, contents, elaboration?, lastModified }
 *
 * Drop Ins are intended for:
 * - Configuration stored inside the data source itself
 * - Plugin/extension settings
 * - Source-of-truth defaults and bootstrapping data
 *
 * V1 intentionally specifies the interface as synchronous iteration:
 *   meta.dropIns(filter?) => Iterator<CourierDropIn>
 * This keeps the surface area simple and works well for local embedded databases such as SQLite.
 * For remote databases, a future v2 may add an async drop-in iterator.
 *
 * Error model
 * CourierError provides a small set of stable categories, independent of vendor-specific codes.
 * Drivers should map vendor errors into CourierError when feasible.
 *
 * Extension strategy (v2+)
 * Courier v1 avoids a large surface area. Future enhancements should be added as:
 * - capabilities flags (feature discovery)
 * - hints (driver optimization)
 * - optional `conn.ext.*` namespaces or `unwrap()` for driver-specific access
 *
 * Maintenance guidance (for humans and AI)
 * 1) Preserve the core ergonomics: connect/query/exec/tx and default array rows.
 * 2) Preserve the “consumer chooses shape at read time” rule.
 * 3) Keep driver contracts minimal. Drivers should not be forced to implement large metadata catalogs.
 * 4) Add features behind capabilities flags and optional methods.
 * 5) Never break the default behavior: `result.rows()` must yield arrays in stable column order.
 * 6) When adding new events, keep payloads serializable and avoid leaking secrets.
 */

import { z } from "@zod";
import type { SchemaSQLBuilder } from "./safe-sql.ts";
import {
  isSQL,
  type SQL,
  type SQLQuery,
  type SQLTextInput,
  toSQLQuery,
} from "./sql-text.ts";

export type CourierRowObject = Readonly<Record<string, unknown>>;
export type CourierRowArray = readonly unknown[];
export type CourierRowShape = "array" | "object";

export type CourierParams =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>
  | undefined;

export type CourierFeature =
  | "transactions"
  | "batch"
  | "returning"
  | "namedParameters"
  | "streaming"
  | "metadata.tables"
  | "metadata.columns"
  | "metadata.primaryKeys"
  | "metadata.dropIns"
  | "hints.rowMode";

export type CourierCapabilities = Readonly<{
  supports: ReadonlySet<CourierFeature>;
  notes?: Readonly<Record<string, string>>;
}>;

export type CourierQueryHints = Readonly<{
  // Driver hint: prefer producing rows in this mode natively when possible.
  // Consumer still chooses final shape at read time.
  rowMode?: CourierRowShape;
}>;

export type CourierQueryOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  tag?: string;
  hints?: CourierQueryHints;
}>;

export type CourierTxMode = "deferred" | "immediate" | "exclusive";

export type CourierTxOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  tag?: string;
  mode?: CourierTxMode;
}>;

export type CourierMetaTablesQuery = Readonly<{
  schema?: string;
  like?: string;
}>;

export type CourierMetaColumnsQuery = Readonly<{
  schema?: string;
  table: string;
}>;

export type CourierMetaPrimaryKeysQuery = Readonly<{
  schema?: string;
  table: string;
}>;

export const courierDropInSchema = z.object({
  path: z.string(),
  contents: z.unknown(),
  elaboration: z
    .record(z.string(), z.unknown())
    .optional(),
  lastModified: z.date(),
});

export type CourierDropIn = z.infer<typeof courierDropInSchema>;
export type CourierDropInSQL = SchemaSQLBuilder<
  typeof courierDropInSchema extends z.ZodObject<infer S> ? S : never
>;

export type CourierMeta = Readonly<{
  product: { name: string; version?: string };
  driver: { name: string; version: string };
  url: string;

  tables?(
    q?: CourierMetaTablesQuery,
  ): Promise<readonly { schema?: string; name: string; type?: string }[]>;
  columns?(
    q: CourierMetaColumnsQuery,
  ): Promise<
    readonly {
      table: string;
      name: string;
      type?: string;
      nullable?: boolean;
      default?: unknown;
    }[]
  >;
  primaryKeys?(
    q: CourierMetaPrimaryKeysQuery,
  ): Promise<
    readonly { table: string; column: string; seq?: number; name?: string }[]
  >;

  // Courier Drop Ins: filesystem-like config stored inside the data source.
  dropIns?(
    filter?: (di: CourierDropIn) => boolean,
  ): IterableIterator<CourierDropIn>;
}>;

export type CourierObjectRowOptions<T> = Readonly<{
  transform?: (raw: CourierRowObject) => T;
}>;

export type CourierResult = Readonly<{
  columns?: readonly string[];
  rowCount?: number;

  // Default: arrays (fast, JDBC-index-style).
  // `rows` yields rows via AsyncIterable; default and explicit shapes supported.
  rows(): AsyncIterable<CourierRowArray>;
  rows(shape: "array"): AsyncIterable<CourierRowArray>;
  rows(shape: "object"): AsyncIterable<CourierRowObject>;
  rows<T>(
    shape: "object",
    opts: CourierObjectRowOptions<T>,
  ): AsyncIterable<T>;

  // `all` resolves to all rows at once; default and explicit shapes supported.
  all(): Promise<readonly CourierRowArray[]>;
  all(shape: "array"): Promise<readonly CourierRowArray[]>;
  all(shape: "object"): Promise<readonly CourierRowObject[]>;
  all<T>(
    shape: "object",
    opts: CourierObjectRowOptions<T>,
  ): Promise<readonly T[]>;

  // `first` resolves to the first row; default and explicit shapes supported.
  first(): Promise<CourierRowArray | undefined>;
  first(shape: "array"): Promise<CourierRowArray | undefined>;
  first(shape: "object"): Promise<CourierRowObject | undefined>;
  first<T>(
    shape: "object",
    opts: CourierObjectRowOptions<T>,
  ): Promise<T | undefined>;

  close(): Promise<void>;
}>;

export type CourierExecResult = Readonly<{
  changes?: number;
  lastInsertId?: unknown;
}>;

export type CourierConnection = Readonly<{
  url: string;
  capabilities: CourierCapabilities;
  events: EventTarget;

  query(
    sql: string,
    params?: CourierParams,
    options?: CourierQueryOptions,
  ): Promise<CourierResult>;
  query(sql: SQL, options?: CourierQueryOptions): Promise<CourierResult>;
  query(sql: SQLQuery, options?: CourierQueryOptions): Promise<CourierResult>;
  exec(
    sql: string,
    params?: CourierParams,
    options?: CourierQueryOptions,
  ): Promise<CourierExecResult>;
  exec(sql: SQL, options?: CourierQueryOptions): Promise<CourierExecResult>;
  exec(
    sql: SQLQuery,
    options?: CourierQueryOptions,
  ): Promise<CourierExecResult>;

  tx<T>(
    fn: (c: CourierConnection) => Promise<T>,
    options?: CourierTxOptions,
  ): Promise<T>;

  meta(): Promise<CourierMeta>;

  close(): Promise<void>;
  isClosed(): boolean;

  unwrap<T = unknown>(): T | undefined;
}>;

export interface CourierDriver {
  readonly name: string;
  readonly version: string;

  accepts(url: string): boolean;

  connect(
    url: string,
    options?: Readonly<Record<string, string>>,
  ): Promise<CourierConnection>;
}

export type CourierEventMap = {
  "courier:driver-registered": { driver: { name: string; version: string } };

  "courier:connect": {
    url: string;
    driver: { name: string; version: string };
    durationMs: number;
  };
  "courier:close": { url: string; driver: { name: string; version: string } };

  "courier:query": {
    url: string;
    driver: { name: string; version: string };
    sql: string;
    paramsKind: "none" | "array" | "object";
    tag?: string;
    durationMs: number;
    rowCount?: number;
  };

  "courier:exec": {
    url: string;
    driver: { name: string; version: string };
    sql: string;
    paramsKind: "none" | "array" | "object";
    tag?: string;
    durationMs: number;
    changes?: number;
  };

  "courier:tx": {
    url: string;
    driver: { name: string; version: string };
    tag?: string;
    mode?: CourierTxMode;
    phase: "begin" | "commit" | "rollback";
    durationMs?: number;
  };

  "courier:error": {
    url?: string;
    driver?: { name: string; version: string };
    sql?: string;
    tag?: string;
    error: CourierError;
  };
};

export class CourierError extends Error {
  readonly code:
    | "CONNECTION"
    | "TIMEOUT"
    | "CANCELLED"
    | "SYNTAX"
    | "CONSTRAINT"
    | "NOT_SUPPORTED"
    | "IO"
    | "UNKNOWN";

  readonly sqlState?: string;
  readonly vendorCode?: string | number;
  readonly retryable?: boolean;
  override readonly cause?: unknown;

  constructor(
    message: string,
    init?: Partial<
      Pick<
        CourierError,
        "code" | "sqlState" | "vendorCode" | "retryable" | "cause"
      >
    >,
  ) {
    super(message);
    this.name = "CourierError";
    this.code = init?.code ?? "UNKNOWN";
    this.sqlState = init?.sqlState;
    this.vendorCode = init?.vendorCode;
    this.retryable = init?.retryable;
    this.cause = init?.cause;
  }
}

function normalizeSqlInput(
  sql: SQLTextInput,
  params?: CourierParams,
): { text: string; params?: CourierParams } {
  if (typeof sql === "string") {
    return { text: sql, params };
  }
  if (params !== undefined) {
    throw new CourierError(
      "Cannot provide positional or named parameters when executing a SQL tagged template/query object",
      { code: "SYNTAX", sqlState: "0A000" },
    );
  }
  const normalized = toSQLQuery(sql);
  return { text: normalized.text, params: normalized.values };
}

export class CourierFeatureNotSupportedError extends CourierError {
  constructor(message = "Feature not supported") {
    super(message, { code: "NOT_SUPPORTED", sqlState: "0A000" });
    this.name = "CourierFeatureNotSupportedError";
  }
}

export const Courier = (() => {
  const drivers: CourierDriver[] = [];
  const events = new EventTarget();

  function dispatch<K extends keyof CourierEventMap>(
    type: K,
    detail: CourierEventMap[K],
  ) {
    events.dispatchEvent(new CustomEvent(String(type), { detail }));
  }

  function paramsKind(params?: CourierParams): "none" | "array" | "object" {
    if (params === undefined) return "none";
    return Array.isArray(params) ? "array" : "object";
  }

  function abortIfNeeded(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new CourierError("Operation cancelled", { code: "CANCELLED" });
    }
  }

  function withTimeout<T>(
    p: Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return p;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);

    const raced = Promise.race([
      p,
      new Promise<T>((_, reject) => {
        const onAbort = () =>
          reject(new CourierError("Operation timed out", { code: "TIMEOUT" }));
        ctrl.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]).finally(() => clearTimeout(timer));

    if (signal) {
      signal.addEventListener("abort", () => ctrl.abort("cancel"), {
        once: true,
      });
    }
    return raced;
  }

  function pickDriver(url: string): CourierDriver {
    for (const d of drivers) if (d.accepts(url)) return d;
    throw new CourierError(`No suitable Courier driver for URL: ${url}`, {
      code: "CONNECTION",
      sqlState: "08001",
    });
  }

  return {
    events,

    register(driver: CourierDriver) {
      drivers.unshift(driver);
      dispatch("courier:driver-registered", {
        driver: { name: driver.name, version: driver.version },
      });
    },

    getDrivers(): readonly CourierDriver[] {
      return drivers;
    },

    async connect(
      url: string,
      options?: Readonly<Record<string, string>>,
    ): Promise<CourierConnection> {
      const driver = pickDriver(url);
      const t0 = performance.now();

      try {
        const conn = await driver.connect(url, options);
        const dt = performance.now() - t0;
        dispatch("courier:connect", {
          url,
          driver: { name: driver.name, version: driver.version },
          durationMs: dt,
        });

        const connEvents = new EventTarget();

        const wrapped: CourierConnection = {
          url,
          capabilities: conn.capabilities,
          events: connEvents,

          query: async (
            sql: string | SQL | SQLQuery,
            params?: CourierParams,
            opts?: CourierQueryOptions,
          ) => {
            const normalized = normalizeSqlInput(sql, params);
            abortIfNeeded(opts?.signal);
            const t1 = performance.now();
            try {
              let driverPromise: Promise<CourierResult>;
              if (typeof sql === "string") {
                driverPromise = conn.query(
                  normalized.text,
                  normalized.params,
                  opts,
                );
              } else if (isSQL(sql)) {
                driverPromise = conn.query(sql, opts);
              } else {
                driverPromise = conn.query(sql, opts);
              }
              const res = await withTimeout(
                driverPromise,
                opts?.timeoutMs,
                opts?.signal,
              );
              const dt1 = performance.now() - t1;
              const kind = paramsKind(normalized.params);
              const payload = {
                url,
                driver: { name: driver.name, version: driver.version },
                sql: normalized.text,
                paramsKind: kind,
                tag: opts?.tag,
                durationMs: dt1,
                rowCount: res.rowCount,
              };
              events.dispatchEvent(
                new CustomEvent("courier:query", { detail: payload }),
              );
              connEvents.dispatchEvent(
                new CustomEvent("courier:query", { detail: payload }),
              );
              return res;
            } catch (e) {
              const err = toCourierError(e);
              const payload = {
                url,
                driver: { name: driver.name, version: driver.version },
                sql: normalized.text,
                tag: opts?.tag,
                error: err,
              };
              events.dispatchEvent(
                new CustomEvent("courier:error", { detail: payload }),
              );
              connEvents.dispatchEvent(
                new CustomEvent("courier:error", { detail: payload }),
              );
              throw err;
            }
          },

          exec: async (
            sql: string | SQL | SQLQuery,
            params?: CourierParams,
            opts?: CourierQueryOptions,
          ) => {
            const normalized = normalizeSqlInput(sql, params);
            abortIfNeeded(opts?.signal);
            const t1 = performance.now();
            try {
              let driverPromise: Promise<CourierExecResult>;
              if (typeof sql === "string") {
                driverPromise = conn.exec(
                  normalized.text,
                  normalized.params,
                  opts,
                );
              } else if (isSQL(sql)) {
                driverPromise = conn.exec(sql, opts);
              } else {
                driverPromise = conn.exec(sql, opts);
              }
              const out = await withTimeout(
                driverPromise,
                opts?.timeoutMs,
                opts?.signal,
              );
              const dt1 = performance.now() - t1;
              const kind = paramsKind(normalized.params);
              const payload = {
                url,
                driver: { name: driver.name, version: driver.version },
                sql: normalized.text,
                paramsKind: kind,
                tag: opts?.tag,
                durationMs: dt1,
                changes: out.changes,
              };
              events.dispatchEvent(
                new CustomEvent("courier:exec", { detail: payload }),
              );
              connEvents.dispatchEvent(
                new CustomEvent("courier:exec", { detail: payload }),
              );
              return out;
            } catch (e) {
              const err = toCourierError(e);
              const payload = {
                url,
                driver: { name: driver.name, version: driver.version },
                sql: normalized.text,
                tag: opts?.tag,
                error: err,
              };
              events.dispatchEvent(
                new CustomEvent("courier:error", { detail: payload }),
              );
              connEvents.dispatchEvent(
                new CustomEvent("courier:error", { detail: payload }),
              );
              throw err;
            }
          },

          tx: async (fn, opts) => {
            abortIfNeeded(opts?.signal);
            const tag = opts?.tag;
            const mode = opts?.mode;

            connEvents.dispatchEvent(
              new CustomEvent("courier:tx", {
                detail: {
                  url,
                  driver: { name: driver.name, version: driver.version },
                  tag,
                  mode,
                  phase: "begin",
                },
              }),
            );
            events.dispatchEvent(
              new CustomEvent("courier:tx", {
                detail: {
                  url,
                  driver: { name: driver.name, version: driver.version },
                  tag,
                  mode,
                  phase: "begin",
                },
              }),
            );

            const t1 = performance.now();
            try {
              const out = await withTimeout(
                conn.tx(fn, opts),
                opts?.timeoutMs,
                opts?.signal,
              );
              const dt1 = performance.now() - t1;

              connEvents.dispatchEvent(
                new CustomEvent("courier:tx", {
                  detail: {
                    url,
                    driver: { name: driver.name, version: driver.version },
                    tag,
                    mode,
                    phase: "commit",
                    durationMs: dt1,
                  },
                }),
              );
              events.dispatchEvent(
                new CustomEvent("courier:tx", {
                  detail: {
                    url,
                    driver: { name: driver.name, version: driver.version },
                    tag,
                    mode,
                    phase: "commit",
                    durationMs: dt1,
                  },
                }),
              );

              return out;
            } catch (e) {
              const dt1 = performance.now() - t1;

              connEvents.dispatchEvent(
                new CustomEvent("courier:tx", {
                  detail: {
                    url,
                    driver: { name: driver.name, version: driver.version },
                    tag,
                    mode,
                    phase: "rollback",
                    durationMs: dt1,
                  },
                }),
              );
              events.dispatchEvent(
                new CustomEvent("courier:tx", {
                  detail: {
                    url,
                    driver: { name: driver.name, version: driver.version },
                    tag,
                    mode,
                    phase: "rollback",
                    durationMs: dt1,
                  },
                }),
              );

              const err = toCourierError(e);
              const payload = {
                url,
                driver: { name: driver.name, version: driver.version },
                tag,
                error: err,
              };
              events.dispatchEvent(
                new CustomEvent("courier:error", { detail: payload }),
              );
              connEvents.dispatchEvent(
                new CustomEvent("courier:error", { detail: payload }),
              );
              throw err;
            }
          },

          meta: () => conn.meta(),

          close: async () => {
            await conn.close();
            dispatch("courier:close", {
              url,
              driver: { name: driver.name, version: driver.version },
            });
            connEvents.dispatchEvent(
              new CustomEvent("courier:close", {
                detail: {
                  url,
                  driver: { name: driver.name, version: driver.version },
                },
              }),
            );
          },

          isClosed: () => conn.isClosed(),
          unwrap: () => conn.unwrap(),
        };

        return wrapped;
      } catch (e) {
        const err = toCourierError(e);
        dispatch("courier:error", {
          url,
          driver: { name: driver.name, version: driver.version },
          error: err,
        });
        throw err;
      }
    },

    // Minimal pooling DataSource (practical v1).
    datasource(url: string, cfg?: Readonly<{ pool?: { max?: number } }>) {
      const max = cfg?.pool?.max ?? 10;
      const idle: CourierConnection[] = [];
      let created = 0;
      const waiters: Array<(c: CourierConnection) => void> = [];

      const dsEvents = new EventTarget();

      async function acquire(): Promise<CourierConnection> {
        if (idle.length) return idle.pop()!;
        if (created < max) {
          created++;
          const c = await Courier.connect(url);
          return wrapLease(c);
        }
        return await new Promise<CourierConnection>((resolve) =>
          waiters.push(resolve)
        );
      }

      function release(c: CourierConnection) {
        const w = waiters.shift();
        if (w) w(c);
        else idle.push(c);
      }

      function wrapLease(c: CourierConnection): CourierConnection {
        let returned = false;
        return {
          ...c,
          events: c.events,
          close: () => {
            if (returned) return Promise.resolve();
            returned = true;
            release(c);
            return Promise.resolve();
          },
        };
      }

      return {
        url,
        events: dsEvents,
        async getConnection(): Promise<CourierConnection> {
          const c = await acquire();
          dsEvents.dispatchEvent(
            new CustomEvent("courier:datasource-lease", { detail: { url } }),
          );
          return c;
        },
        async closeAll(): Promise<void> {
          for (const c of idle.splice(0)) await c.close().catch(() => {});
          created = 0;
        },
      };
    },
  };
})();

export function toCourierError(e: unknown): CourierError {
  if (e instanceof CourierError) return e;

  if (
    e && typeof e === "object" && "name" in e &&
    (e as { name?: unknown }).name === "AbortError"
  ) {
    return new CourierError("Operation cancelled", {
      code: "CANCELLED",
      cause: e,
    });
  }

  const msg = e instanceof Error ? e.message : String(e);
  return new CourierError(msg, { code: "UNKNOWN", cause: e });
}

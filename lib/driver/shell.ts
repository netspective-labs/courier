// lib/driver/shell.ts
/**
 * @module driver/shell
 * Courier "Shell SQL Driver"
 *
 * This driver makes Courier behave like a normal SQL connection, but instead of
 * talking to a DB library, it executes SQL through spawned CLI runtimes that can
 * emit JSON result sets (sqlite3, duckdb, psql, surveilr shell, etc.).
 *
 * Why this exists
 * - Consistency: call sites use Courier once and swap engines via connection URL.
 * - Testability: deterministic "execution plans" (argv/stdin/env/temp files) are
 *   easy to snapshot and unit test.
 * - Swap-ability: switch between sqlite3/duckdb/psql/surveilr without changing
 *   Courier call sites.
 *
 * Core idea
 * - Normalize SQL input (string | SQL | SQLQuery) into `{ text, params }`.
 * - Convert to an engine-specific deterministic ExecutionPlan.
 * - Execute via an embedded spawn helper (argv-only, no implicit system shell).
 * - Parse stdout into a CourierResult (default rows are arrays).
 *
 * URLs
 * - Driver prefix: `courier:shell:`
 * - Format: `courier:shell:<engineId>:<target>`
 *   Examples:
 *     - courier:shell:sqlite3:file:./db.sqlite
 *     - courier:shell:duckdb:file:./db.duckdb
 *     - courier:shell:psql://user@host:5432/dbname
 *     - courier:shell:surveilr-sqlite:file:./db.sqlite
 *
 * Query parameters (optional)
 * - mode=stdin|file|auto           (defaults to engine.preferredMode)
 * - bin=/path/to/binary            (override engine default binary)
 * - extraArgs=JSON_ARRAY           (additional argv to append)
 *
 * Connect options (Courier.connect(url, options))
 * - init=JSON_OBJECT               (engine init object; must be tagged or will be tagged)
 * - mode=stdin|file|auto
 * - bin=/path/to/binary
 * - extraArgs=JSON_ARRAY
 * - env=JSON_OBJECT                (env overrides)
 *
 * Notes / constraints
 * - This implementation does NOT keep an interactive process alive, so true
 *   multi-statement transactions across multiple Courier calls are not supported.
 * - Engines are expected to produce JSON on stdout for SELECT-like queries.
 * - Exec operations may return `changes` when the engine can provide it; otherwise undefined.
 */

import {
  Courier,
  type CourierCapabilities,
  type CourierConnection,
  CourierError,
  type CourierExecResult,
  type CourierFeature,
  CourierFeatureNotSupportedError,
  type CourierMeta,
  type CourierObjectRowOptions,
  type CourierParams,
  type CourierResult,
  type CourierRowArray,
  type CourierRowObject,
  type CourierRowShape,
  type CourierTxOptions,
  toCourierError,
} from "../connect/core.ts";

import {
  isSQL,
  type SQL,
  type SQLQuery,
  toSQLQuery,
} from "../connect/sql-text.ts";

export function eventBus<M extends Record<string, unknown | void>>() {
  type Key = Extract<keyof M, string>;
  type Detail<K extends Key> = M[K];
  type Args<K extends Key> = Detail<K> extends void ? [] : [Detail<K>];

  type ListenerFn<K extends Key> = (...args: Args<K>) => void | Promise<void>;
  type ListenerObj<K extends Key> = { handle: ListenerFn<K> };
  type Listener<K extends Key> = ListenerFn<K> | ListenerObj<K>;

  type UnknownListener =
    | ((...args: readonly unknown[]) => void | Promise<void>)
    | { handle: (...args: readonly unknown[]) => void | Promise<void> };

  type AllFn = <K extends Key>(
    type: K,
    detail: Detail<K>,
  ) => void | Promise<void>;

  const target = new EventTarget();
  const listenerMap = new Map<Key, Map<UnknownListener, EventListener>>();
  const muted = new Set<Key>();
  const allListeners = new Set<AllFn>();
  let suspended = false;

  const ensureMap = <K extends Key>(type: K) => {
    if (!listenerMap.has(type)) listenerMap.set(type, new Map());
    return listenerMap.get(type)! as unknown as Map<Listener<K>, EventListener>;
  };

  const callUser = <K extends Key>(l: Listener<K>, args: Args<K>) => {
    if (typeof l === "function") return l(...args);
    return l.handle(...args);
  };

  const toDomHandler = <K extends Key>(
    type: K,
    listener: Listener<K>,
    onceCleanup?: boolean,
  ): EventListener => {
    return (ev) => {
      const ce = ev as CustomEvent<Detail<K>>;
      const args = (ce.detail === undefined ? [] : [ce.detail]) as Args<K>;
      void callUser(listener, args);
      if (onceCleanup) {
        const map = listenerMap.get(type);
        map?.delete(listener as unknown as UnknownListener);
      }
    };
  };

  const notifyAll = <K extends Key>(type: K, detail: Detail<K>) => {
    for (const fn of allListeners) void fn(type, detail);
  };

  const api = {
    on<K extends Key>(
      type: K,
      listener: Listener<K>,
      opts?: boolean | AddEventListenerOptions,
    ) {
      const map = ensureMap(type);
      if (map.has(listener)) return () => api.off(type, listener);
      const h = toDomHandler(type, listener);
      map.set(listener, h);
      target.addEventListener(type, h, opts);
      return () => api.off(type, listener);
    },

    once<K extends Key>(type: K, listener: Listener<K>) {
      const map = ensureMap(type);
      if (map.has(listener)) return () => api.off(type, listener);
      const h = toDomHandler(type, listener, true);
      map.set(listener, h);
      target.addEventListener(type, h, { once: true });
      return () => api.off(type, listener);
    },

    off<K extends Key>(type: K, listener: Listener<K>) {
      const map = ensureMap(type);
      const h = map.get(listener);
      if (h) {
        target.removeEventListener(type, h);
        map.delete(listener);
        if (map.size === 0) listenerMap.delete(type);
      }
    },

    emit<K extends Key>(type: K, detail: Detail<K>) {
      if (suspended || muted.has(type)) return false;
      const dispatched = target.dispatchEvent(
        new CustomEvent(type, { detail }),
      );
      notifyAll(type, detail);
      return dispatched;
    },

    async emitParallel<K extends Key>(type: K, ...detail: Args<K>) {
      if (suspended || muted.has(type)) return;
      const handlers = api.rawListeners(type);
      const args = (detail.length ? [detail[0]] : []) as Args<K>;
      await Promise.all(handlers.map((l) => callUser(l, args)));
      notifyAll(type, (detail.length ? detail[0] : undefined) as Detail<K>);
    },

    rawListeners<K extends Key>(type: K) {
      const map = ensureMap(type);
      return Object.freeze(Array.from(map.keys())) as readonly Listener<K>[];
    },

    all(listener: AllFn) {
      allListeners.add(listener);
      return () => allListeners.delete(listener);
    },

    mute<K extends Key>(type: K) {
      muted.add(type);
    },
    unmute<K extends Key>(type: K) {
      muted.delete(type);
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
    },

    target,
  } as const;

  return api;
}

// Add this to lib/driver/shell.ts (near the event bus types), and then call it
// from callers via conn.unwrap().bus (or wire it into connect options if you want).

type ShellDiagnosticsOptions = Readonly<{
  enabled?: boolean; // default true
  prefix?: string; // default "courier:shell"
  showEnv?: "none" | "keys" | "full"; // default false (env can contain secrets)
  showStdin?: "none" | "preview" | "full"; // default "preview"
  stdinPreviewBytes?: number; // default 240
  showStderr?: "none" | "preview" | "full"; // default "preview"
  stderrPreviewBytes?: number; // default 240
  showStdout?: "none" | "preview"; // default "none"
  stdoutPreviewBytes?: number; // default 240
  dimPaths?: boolean; // default true
}>;

function ansi(enabled: boolean) {
  const wrap = (open: string, close: string) => (s: string) =>
    enabled ? `${open}${s}${close}` : s;

  return {
    faint: wrap("\x1b[2m", "\x1b[22m"),
    bold: wrap("\x1b[1m", "\x1b[22m"),
    red: wrap("\x1b[31m", "\x1b[39m"),
    green: wrap("\x1b[32m", "\x1b[39m"),
    yellow: wrap("\x1b[33m", "\x1b[39m"),
    blue: wrap("\x1b[34m", "\x1b[39m"),
    magenta: wrap("\x1b[35m", "\x1b[39m"),
    cyan: wrap("\x1b[36m", "\x1b[39m"),
    gray: wrap("\x1b[90m", "\x1b[39m"),
  } as const;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KiB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MiB`;
}

function previewText(u8: Uint8Array, maxBytes: number) {
  const slice = u8.byteLength > maxBytes ? u8.slice(0, maxBytes) : u8;
  const text = new TextDecoder().decode(slice);
  const trimmed = text.replace(/\s+$/g, "");
  const suffix = u8.byteLength > maxBytes
    ? ` …(+${u8.byteLength - maxBytes} bytes)`
    : "";
  return `${trimmed}${suffix}`;
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function maybeDimPath(
  s: string,
  dim: (x: string) => string,
  dimPaths: boolean,
) {
  if (!dimPaths) return s;
  // crude heuristic: dim anything that looks like a path
  if (s.includes("/") || s.includes("\\") || s.startsWith("file:")) {
    return dim(s);
  }
  return s;
}

export function prettyShellDiagnostics(
  bus: ReturnType<typeof eventBus<ShellBusEvents>>,
  opts: ShellDiagnosticsOptions = {},
) {
  const enabled = opts.enabled ?? true;
  if (!enabled) return { dispose: () => {} };

  const colorEnabled = !Deno.noColor && Boolean(Deno.stdout.isTerminal?.());
  const c = ansi(colorEnabled);

  const prefix = opts.prefix ?? "courier:shell";
  const showEnv = opts.showEnv ?? false;
  const showStdin = opts.showStdin ?? "preview";
  const stdinPreviewBytes = opts.stdinPreviewBytes ?? 240;
  const showStderr = opts.showStderr ?? "preview";
  const stderrPreviewBytes = opts.stderrPreviewBytes ?? 240;
  const showStdout = opts.showStdout ?? "none";
  const stdoutPreviewBytes = opts.stdoutPreviewBytes ?? 240;
  const dimPaths = opts.dimPaths ?? true;

  const line = (tag: string, msg: string) => {
    // tag is already colored
    console.log(`${c.gray(prefix)} ${tag} ${msg}`);
  };

  const offAll: Array<() => void> = [];

  offAll.push(
    bus.on("plan", (d) => {
      const tag = c.cyan("[plan]");
      const cmd = c.bold(d.cmd);
      const args = d.args.map((a) => maybeDimPath(a, c.faint, dimPaths)).join(
        " ",
      );
      const mode = d.mode === "stdin" ? c.magenta("stdin") : c.yellow(d.mode);
      const op = d.op === "query" ? c.blue("query") : c.blue("exec");

      const flags = [
        `${c.gray("engine")}=${c.bold(d.engineId)}`,
        `${c.gray("op")}=${op}`,
        `${c.gray("mode")}=${mode}`,
        d.hasStdin ? c.magenta("stdin") : c.gray("no-stdin"),
        d.usesTempFile ? c.yellow("tempfile") : c.gray("no-tempfile"),
      ].join(" ");

      line(tag, `${flags}\n  ${cmd} ${args}`);
    }),
  );

  offAll.push(
    bus.on("spawn:start", ({ cmd, args, stdin, env }) => {
      line(c.cyan("$"), c.bold([cmd, ...args].join(" ")));

      switch (showEnv) {
        case "none":
          break;
        case "keys":
          if (env) line(c.faint("[env]"), Object.keys(env).join(", "));
          break;
        case "full":
          if (env) {
            for (const [k, v] of Object.entries(env)) {
              line(c.faint("[env]"), `${k}=${v}`);
            }
          }
          break;
      }

      if (!stdin) return;

      const bytes = stdin.byteLength;

      if (showStdin === "none") {
        line(c.faint("[stdin]"), `${bytes} bytes`);
        return;
      }

      const text = new TextDecoder().decode(
        showStdin === "full" ? stdin : stdin.slice(0, stdinPreviewBytes),
      );

      const suffix = showStdin === "preview" && bytes > stdinPreviewBytes
        ? c.faint(` … (+${bytes - stdinPreviewBytes} bytes)`)
        : "";

      line(
        c.magenta("[stdin]"),
        c.faint(text) + suffix,
      );
    }),
  );

  offAll.push(
    bus.on("tempfile", (d) => {
      const tag = c.yellow("[tempfile]");
      const p = maybeDimPath(d.path, c.faint, dimPaths);
      line(tag, `${c.gray(d.kind)} ${p} (${formatBytes(d.bytes)})`);
    }),
  );

  offAll.push(
    bus.on("tempfile:cleanup", (d) => {
      const tag = d.ok ? c.green("[cleanup]") : c.red("[cleanup]");
      const p = maybeDimPath(d.path, c.faint, dimPaths);
      line(tag, d.ok ? p : `${p} ${c.red("failed")} ${safeJson(d.error)}`);
    }),
  );

  // If you want stdin/file content diagnostics, the bus currently doesn’t emit the
  // raw stdin bytes or the temp file contents. We can still show a hint using the
  // plan flags + tempfile path. For true stdin preview, add a tiny bus emit inside
  // spawnArgv() before writing to child.stdin (recommended below).
  //
  // Optional improvement (recommended): in spawnArgv(), emit:
  //   bus?.emit("stdin", { bytes: stdin.byteLength, preview: ... })
  //
  // For now we show stdout/stderr on completion.

  offAll.push(
    bus.on("spawn:done", (d) => {
      const ok = d.success && d.code === 0;
      const tag = ok ? c.green("[done]") : c.red("[done]");
      const status = ok ? c.green("ok") : c.red(`exit=${d.code}`);
      const dur = c.gray(`${Math.round(d.durationMs)}ms`);
      line(
        tag,
        `${status} ${dur} ${c.gray("stdout")}=${
          formatBytes(d.stdout.byteLength)
        } ${c.gray("stderr")}=${formatBytes(d.stderr.byteLength)}`,
      );

      if (d.stderr.byteLength && showStderr !== "none") {
        const body = showStderr === "full"
          ? new TextDecoder().decode(d.stderr)
          : previewText(d.stderr, stderrPreviewBytes);
        line(c.red("[stderr]"), c.faint(body));
      }

      if (d.stdout.byteLength && showStdout !== "none") {
        const body = showStdout === "preview"
          ? previewText(d.stdout, stdoutPreviewBytes)
          : "(stdout omitted)";
        line(c.gray("[stdout]"), c.faint(body));
      }
    }),
  );

  offAll.push(
    bus.on("spawn:error", (d) => {
      const tag = c.red("[error]");
      const cmd = c.bold(d.cmd);
      const args = d.args.map((a) => maybeDimPath(a, c.faint, dimPaths)).join(
        " ",
      );
      line(tag, `${cmd} ${args}\n  ${safeJson(d.error)}`);
    }),
  );

  offAll.push(
    bus.on("parse", (d) => {
      const tag = d.ok ? c.green("[parse]") : c.red("[parse]");
      const kind = d.kind ? c.gray(d.kind) : c.gray("unknown");
      line(tag, `${kind} ${formatBytes(d.bytes)}`);
    }),
  );

  return {
    dispose() {
      for (const off of offAll) off();
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Spawning / shell execution infrastructure
 * ------------------------------------------------------------------------------------------------ */

type ShellBusEvents = {
  "plan": {
    engineId: string;
    op: "query" | "exec";
    mode: ExecMode;
    cmd: string;
    args: string[];
    hasStdin: boolean;
    usesTempFile: boolean;
  };

  "spawn:start": {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Uint8Array; // raw bytes, optional
  };
  "spawn:done": {
    cmd: string;
    args: string[];
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    durationMs: number;
  };
  "spawn:error": { cmd: string; args: string[]; error: unknown };

  "tempfile": { path: string; kind: "sql"; bytes: number };
  "tempfile:cleanup": { path: string; ok: boolean; error?: unknown };

  "parse": { ok: boolean; kind?: string; bytes: number };
};

function cleanEnv(
  e?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!e) return undefined;
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(e)) {
    if (v !== undefined) pairs.push([k, v]);
  }
  return pairs.length ? Object.fromEntries(pairs) : {};
}

function mergeEnvMaps(
  a?: Record<string, string | undefined>,
  b?: Record<string, string | undefined>,
) {
  if (!a && !b) return undefined;
  return { ...(a ?? {}), ...(b ?? {}) };
}

async function spawnArgv(args: readonly string[], init?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: Uint8Array;
  bus?: ReturnType<typeof eventBus<ShellBusEvents>>;
}) {
  const bus = init?.bus;
  const emit = <K extends keyof ShellBusEvents & string>(
    type: K,
    detail: ShellBusEvents[K],
  ) => {
    bus?.emit(type, detail as never);
  };

  if (!args.length) {
    return {
      code: 0,
      success: true,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    };
  }

  const [cmd, ...argv] = args;
  const stdin = init?.stdin;
  const started = performance.now();

  emit("spawn:start", {
    cmd,
    args: argv,
    cwd: init?.cwd,
    env: cleanEnv(init?.env),
    stdin: stdin && stdin.length ? stdin : undefined,
  });

  const command = new Deno.Command(cmd, {
    args: [...argv],
    cwd: init?.cwd,
    env: cleanEnv(init?.env),
    stdin: stdin && stdin.length ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  try {
    if (stdin && stdin.length) {
      const child = command.spawn();
      try {
        const w = child.stdin!.getWriter();
        try {
          await w.write(stdin);
        } finally {
          await w.close();
        }
        const out = await child.output();
        emit("spawn:done", {
          cmd,
          args: argv,
          code: out.code,
          success: out.success,
          stdout: out.stdout,
          stderr: out.stderr,
          durationMs: performance.now() - started,
        });
        return out;
      } finally {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    }

    const out = await command.output();
    emit("spawn:done", {
      cmd,
      args: argv,
      code: out.code,
      success: out.success,
      stdout: out.stdout,
      stderr: out.stderr,
      durationMs: performance.now() - started,
    });
    return out;
  } catch (error) {
    emit("spawn:error", { cmd, args: argv, error });
    throw error;
  }
}

async function writeTempSqlSource(
  sqlText: string,
  tmpDir?: string,
  bus?: ReturnType<typeof eventBus<ShellBusEvents>>,
) {
  const bytes = new TextEncoder().encode(sqlText);
  const file = await Deno.makeTempFile({
    dir: tmpDir,
    prefix: "courier-shell-",
    suffix: ".sql",
  });
  await Deno.writeFile(file, bytes);
  bus?.emit("tempfile", { path: file, kind: "sql", bytes: bytes.byteLength });

  const cleanup = async () => {
    try {
      await Deno.remove(file);
      bus?.emit("tempfile:cleanup", { path: file, ok: true });
    } catch (error) {
      bus?.emit("tempfile:cleanup", { path: file, ok: false, error });
    }
  };

  return { path: file, cleanup };
}

/* -------------------------------------------------------------------------------------------------
 * Engine model
 * ------------------------------------------------------------------------------------------------ */

export type ExecMode = "stdin" | "file" | "auto";

export type TaggedInit<
  EngineId extends string,
  T extends Record<string, unknown>,
> = Readonly<{
  engineId: EngineId;
  init: Readonly<T>;
}>;

export type EngineInit = TaggedInit<string, Record<string, unknown>>;

export type EngineCapabilities = Readonly<{
  stdin: boolean;
  file: boolean;
}>;

export type ExecutionPlan = Readonly<{
  engineId: string;
  op: "query" | "exec";
  mode: ExecMode;
  cmd: string;
  args: readonly string[];
  stdin?: Uint8Array;
  env?: Record<string, string | undefined>;
  usesTempFile?: boolean;
  tempFilePath?: string;
  cleanup?: () => Promise<void>;
}>;

export type EnginePlanContext = Readonly<{
  url: string;
  target: string; // engine-specific resource (db path, conn string, etc)
  op: "query" | "exec";
  sqlText: string;
  params?: CourierParams;

  mode: ExecMode;
  bin?: string;
  extraArgs?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  tmpDir?: string;

  // engine init (tagged)
  init?: EngineInit;
}>;

export interface ShellSqlEngine {
  readonly id: string;
  readonly label: string;
  readonly sqlLanguage: "sql";
  readonly defaultBins: readonly string[];
  readonly capabilities: EngineCapabilities;
  readonly preferredMode: Exclude<ExecMode, "auto">;

  /** Optional: adjust env (e.g., PGPASSWORD injection) */
  mapEnv?(
    ctx: EnginePlanContext,
  ): Record<string, string | undefined> | undefined;

  /** Plan a deterministic CLI execution. */
  plan(
    ctx: EnginePlanContext,
    io: { writeTempSql: typeof writeTempSqlSource },
  ): Promise<ExecutionPlan>;

  /** Optional: parse stdout+stderr into query rows. */
  parseQueryOutput?(
    ctx: EnginePlanContext,
    out: {
      code: number;
      success: boolean;
      stdout: Uint8Array;
      stderr: Uint8Array;
    },
  ): ParsedQuery;
}

type ParsedQuery = Readonly<{
  columns?: readonly string[];
  rows: readonly CourierRowArray[]; // canonical internal representation
  rowCount?: number;
}>;

type EngineRegistry = {
  register: (e: ShellSqlEngine) => void;
  get: (id: string) => ShellSqlEngine | undefined;
  list: () => readonly ShellSqlEngine[];
};

function createEngineRegistry(): EngineRegistry {
  const byId = new Map<string, ShellSqlEngine>();
  return {
    register: (e) => byId.set(e.id, e),
    get: (id) => byId.get(id),
    list: () => Object.freeze(Array.from(byId.values())),
  };
}

const engines = createEngineRegistry();

/* -------------------------------------------------------------------------------------------------
 * Generic JSON parsing helpers (engine-agnostic default)
 * ------------------------------------------------------------------------------------------------ */

function decodeUtf8(u8: Uint8Array) {
  return new TextDecoder().decode(u8);
}

function tryParseJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function parseNdjson(text: string): unknown[] | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const out: unknown[] = [];
  for (const l of lines) {
    const v = tryParseJson(l);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}

function objectRowsToArrays(rows: readonly Record<string, unknown>[]) {
  const first = rows[0];
  const cols = first ? Object.keys(first) : [];
  const arrRows = rows.map((r) => cols.map((c) => r[c]) as CourierRowArray);
  return { columns: cols, rows: arrRows };
}

function defaultParseQuery(stdout: Uint8Array): ParsedQuery {
  const text = decodeUtf8(stdout).trim();
  if (!text) return { rows: [], rowCount: 0 };

  const parsed = tryParseJson(text) ?? parseNdjson(text);

  // Array payloads
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { rows: [], rowCount: 0 };
    const first = parsed[0];
    if (Array.isArray(first)) {
      const rows = parsed as unknown as readonly CourierRowArray[];
      return { rows, rowCount: rows.length };
    }
    if (first && typeof first === "object") {
      const { columns, rows } = objectRowsToArrays(
        parsed as Record<string, unknown>[],
      );
      return { columns, rows, rowCount: rows.length };
    }
    // scalar array -> 1-col
    const rows = (parsed as unknown[]).map((v) => [v] as CourierRowArray);
    return { columns: ["value"], rows, rowCount: rows.length };
  }

  // Object payload conventions: { columns, rows } or { data }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const cols = Array.isArray(o.columns)
      ? (o.columns.map(String) as string[])
      : undefined;
    const rowsAny = o.rows;
    if (cols && Array.isArray(rowsAny)) {
      const rows = rowsAny.map((
        r,
      ) => (Array.isArray(r) ? r : [r])) as CourierRowArray[];
      return { columns: cols, rows, rowCount: rows.length };
    }
    const data = o.data;
    if (Array.isArray(data)) {
      const first = data[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const { columns, rows } = objectRowsToArrays(
          data as Record<string, unknown>[],
        );
        return { columns, rows, rowCount: rows.length };
      }
    }
  }

  // Fall back: treat as single textual row
  return { columns: ["stdout"], rows: [[text]], rowCount: 1 };
}

/* -------------------------------------------------------------------------------------------------
 * URL parsing + connect option parsing
 * ------------------------------------------------------------------------------------------------ */

type ShellConnectConfig = Readonly<{
  engineId: string;
  target: string;
  mode?: ExecMode;
  bin?: string;
  extraArgs?: readonly string[];
  env?: Record<string, string | undefined>;
  init?: EngineInit;
  cwd?: string;
  tmpDir?: string;
}>;

function parseJsonMaybe<T>(
  s: string | undefined,
  label: string,
): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch (e) {
    throw new CourierError(`Invalid JSON for ${label}`, {
      code: "SYNTAX",
      cause: e,
    });
  }
}

/**
 * Parse `courier:shell:<engineId>:<target>` with optional query parameters.
 * This is intentionally permissive: engines decide what `target` means.
 */
function parseShellUrl(
  url: string,
): { engineId: string; target: string; query: URLSearchParams } {
  const prefix = "courier:shell:";
  if (!url.startsWith(prefix)) {
    throw new CourierError(`Invalid shell URL: ${url}`, { code: "CONNECTION" });
  }

  const rest = url.slice(prefix.length);
  const queryStart = rest.indexOf("?");
  const base = queryStart >= 0 ? rest.slice(0, queryStart) : rest;
  const query = new URLSearchParams(
    queryStart >= 0 ? rest.slice(queryStart + 1) : "",
  );

  const isHierarchical = base.startsWith("//") || base.startsWith("/") ||
    rest.startsWith("?");

  if (isHierarchical) {
    const baseAfterSlashes = base.startsWith("//") ? base.slice(2) : base;
    let engineSegment: string | undefined;
    let target = "";

    const segments = baseAfterSlashes.split("/");
    const nonEmpty = segments.find((seg) => seg.length > 0);
    if (nonEmpty) {
      engineSegment = nonEmpty;
      const idx = baseAfterSlashes.indexOf(nonEmpty);
      target = baseAfterSlashes.slice(idx + nonEmpty.length);
    }

    const engineFromQuery = query.get("engine");
    const engineId = engineSegment ??
      (engineFromQuery ? engineFromQuery.trim() : undefined);
    if (!engineId) {
      throw new CourierError(`Shell URL missing engineId target: ${url}`, {
        code: "CONNECTION",
      });
    }

    return { engineId, target, query };
  }

  const firstColon = base.indexOf(":");
  if (firstColon < 0) {
    throw new CourierError(`Shell URL missing engineId target: ${url}`, {
      code: "CONNECTION",
    });
  }

  const engineId = base.slice(0, firstColon);
  const targetAndQuery = base.slice(firstColon + 1);

  const qIdx = targetAndQuery.indexOf("?");
  let target = targetAndQuery;
  if (qIdx >= 0) {
    target = targetAndQuery.slice(0, qIdx);
  }

  return { engineId, target, query };
}

function normalizeDbTarget(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("file://")) return trimmed.slice("file://".length);
  if (trimmed.startsWith("file:")) return trimmed.slice("file:".length);
  return trimmed;
}

function resolveEngineInitDb(
  ctx: EnginePlanContext,
  engineId: string,
): string | undefined {
  if (ctx.init?.engineId !== engineId) return undefined;
  const init = ctx.init.init as Record<string, unknown> | undefined;
  if (!init) return undefined;
  const db = init.db;
  if (typeof db !== "string" || !db.trim()) return undefined;
  return db;
}

function tagInit(
  engineId: string,
  init?: Record<string, unknown> | EngineInit,
): EngineInit | undefined {
  if (!init) return undefined;
  if (
    typeof init === "object" && init !== null && "engineId" in init &&
    "init" in init
  ) {
    const ei = (init as EngineInit).engineId;
    if (ei !== engineId) {
      throw new CourierError(
        `Init object tagged for engineId="${ei}" cannot be used with engineId="${engineId}"`,
        { code: "SYNTAX" },
      );
    }
    return init as EngineInit;
  }
  return { engineId, init: init as Record<string, unknown> };
}

function resolveExecMode(
  requested: ExecMode | undefined,
  engine: ShellSqlEngine,
): ExecMode {
  const m = requested ?? engine.preferredMode;
  if (m === "auto") return "auto";
  if (m === "stdin" && engine.capabilities.stdin) return m;
  if (m === "file" && engine.capabilities.file) return m;
  // degrade deterministically
  if (engine.capabilities.stdin) return "stdin";
  if (engine.capabilities.file) return "file";
  return "auto";
}

function pickBin(engine: ShellSqlEngine, override?: string): string {
  return override ?? engine.defaultBins[0] ?? engine.id;
}

/* -------------------------------------------------------------------------------------------------
 * Result implementation (in-memory; CLI runs are not streaming in this v1)
 * ------------------------------------------------------------------------------------------------ */

class ShellCourierResult implements CourierResult {
  readonly columns?: readonly string[];
  readonly rowCount?: number;

  #rows: readonly CourierRowArray[];
  #closed = false;

  constructor(parsed: ParsedQuery) {
    this.columns = parsed.columns;
    this.rowCount = parsed.rowCount;
    this.#rows = parsed.rows;
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
    const cols = this.columns ? [...this.columns] : undefined;
    const rows = this.#rows;
    const isClosed = () => this.#closed;

    if (effective === "array") {
      return (async function* () {
        for (const r of rows) {
          if (isClosed()) return;
          yield r;
        }
      })();
    }

    const transform = opts?.transform;
    if (transform) {
      return (async function* () {
        for (const r of rows) {
          if (isClosed()) return;
          const obj = cols
            ? Object.fromEntries(cols.map((c, i) => [c, r[i]]))
            : Object.fromEntries(r.map((v, i) => [String(i), v]));
          yield transform(obj);
        }
      })();
    }

    return (async function* () {
      for (const r of rows) {
        if (isClosed()) return;
        const obj = cols
          ? Object.fromEntries(cols.map((c, i) => [c, r[i]]))
          : Object.fromEntries(r.map((v, i) => [String(i), v]));
        yield obj;
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
    this.#closed = true;
    return Promise.resolve();
  }
}

/* -------------------------------------------------------------------------------------------------
 * Connection implementation
 * ------------------------------------------------------------------------------------------------ */

export class ShellCourierConnection implements CourierConnection {
  readonly url: string;
  readonly events = new EventTarget();
  readonly capabilities: CourierCapabilities;

  #closed = false;

  // Execution context
  readonly #engine: ShellSqlEngine;
  readonly #cfg: ShellConnectConfig;
  readonly #bus: ReturnType<typeof eventBus<ShellBusEvents>>;
  readonly #diagCleanup?: () => void;

  constructor(
    url: string,
    engine: ShellSqlEngine,
    cfg: ShellConnectConfig,
    bus: ReturnType<typeof eventBus<ShellBusEvents>>,
    diagCleanup?: () => void,
  ) {
    this.url = url;
    this.#engine = engine;
    this.#cfg = cfg;
    this.#bus = bus;
    this.#diagCleanup = diagCleanup;

    // Conservative capabilities for a spawn-based v1.
    const supports = new Set<CourierFeature>([
      "streaming", // CourierResult.rows() is async iterable (even if backed by an in-memory array)
    ]);

    // We can accept named params only if the engine supports it. For now, we accept arrays only.
    // (Call sites can still use SQL tagged templates safely.)
    // If you later implement engine-specific named param rewriting, add "namedParameters".
    this.capabilities = { supports };
  }

  get bus() {
    return this.#bus;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  unwrap<T = unknown>(): T | undefined {
    // Keep unwrap intentionally useful for tooling/tests.
    return {
      engine: this.#engine,
      config: this.#cfg,
      bus: this.#bus,
    } as unknown as T;
  }

  close(): Promise<void> {
    this.#diagCleanup?.();
    this.#closed = true;
    return Promise.resolve();
  }

  async query(
    sql: string | SQL | SQLQuery,
    params?: CourierParams,
  ): Promise<CourierResult> {
    if (this.#closed) {
      throw new CourierError("Connection is closed", { code: "CONNECTION" });
    }

    const normalized = normalizeSqlInputForShell(sql, params);
    const ctx = this.#ctx("query", normalized.text, normalized.params);

    const plan = await this.#plan(ctx);
    const out = await this.#run(plan);

    if (!out.success || out.code !== 0) {
      const stderr = decodeUtf8(out.stderr);
      throw new CourierError(stderr || "Shell SQL query failed", {
        code: "UNKNOWN",
        cause: { code: out.code, stderr, stdout: decodeUtf8(out.stdout) },
      });
    }

    const parsed = this.#parseQuery(ctx, out);
    return new ShellCourierResult(parsed);
  }

  async exec(
    sql: string | SQL | SQLQuery,
    params?: CourierParams,
  ): Promise<CourierExecResult> {
    if (this.#closed) {
      throw new CourierError("Connection is closed", { code: "CONNECTION" });
    }

    const normalized = normalizeSqlInputForShell(sql, params);
    const ctx = this.#ctx("exec", normalized.text, normalized.params);

    const plan = await this.#plan(ctx);
    const out = await this.#run(plan);

    if (!out.success || out.code !== 0) {
      const stderr = decodeUtf8(out.stderr);
      throw new CourierError(stderr || "Shell SQL exec failed", {
        code: "UNKNOWN",
        cause: { code: out.code, stderr, stdout: decodeUtf8(out.stdout) },
      });
    }

    // v1: changes unknown unless engine emits it explicitly later.
    return { changes: undefined };
  }

  // deno-lint-ignore require-await
  async tx<T>(
    _fn: (c: CourierConnection) => Promise<T>,
    _options?: CourierTxOptions,
  ): Promise<T> {
    // Without a persistent process/session, tx() cannot reliably work.
    throw new CourierFeatureNotSupportedError(
      "Shell SQL driver does not support multi-call transactions (no persistent session).",
    );
  }

  meta(): Promise<CourierMeta> {
    // Metadata is engine-specific and CLI-specific; keep minimal in v1.
    const meta: CourierMeta = {
      product: { name: "shell-sql" },
      driver: { name: "courier-shell-sql", version: "1.0.0" },
      url: this.url,
    };
    return Promise.resolve(meta);
  }

  /* --------------------------------- internals --------------------------------- */

  #ctx(
    op: "query" | "exec",
    sqlText: string,
    params?: CourierParams,
  ): EnginePlanContext {
    return {
      url: this.url,
      target: this.#cfg.target,
      op,
      sqlText,
      params,
      mode: this.#cfg.mode ?? "auto",
      bin: this.#cfg.bin,
      extraArgs: this.#cfg.extraArgs,
      cwd: this.#cfg.cwd,
      env: this.#cfg.env,
      tmpDir: this.#cfg.tmpDir,
      init: this.#cfg.init,
    };
  }

  async #plan(ctx: EnginePlanContext): Promise<ExecutionPlan> {
    const effectiveMode = resolveExecMode(ctx.mode, this.#engine);
    const planned = await this.#engine.plan(
      { ...ctx, mode: effectiveMode },
      { writeTempSql: writeTempSqlSource },
    );

    this.#bus.emit("plan", {
      engineId: planned.engineId,
      op: planned.op,
      mode: planned.mode,
      cmd: planned.cmd,
      args: [...planned.args],
      hasStdin: !!(planned.stdin && planned.stdin.length),
      usesTempFile: !!planned.usesTempFile,
    });

    return planned;
  }

  async #run(plan: ExecutionPlan) {
    try {
      const mergedEnv = mergeEnvMaps(
        plan.env,
        this.#engine.mapEnv?.({
          url: this.url,
          target: this.#cfg.target,
          op: plan.op,
          sqlText: "", // mapEnv should use init/target rather than raw SQL; keep empty
          params: undefined,
          mode: plan.mode,
          bin: plan.cmd,
          extraArgs: plan.args,
          cwd: this.#cfg.cwd,
          env: this.#cfg.env,
          tmpDir: this.#cfg.tmpDir,
          init: this.#cfg.init,
        }) ?? undefined,
      );

      const out = await spawnArgv([plan.cmd, ...plan.args], {
        cwd: this.#cfg.cwd,
        env: mergedEnv,
        stdin: plan.stdin,
        bus: this.#bus,
      });

      return out;
    } finally {
      if (plan.cleanup) await plan.cleanup().catch(() => {});
    }
  }

  #parseQuery(
    ctx: EnginePlanContext,
    out: { stdout: Uint8Array; stderr: Uint8Array },
  ) {
    try {
      const parsed = this.#engine.parseQueryOutput
        ? this.#engine.parseQueryOutput(ctx, {
          code: 0,
          success: true,
          stdout: out.stdout,
          stderr: out.stderr,
        })
        : defaultParseQuery(out.stdout);

      this.#bus.emit("parse", {
        ok: true,
        kind: parsed.columns ? "json+columns" : "json",
        bytes: out.stdout.byteLength,
      });
      return parsed;
    } catch (e) {
      this.#bus.emit("parse", { ok: false, bytes: out.stdout.byteLength });
      throw e;
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * SQL input normalization for spawn-based engines
 * ------------------------------------------------------------------------------------------------ */

function normalizeSqlInputForShell(
  sql: string | SQL | SQLQuery,
  params?: CourierParams,
): { text: string; params?: CourierParams } {
  if (typeof sql === "string") return { text: sql, params };

  if (params !== undefined) {
    throw new CourierError(
      "Cannot supply positional or named params when executing a SQL tagged template/query object",
      { code: "SYNTAX", sqlState: "0A000" },
    );
  }

  const normalized = isSQL(sql)
    ? toSQLQuery(sql, { identifier: () => "?" })
    : toSQLQuery(sql);

  return { text: normalized.text, params: normalized.values };
}

/* -------------------------------------------------------------------------------------------------
 * Built-in engines
 * ------------------------------------------------------------------------------------------------ */

function pickMode(
  mode: ExecMode,
  preferred: Exclude<ExecMode, "auto">,
): Exclude<ExecMode, "auto"> {
  return mode === "auto" ? preferred : mode;
}

/**
 * sqlite3Engine init helper.
 * Store this object in catalogs; it is tagged with the engine id.
 */
export function sqliteInit(init: { db: string }) {
  return { engineId: "sqlite3", init } as const satisfies EngineInit;
}

const sqlite3Engine: ShellSqlEngine = {
  id: "sqlite3",
  label: "sqlite3 CLI",
  sqlLanguage: "sql",
  defaultBins: ["sqlite3"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  async plan(ctx, io) {
    const cmd = pickBin(this, ctx.bin);
    const extraArgs = ctx.extraArgs ?? [];

    // Target: allow file: prefix but keep engine logic simple
    const db = resolveEngineInitDb(ctx, this.id) ??
      normalizeDbTarget(ctx.target);
    if (!db) {
      throw new CourierError(
        "SQLite shell driver requires a target DB file (target or init.db)",
        { code: "CONNECTION" },
      );
    }
    const mode = pickMode(ctx.mode, this.preferredMode);

    // Always force JSON for query-mode. sqlite3 supports `-json` in modern versions.
    // If your sqlite3 lacks -json, swap this to `.mode json` + `.once /dev/stdout` in a future update.
    const baseArgs = ["-json", db, ...extraArgs];

    if (mode === "stdin") {
      const sql = ctx.sqlText.endsWith("\n")
        ? ctx.sqlText
        : (ctx.sqlText + "\n");
      return {
        engineId: this.id,
        op: ctx.op,
        mode,
        cmd,
        args: baseArgs,
        stdin: new TextEncoder().encode(sql),
        env: ctx.env,
        usesTempFile: false,
      };
    }

    const { path, cleanup } = await io.writeTempSql(
      ctx.sqlText,
      ctx.tmpDir,
      undefined,
    );
    // sqlite3 file mode: `.read <file>`
    const script = `.read ${path}\n`;
    return {
      engineId: this.id,
      op: ctx.op,
      mode: "file",
      cmd,
      args: baseArgs,
      stdin: new TextEncoder().encode(script),
      env: ctx.env,
      usesTempFile: true,
      tempFilePath: path,
      cleanup,
    };
  },
};

/**
 * duckdbEngine init helper.
 */
export function duckdbInit(init: { db: string }) {
  return { engineId: "duckdb", init } as const satisfies EngineInit;
}

const duckdbEngine: ShellSqlEngine = {
  id: "duckdb",
  label: "duckdb CLI",
  sqlLanguage: "sql",
  defaultBins: ["duckdb"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  async plan(ctx, io) {
    const cmd = pickBin(this, ctx.bin);
    const extraArgs = ctx.extraArgs ?? [];
    const db = resolveEngineInitDb(ctx, this.id) ??
      normalizeDbTarget(ctx.target);
    if (!db) {
      throw new CourierError(
        "DuckDB shell driver requires a target DB file (target or init.db)",
        { code: "CONNECTION" },
      );
    }
    const mode = pickMode(ctx.mode, this.preferredMode);

    // DuckDB has `-json` output in some builds; also supports `.mode json` in the CLI.
    // We choose the CLI meta command path to be more broadly compatible.
    const baseArgs = [db, ...extraArgs];

    if (mode === "stdin") {
      const program = [
        `.mode json`,
        // Ensure predictable errors stop the process (DuckDB exits non-zero on many errors anyway).
        ctx.sqlText,
      ].join("\n") + "\n";

      return {
        engineId: this.id,
        op: ctx.op,
        mode,
        cmd,
        args: baseArgs,
        stdin: new TextEncoder().encode(program),
        env: ctx.env,
        usesTempFile: false,
      };
    }

    const { path, cleanup } = await io.writeTempSql(
      ctx.sqlText,
      ctx.tmpDir,
      undefined,
    );
    const program = `.mode json\n.read ${path}\n`;
    return {
      engineId: this.id,
      op: ctx.op,
      mode: "file",
      cmd,
      args: baseArgs,
      stdin: new TextEncoder().encode(program),
      env: ctx.env,
      usesTempFile: true,
      tempFilePath: path,
      cleanup,
    };
  },
};

/**
 * surveilr engines are wrappers around `surveilr shell` to run SQL against a chosen engine.
 * These are intentionally thin: argument planning mirrors sqlite/duckdb, but the binary changes.
 */
export function surveilrSqliteInit(init: { db: string }) {
  return { engineId: "surveilr-sqlite", init } as const satisfies EngineInit;
}
export function surveilrDuckdbInit(init: { db: string }) {
  return { engineId: "surveilr-duckdb", init } as const satisfies EngineInit;
}

const surveilrSqliteEngine: ShellSqlEngine = {
  id: "surveilr-sqlite",
  label: "surveilr shell (sqlite)",
  sqlLanguage: "sql",
  defaultBins: ["surveilr"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  async plan(ctx, io) {
    const cmd = pickBin(this, ctx.bin);
    const extraArgs = ctx.extraArgs ?? [];
    const db = resolveEngineInitDb(ctx, this.id) ??
      normalizeDbTarget(ctx.target);
    if (!db) {
      throw new CourierError(
        "surveilr sqlite shell driver requires a target DB file (target or init.db)",
        { code: "CONNECTION" },
      );
    }
    const mode = pickMode(ctx.mode, this.preferredMode);

    // Convention: `surveilr shell` should accept db-like target args. Adjust here if surveilr differs.
    const baseArgs = [
      "shell",
      "--output",
      "json",
      "--no-observability",
      "--state-db-fs-path",
      db,
      ...extraArgs,
    ];

    if (mode === "stdin") {
      const sql = ctx.sqlText.endsWith("\n")
        ? ctx.sqlText
        : (ctx.sqlText + "\n");
      return {
        engineId: this.id,
        op: ctx.op,
        mode,
        cmd,
        args: baseArgs,
        stdin: new TextEncoder().encode(sql),
        env: ctx.env,
        usesTempFile: false,
      };
    }

    const { path, cleanup } = await io.writeTempSql(
      ctx.sqlText,
      ctx.tmpDir,
      undefined,
    );
    const program = `.read ${path}\n`;
    return {
      engineId: this.id,
      op: ctx.op,
      mode: "file",
      cmd,
      args: baseArgs,
      stdin: new TextEncoder().encode(program),
      env: ctx.env,
      usesTempFile: true,
      tempFilePath: path,
      cleanup,
    };
  },
};

const surveilrDuckDbEngine: ShellSqlEngine = {
  id: "surveilr-duckdb",
  label: "surveilr shell (duckdb)",
  sqlLanguage: "sql",
  defaultBins: ["surveilr"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  async plan(ctx, io) {
    const cmd = pickBin(this, ctx.bin);
    const extraArgs = ctx.extraArgs ?? [];
    const db = resolveEngineInitDb(ctx, this.id) ??
      normalizeDbTarget(ctx.target);
    if (!db) {
      throw new CourierError(
        "surveilr duckdb shell driver requires a target DB file (target or init.db)",
        { code: "CONNECTION" },
      );
    }
    const mode = pickMode(ctx.mode, this.preferredMode);

    const baseArgs = [
      "shell",
      "--engine",
      "duckdb",
      "--output",
      "json",
      "--no-observability",
      "--state-db-fs-path",
      db,
      ...extraArgs,
    ];

    if (mode === "stdin") {
      const sql = ctx.sqlText.endsWith("\n")
        ? ctx.sqlText
        : (ctx.sqlText + "\n");
      return {
        engineId: this.id,
        op: ctx.op,
        mode,
        cmd,
        args: baseArgs,
        stdin: new TextEncoder().encode(sql),
        env: ctx.env,
        usesTempFile: false,
      };
    }

    const { path, cleanup } = await io.writeTempSql(
      ctx.sqlText,
      ctx.tmpDir,
      undefined,
    );
    const program = `.read ${path}\n`;
    return {
      engineId: this.id,
      op: ctx.op,
      mode: "file",
      cmd,
      args: baseArgs,
      stdin: new TextEncoder().encode(program),
      env: ctx.env,
      usesTempFile: true,
      tempFilePath: path,
      cleanup,
    };
  },
};

/* -------------------------------------------------------------------------------------------------
 * Postgres (psql) engine + ops helpers
 * ------------------------------------------------------------------------------------------------ */

export type PgInit = Readonly<{
  host?: string;
  port?: number;
  user?: string;
  dbname?: string;
  service?: string;
  sslmode?: string;
  password?: string; // will be mapped to PGPASSWORD iff not already present
}>;

export function pgInit(init: PgInit) {
  return { engineId: "psql", init } as const satisfies EngineInit;
}

function parsePsqlTarget(target: string): PgInit {
  // Accept:
  // - //user@host:port/dbname
  // - postgres://...
  // - key/value style via query params handled elsewhere
  const t = target.trim();
  if (t.startsWith("//")) {
    const u = new URL("postgres:" + t);
    return {
      user: u.username || undefined,
      host: u.hostname || undefined,
      port: u.port ? Number(u.port) : undefined,
      dbname: (u.pathname || "").replace(/^\//, "") || undefined,
    };
  }
  if (t.startsWith("postgres://") || t.startsWith("postgresql://")) {
    const u = new URL(t);
    return {
      user: u.username || undefined,
      host: u.hostname || undefined,
      port: u.port ? Number(u.port) : undefined,
      dbname: (u.pathname || "").replace(/^\//, "") || undefined,
      sslmode: u.searchParams.get("sslmode") ?? undefined,
    };
  }
  return {};
}

function buildPsqlArgs(init: PgInit, extraArgs: readonly string[]) {
  const args: string[] = [];

  // Force non-interactive safety defaults
  args.push("-v", "ON_ERROR_STOP=1");
  args.push("-X"); // do not read ~/.psqlrc
  args.push("-q"); // quiet-ish

  if (init.service) args.push("--set", `service=${init.service}`);
  if (init.host) args.push("-h", init.host);
  if (init.port) args.push("-p", String(init.port));
  if (init.user) args.push("-U", init.user);
  if (init.dbname) args.push("-d", init.dbname);

  // Emit JSON as single value:
  // Use psql's \gexec/\gset is not portable; simplest is `\pset format json`.
  // This is supported in modern psql. If an older psql is used, you can swap
  // to `COPY (...) TO STDOUT WITH (FORMAT json)` in a future iteration.
  args.push("-P", "pager=off");
  args.push("-P", "format=json");

  // Add caller extras last
  args.push(...extraArgs);
  return args;
}

const psqlEngine: ShellSqlEngine = {
  id: "psql",
  label: "psql (Postgres CLI)",
  sqlLanguage: "sql",
  defaultBins: ["psql"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  mapEnv(ctx) {
    const init = ctx.init?.engineId === this.id
      ? (ctx.init.init as PgInit)
      : undefined;
    if (!init?.password) return undefined;

    // Only inject PGPASSWORD if not already present (so callers can override).
    const already = Deno.env.get("PGPASSWORD");
    if (already && already.length) return undefined;

    return { PGPASSWORD: init.password };
  },

  async plan(ctx, io) {
    const cmd = pickBin(this, ctx.bin);
    const extraArgs = ctx.extraArgs ?? [];

    const targetInit = parsePsqlTarget(ctx.target);
    const initFromTag =
      (ctx.init?.engineId === this.id
        ? (ctx.init.init as PgInit)
        : undefined) ?? {};
    const init: PgInit = { ...targetInit, ...initFromTag };

    const mode = pickMode(ctx.mode, this.preferredMode);
    const baseArgs = buildPsqlArgs(init, extraArgs);

    if (mode === "stdin") {
      const sql = ctx.sqlText.endsWith("\n")
        ? ctx.sqlText
        : (ctx.sqlText + "\n");
      return {
        engineId: this.id,
        op: ctx.op,
        mode,
        cmd,
        args: baseArgs,
        stdin: new TextEncoder().encode(sql),
        env: ctx.env,
        usesTempFile: false,
      };
    }

    const { path, cleanup } = await io.writeTempSql(
      ctx.sqlText,
      ctx.tmpDir,
      undefined,
    );
    return {
      engineId: this.id,
      op: ctx.op,
      mode: "file",
      cmd,
      args: [...baseArgs, "-f", path],
      env: ctx.env,
      usesTempFile: true,
      tempFilePath: path,
      cleanup,
    };
  },
  // psql format=json typically outputs a JSON array; default parser handles it.
};

/* ---------- Postgres operational helpers (kept dependency-free) ---------- */

export type PgEnv = Readonly<{
  PGHOST?: string;
  PGPORT?: string;
  PGUSER?: string;
  PGDATABASE?: string;
  PGSERVICE?: string;
  PGSSLMODE?: string;
  PGPASSWORD?: string;
}>;

export function pgEnv(
  e: Record<string, string | undefined> = Deno.env.toObject(),
): PgEnv {
  return {
    PGHOST: e.PGHOST,
    PGPORT: e.PGPORT,
    PGUSER: e.PGUSER,
    PGDATABASE: e.PGDATABASE,
    PGSERVICE: e.PGSERVICE,
    PGSSLMODE: e.PGSSLMODE,
    PGPASSWORD: e.PGPASSWORD,
  };
}

export function definePgCatalogFromEnv(env: PgEnv): PgInit {
  return {
    host: env.PGHOST,
    port: env.PGPORT ? Number(env.PGPORT) : undefined,
    user: env.PGUSER,
    dbname: env.PGDATABASE,
    service: env.PGSERVICE,
    sslmode: env.PGSSLMODE,
    password: env.PGPASSWORD,
  };
}

export async function pgPasswordFromPgpass(args?: {
  host?: string;
  port?: number;
  dbname?: string;
  user?: string;
  pgpassPath?: string;
}): Promise<string | undefined> {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const path = args?.pgpassPath ?? (home ? `${home}/.pgpass` : "");
  if (!path) return undefined;

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }

  const host = args?.host ?? "*";
  const port = args?.port ? String(args.port) : "*";
  const db = args?.dbname ?? "*";
  const user = args?.user ?? "*";

  // .pgpass format: host:port:database:user:password
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("#")
  );
  for (const line of lines) {
    const parts = line.split(":");
    if (parts.length < 5) continue;
    const [h, p, d, u, pw] = parts;
    const match = (pat: string, v: string) => pat === "*" || pat === v;
    if (match(h, host) && match(p, port) && match(d, db) && match(u, user)) {
      return pw;
    }
  }
  return undefined;
}

export async function pgServiceFromConf(args?: {
  serviceName: string;
  confPath?: string;
}): Promise<PgInit | undefined> {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const defaultPath = home ? `${home}/.pg_service.conf` : "";
  const path = args?.confPath ?? defaultPath;
  if (!path) return undefined;

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }

  const service = args?.serviceName;
  let inSection = false;
  const out: Record<string, string> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^\[(.+?)\]$/);
    if (m) {
      inSection = m[1] === service;
      continue;
    }
    if (!inSection) continue;
    const kv = line.split("=", 2);
    if (kv.length === 2) out[kv[0].trim()] = kv[1].trim();
  }

  if (!Object.keys(out).length) return undefined;

  return {
    host: out.host,
    port: out.port ? Number(out.port) : undefined,
    dbname: out.dbname,
    user: out.user,
    sslmode: out.sslmode,
    // password is not typically stored here; allow it if present
    password: out.password,
    service,
  };
}

/**
 * Secret provider interface: intentionally tiny so callers can plug in whatever
 * signed fetch logic they need without hard deps.
 */
export interface SecretProvider {
  getSecret(key: string): Promise<string | undefined>;
}

/** Provider that reads JSON from a single env var, e.g. SECRETS_JSON='{"pg.password":"..."}' */
export function jsonFromEnvSecretProvider(
  envVar = "SECRETS_JSON",
): SecretProvider {
  const cache = (() => {
    const raw = Deno.env.get(envVar);
    if (!raw) return undefined as Record<string, string> | undefined;
    try {
      const obj = JSON.parse(raw) as Record<string, string>;
      return obj && typeof obj === "object" ? obj : undefined;
    } catch {
      return undefined;
    }
  })();

  return {
    // deno-lint-ignore require-await
    async getSecret(key: string) {
      return cache?.[key];
    },
  };
}

/** Generic fetcher-based provider. Caller supplies fetcher (signed/proxied/etc.). */
export function fetcherSecretProvider(
  fetcher: (key: string) => Promise<Response>,
): SecretProvider {
  return {
    async getSecret(key: string) {
      const res = await fetcher(key);
      if (!res.ok) return undefined;
      return await res.text();
    },
  };
}

/**
 * Hydrate partial PgInit using a secret provider.
 * Convention: if init.password is missing, and init contains `passwordSecretKey`,
 * fetch it. This keeps the init shape stable while enabling external secrets.
 */
export async function hydratePgInitWithSecrets(
  init: PgInit & { passwordSecretKey?: string },
  provider: SecretProvider,
): Promise<PgInit> {
  if (init.password) return init;
  const key = init.passwordSecretKey;
  if (!key) return init;
  const pw = await provider.getSecret(key);
  return pw ? { ...init, password: pw } : init;
}

/* -------------------------------------------------------------------------------------------------
 * Driver registration
 * ------------------------------------------------------------------------------------------------ */

export function registerShellSqlEngine(engine: ShellSqlEngine) {
  engines.register(engine);
}

export function registerCourierShellSqlDriver() {
  Courier.register({
    name: "courier-shell-sql",
    version: "1.0.0",

    accepts(url: string) {
      return url.startsWith("courier:shell:");
    },

    // deno-lint-ignore require-await
    async connect(url: string, options?: Readonly<Record<string, string>>) {
      try {
        const parsed = parseShellUrl(url);
        const engine = engines.get(parsed.engineId);
        if (!engine) {
          const known = engines.list().map((e) => e.id).join(", ");
          throw new CourierError(
            `Unknown shell SQL engine "${parsed.engineId}". Known: ${known}`,
            {
              code: "CONNECTION",
            },
          );
        }

        const optMode =
          (options?.mode ?? parsed.query.get("mode") ?? undefined) as
            | ExecMode
            | undefined;
        const optBin = options?.bin ?? parsed.query.get("bin") ?? undefined;

        const extraArgs = parseJsonMaybe<string[]>(
          options?.extraArgs ?? parsed.query.get("extraArgs") ?? undefined,
          "extraArgs",
        );

        const envOverrides = parseJsonMaybe<Record<string, string | undefined>>(
          options?.env ?? parsed.query.get("env") ?? undefined,
          "env",
        );

        const initObj = parseJsonMaybe<Record<string, unknown>>(
          options?.init ?? parsed.query.get("init") ?? undefined,
          "init",
        );

        const diagParam = options?.diags ??
          parsed.query.get("diags") ?? undefined;
        const cfg: ShellConnectConfig = {
          engineId: parsed.engineId,
          target: parsed.target,
          mode: optMode,
          bin: optBin,
          extraArgs,
          env: envOverrides,
          init: tagInit(parsed.engineId, initObj),
          cwd: options?.cwd ?? parsed.query.get("cwd") ?? undefined,
          tmpDir: options?.tmpDir ?? parsed.query.get("tmpDir") ?? undefined,
        };

        const bus = eventBus<ShellBusEvents>();
        let diagCleanup: (() => void) | undefined;
        if (diagParam === "cli-pretty") {
          const handle = prettyShellDiagnostics(bus);
          diagCleanup = () => handle.dispose();
        }

        return new ShellCourierConnection(
          url,
          engine,
          cfg,
          bus,
          diagCleanup,
        );
      } catch (e) {
        throw toCourierError(e);
      }
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Built-in engine auto-registration (so drop-in usage works out of the box)
 * ------------------------------------------------------------------------------------------------ */

registerShellSqlEngine(sqlite3Engine);
registerShellSqlEngine(duckdbEngine);
registerShellSqlEngine(psqlEngine);
registerShellSqlEngine(surveilrSqliteEngine);
registerShellSqlEngine(surveilrDuckDbEngine);

registerCourierShellSqlDriver();

/**
 * @module sql-text.ts
 * SQL composition utilities used throughout Courier.
 *
 * Core services:
 * - `SQL` is the typed tagged template for parameterized queries; call `.safe()` to
 *   get `{ text, values }` suitable for drivers and `.text()` for readable debugging.
 * - `raw` / `sqlRaw` splice verbatim SQL fragments (identifiers, operators, dialect
 *   extensions) without parameterization.
 * - `sqlCat` produces SQLite-style `||` concatenation expressions from mixed literal
 *   and fragment content.
 * - Helpers (`literal`, `inlinedSQL`, `sqlIdent`, `assignments`, etc.) quote,
 *   escape, and format values when assembling expressions and CTEs.
 *
 * Key ergonomics:
 * - Arrays expand recursively inside `SQL` templates and `raw` fragments.
 * - Nested `SQL`/`raw` fragments merge placeholder numbering so drivers see
 *   continuous `$1`/`:1`/custom identifiers.
 * - `SQLSafeOptions`, `SQLTextOptions`, `SQLLiteralOptions`, and `SQLTextInput`
 *   describe the reusable option shapes for adapters that consume these helpers.
 *
 * Use the unit tests, especially near the bottom of the file, as cookbook-style
 * examples covering custom identifiers, sqlCat nesting, expression helpers, and
 * debug utilities like `inlinedSQL`.
 */

/**
 * Shape of a parameterized SQL query.
 *
 * - `text`: SQL string with placeholders.
 * - `values`: read-only list of bound parameter values.
 *
 * See unit tests for examples of how `SQL().safe()` returns this.
 */
export type SQLQuery = { text: string; values: readonly unknown[] };

/**
 * Options accepted by `SQL.safe()` or any consumer that needs placeholder control.
 */
export type SQLSafeOptions = { identifier?: PlaceholderIdentifier };

/**
 * Options accepted when serializing fragments to literal SQL strings.
 */
export type SQLTextOptions = { ifDate?: (d: Date) => string };

/**
 * Options passed to `literal()`; includes `SQLTextOptions` plus skip helpers.
 */
export type SQLLiteralOptions = SQLTextOptions & {
  skipIfQuoted?: boolean;
};

/**
 * Placeholder index → token factory.
 *
 * Implement to customize placeholder shapes, e.g. `(i) => ":p" + i`.
 *
 * See unit tests for custom placeholder examples.
 */
export type PlaceholderFactory = (position: number) => string;

/**
 * Accepted placeholder identifier modes:
 * - "$" → $1, $2, ...
 * - ":" → :1, :2, ...
 * - function → custom factory (e.g. `:p1`, `:p2`)
 *
 * See unit tests for how this affects `safe()`.
 */
export type PlaceholderIdentifier = "$" | ":" | PlaceholderFactory;

/**
 * Common SQL fragment interface returned by `SQL``...```.
 *
 * - `safe({ identifier })` builds parameterized `{ text, values }`.
 * - `text({ ifDate })` renders a single readable SQL string with inlined literals.
 * - `toString()` delegates to `text()`.
 *
 * See unit tests for behavior and composition patterns.
 */
export type SQL = {
  /**
   * Returns a parameterized query suitable for DB clients.
   *
   * @param options.identifier Controls placeholder format. Defaults to `"$"`.
   *   - `"$"` → `$1`, `$2`, ...
   *   - `":"` → `:1`, `:2`, ...
   *   - function → custom e.g. `(i) => ":p" + i` → `:p1`, `:p2`, ...
   */
  safe(options?: SQLSafeOptions): SQLQuery;

  /**
   * Builds a single SQL string with **all parameters inlined as SQL literals**.
   * Nested `SQL` parts are inserted using their own `.text()` output.
   * Use for debugging/logging; for execution use `safe()`.
   */
  text(options?: SQLTextOptions): string;

  /** Same as calling `text()` with default options. */
  toString(): string;
};

export type SQLTextInput = string | SQL | SQLQuery;

// ---------------------- Utilities ----------------------

export function isSQL(v: unknown): v is SQL {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as SQL).safe === "function" &&
    typeof (v as SQL).text === "function"
  );
}

export function toSQLQuery(
  sql: SQL | SQLQuery,
  options?: SQLSafeOptions,
): SQLQuery {
  return isSQL(sql) ? sql.safe(options) : sql;
}

export const isSingleQuoted = (s: string) => /^\s*'[\s\S]*'\s*$/.test(s);

export const hexOfUint8 = (bytes: Uint8Array): string =>
  "X'" +
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("") +
  "'";

export const hexOfUint8Postgres = (bytes: Uint8Array): string =>
  "E'\\\\x" +
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("") +
  "'";

/**
 * Convert a single JS value into a SQL literal string.
 *
 * - `SQL` / `raw` fragments delegate to their own `.text()` output instead of
 *   being JSON-stringified.
 * - Strings are single-quoted with internal quotes doubled.
 * - Numbers use `String(v)`; non-finite numbers become `NULL`.
 * - Bigints use `String(v)`.
 * - Booleans map to TRUE/FALSE.
 * - Dates use ISO-8601 in quotes, or `ifDate` override.
 * - Uint8Array renders as hex blob `X'...'`.
 * - null/undefined → `NULL`.
 * - Other objects use `JSON.stringify` wrapped in quotes with quotes doubled.
 *
 * Options
 * - `ifDate`: custom formatter for Date values (must return final SQL literal).
 * - `skipIfQuoted`: if true and input string already looks single-quoted,
 *   it is returned as-is.
 *
 * See unit tests for exact escaping and formatting.
 */
export function literal(v: unknown, opts?: SQLLiteralOptions): string {
  if (isSQL(v)) return v.text(opts);
  if (isRaw(v)) return v.text(opts);
  if (v === null || v === undefined) return "NULL";

  // strings: allow "already-quoted" pass-through for DX in some builders
  if (typeof v === "string") {
    if (opts?.skipIfQuoted && isSingleQuoted(v)) return v;
    return `'${v.replaceAll("'", "''")}'`;
  }

  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";

  if (v instanceof Date) {
    if (opts?.ifDate) return opts.ifDate(v);
    return `'${v.toISOString()}'`;
  }

  if (v instanceof Uint8Array) return hexOfUint8(v);

  // default: JSON-quote and escape single quotes
  return `'${JSON.stringify(v).replaceAll("'", "''")}'`;
}

/**
 * Dedent template literal output if the first line is whitespace-only.
 * Removes the first blank line, then strips the smallest common indent.
 */
function dedentIfFirstLineBlank(s: string): string {
  if (s.length === 0) return s;
  const normalized = s.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "") return s;

  // drop first (blank) line
  lines.shift();

  // Find minimal indent of non-empty lines
  let minIndent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (minIndent === null || indent < minIndent) minIndent = indent;
  }

  if (minIndent && minIndent > 0) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let remove = 0;
      while (remove < minIndent && (l[remove] === " " || l[remove] === "\t")) {
        remove++;
      }
      lines[i] = l.slice(remove);
    }
  }

  return lines.join("\n");
}

function resolveIdentifier(id?: PlaceholderIdentifier): PlaceholderFactory {
  if (typeof id === "function") return id;
  if (id === ":") return (i) => `:${i}`;
  return (i) => `$${i}`; // default "$"
}

// ------------------------- RAW TEMPLATE (single implementation) ----------------------------------

type RawFragment = {
  readonly __raw: true;
  /** Build the raw text by walking its template and interpolations (verbatim). */
  text(options?: SQLTextOptions): string;
};

function isRaw(x: unknown): x is RawFragment {
  return typeof x === "object" && x !== null && (x as { __raw?: unknown })
        .__raw === true;
}

/**
 * Build a verbatim SQL fragment from a template literal.
 *
 * Behavior
 * - Interpolated `SQL` values splice their `.text()` output.
 * - Interpolated `raw` values splice verbatim recursively.
 * - Arrays are joined with ", " and processed recursively.
 * - No parameterization or quoting is applied.
 *
 * Use for trusted snippets like identifiers, operators, or dialect-specific bits.
 * See unit tests for composition with `SQL`.
 */
export function raw(
  strings: TemplateStringsArray,
  ...exprs: readonly unknown[]
): RawFragment {
  const buildText = (options?: SQLTextOptions) => {
    const toRawText = (v: unknown): string => {
      if (isSQL(v)) return v.text(options);
      if (isRaw(v)) return v.text(options);
      if (Array.isArray(v)) return v.map(toRawText).join(", ");
      return String(v); // verbatim, no escaping
    };

    let out = "";
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < exprs.length) out += toRawText(exprs[i]);
    }
    return dedentIfFirstLineBlank(out);
  };

  return Object.freeze<RawFragment>({
    __raw: true as const,
    text: buildText,
  });
}

/**
 * Alias of `raw` provided for developer experience and back-compat.
 * See `raw` documentation and unit tests for usage.
 */
export const sqlRaw = raw;

// ------------------------- SQL TEMPLATE ----------------------------------

type Interp = unknown | readonly Interp[];
const kBuildSafe = Symbol("sql.buildSafe"); // internal offset-aware builder

type SQLWithInternal = SQL & {
  [kBuildSafe]: (startAt: number, ident: PlaceholderFactory) => SQLQuery;
};

/**
 * Tagged template for composing parameterized SQL queries with nesting and raw support.
 *
 * Interpolation rules
 * - `SQL`: merged into the parent, preserving and continuing placeholder indices.
 * - `raw` / `sqlRaw`: inserted verbatim with no parameters.
 * - Arrays: expanded with ", " and processed recursively.
 * - Other values: bound as parameters in `safe()`; rendered as literals in `text()`.
 *
 * Laziness
 * - `safe()` and `text()` walk the template and interpolations on each call.
 *
 * Safety
 * - Use `safe()` for execution.
 * - Use `text()` only for logging or debugging.
 *
 * See unit tests for examples, including nesting and custom placeholder factories.
 */
export function SQL(
  strings: TemplateStringsArray,
  ...exprs: readonly Interp[]
): SQL {
  /** Recursively build *parameterized* SQL for one interpolation, merging nested SQL. */
  const buildSafePart = (
    x: Interp,
    currentCount: number,
    ident: PlaceholderFactory,
  ): { text: string; values: unknown[] } => {
    // Raw chunk → insert as-is (no params)
    if (isRaw(x)) {
      return { text: x.text(), values: [] };
    }

    // Nested SQL with internal offset-aware merge
    if (isSQL(x) && kBuildSafe in (x as object)) {
      const nested = (x as SQLWithInternal)[kBuildSafe](currentCount, ident);
      return { text: nested.text, values: [...nested.values] };
    }

    // Nested SQL fallback: call safe() with shifted identifier (no regex reindexing)
    if (isSQL(x)) {
      const nested = x.safe({ identifier: (i) => ident(currentCount + i) });
      return { text: nested.text, values: [...nested.values] };
    }

    // Arrays → join parts by ", "
    if (Array.isArray(x)) {
      if (x.length === 0) return { text: "", values: [] };
      let text = "";
      const values: unknown[] = [];
      for (let i = 0; i < x.length; i++) {
        const part = buildSafePart(x[i], currentCount + values.length, ident);
        if (i) text += ", ";
        text += part.text;
        values.push(...part.values);
      }
      return { text, values };
    }

    // Primitive/unknown → single placeholder
    return { text: ident(currentCount + 1), values: [x] };
  };

  /** Recursively build **inlined** SQL for one interpolation. */
  const buildTextPart = (x: Interp, options?: SQLTextOptions): string => {
    if (isRaw(x)) return x.text(options);
    if (isSQL(x)) return x.text(options);
    if (Array.isArray(x)) {
      return x.map((v) => buildTextPart(v, options)).join(", ");
    }
    return literal(x, options);
  };

  /** Internal method used by parents to build parameterized SQL with an offset. */
  const buildSafeInternal = (
    startAt: number,
    ident: PlaceholderFactory,
  ): SQLQuery => {
    let text = "";
    const values: unknown[] = [];

    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < exprs.length) {
        const part = buildSafePart(exprs[i], startAt + values.length, ident);
        text += part.text;
        values.push(...part.values);
      }
    }

    return {
      text: dedentIfFirstLineBlank(text),
      values: Object.freeze(values),
    };
  };

  const publicSafe = (options?: SQLSafeOptions): SQLQuery =>
    buildSafeInternal(0, resolveIdentifier(options?.identifier));

  const buildText = (options?: SQLTextOptions): string => {
    let out = "";
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < exprs.length) out += buildTextPart(exprs[i], options);
    }
    return dedentIfFirstLineBlank(out);
  };

  // Return the SQL object. Add hidden offset-aware builder for nested merges.
  const api: SQLWithInternal = Object.assign(
    {
      safe: publicSafe,
      text: buildText,
      toString: () => buildText(),
    } as SQL,
    { [kBuildSafe]: buildSafeInternal },
  );
  return api;
}

/**
 * Ensure an SQL string ends with exactly one semicolon.
 *
 * - Strips trailing whitespace and extra semicolons.
 * - Appends a single `;` if missing.
 *
 * See unit tests for trimming behavior.
 */
export const ensureTrailingSemicolon = (str: string) =>
  str.replace(/;*\s*$/, ";");

/**
 * Inline `?` placeholders in SQL with literal values for readability.
 *
 * Behavior
 * - Replaces `?` outside single-quoted string literals with SQL-ish literals.
 * - Leaves `?` inside single-quoted regions untouched.
 * - Extra `?` remain; extra values are ignored.
 * - Always returns a string that ends with `;`.
 *
 * Intended for debugging/logging or readable output, not for execution security.
 * See unit tests for quoting rules and edge cases.
 */
export function inlinedSQL(
  q: { sql: string; params: readonly unknown[] },
): string {
  const { sql, params } = q;
  let i = 0, p = 0;
  let out = "";
  const n = sql.length;

  while (p < n) {
    const ch = sql[p];

    if (ch === "'") {
      // copy string literal verbatim, honoring doubled '' escapes
      out += ch;
      p++;
      while (p < n) {
        const c = sql[p];
        out += c;
        p++;
        if (c === "'") {
          if (p < n && sql[p] === "'") {
            out += "'";
            p++;
          } else break;
        }
      }
      continue;
    }

    if (ch === "?") {
      out += i < params.length ? literal(params[i++]) : "?";
      p++;
      continue;
    }

    out += ch;
    p++;
  }

  return ensureTrailingSemicolon(out);
}

// ------------------------- SQL CONCAT (sqlCat) --------------------------------

function isBalancedParens(s: string): boolean {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") d++;
    else if (c === ")") {
      d--;
      if (d < 0) return false;
    }
  }
  return d === 0;
}

function stripConcatParens(s: string): string {
  const t = s.trim();
  if (t.startsWith("(") && t.endsWith(")")) {
    const inner = t.slice(1, -1).trim();
    if (inner.includes("||") && isBalancedParens(inner)) return inner;
  }
  return s;
}

/**
 * Build a SQLite-style concatenation expression with `||` from a template literal.
 *
 * Behavior
 * - Template literal text pieces become quoted SQL string literals.
 * - Interpolations:
 *   - `string`: inserted verbatim (identifier or expression).
 *   - `raw` / `sqlRaw`: spliced verbatim.
 *   - `SQL`: spliced using its `.text()` output.
 *   - Arrays: flattened with ` || ` between items.
 *   - Others: stringified and inserted verbatim.
 * - Removes a single set of outer parentheses from nested `sqlCat` fragments
 *   to avoid redundant grouping in chained concatenations.
 * - Returns:
 *   - "''" for zero parts,
 *   - the single fragment for one part,
 *   - or `(a || b || c)` for multiple parts.
 *
 * Use in views, computed columns, and content-generation queries.
 * See unit tests for nesting and escaping behavior.
 */
export function sqlCat(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): string {
  const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

  const toFrag = (v: unknown): string => {
    if (Array.isArray(v)) {
      const flat = (v as readonly unknown[]).map(toFrag).filter((s) =>
        s.length > 0
      );
      return flat.length ? flat.join(" || ") : "";
    }
    if (isRaw(v)) return v.text();
    if (isSQL(v)) return v.text();
    if (typeof v === "string") return v; // raw SQL token/expression
    return String(v ?? "");
  };

  const parts: string[] = [];

  for (let i = 0; i < strings.length; i++) {
    const lit = String(strings[i] ?? "");
    if (lit.length) parts.push(quote(lit));
    if (i < values.length) {
      const frag = toFrag(values[i]);
      const norm = stripConcatParens(frag);
      if (norm.length) parts.push(norm);
    }
  }

  if (parts.length === 0) return "''";
  if (parts.length === 1) return parts[0];
  return `(${parts.join(" || ")})`;
}

// ------------------------- Complex SQL generator example ---------------------

/**
 * Algebraic fragment type accepted by `anchor()`.
 *
 * Accepts:
 * - `string`  → raw SQL / identifier / `sqlCat` result
 * - `SQL`     → parameterized fragment; `.text()` will inline values
 * - `sqlRaw`  → verbatim SQL (no quoting or params)
 * - arrays    → any mix of the above, recursively flattened with ` || `
 */
export type SQLFrag =
  | string
  | SQL
  | ReturnType<typeof sqlRaw>
  | ReadonlyArray<SQLFrag>;

/** Normalize any fragment (or nested array of fragments) into a raw SQL string. */
export function fragToSql(v: SQLFrag): string {
  if (Array.isArray(v)) {
    return v.map(fragToSql).filter(Boolean).join(" || ");
  }
  if (isRaw(v)) return v.text();
  if (isSQL(v)) return v.text();
  return String(v); // plain identifier/expression/sqlCat result
}

export function stripOuterParens(s: string): string {
  const t = s.trim();
  if (t.startsWith("(") && t.endsWith(")")) {
    const inner = t.slice(1, -1);
    if (isBalancedParens(inner)) return inner.trim();
  }
  return s;
}

// ------------------------- SQL HELPERS for templating systems ----------------

export function looksLikeSqlExpr(s: string): boolean {
  const t = s.trim();
  if (t.includes("||")) return true; // sqlCat-style concat
  if (t.startsWith("(") && t.endsWith(")")) return true; // grouped expr
  return false;
}

/** Internal: coerce a value into a SQL expression. SQLFrag → sql; other → literal(). */
function toExpr(v: SQLFrag | unknown): string {
  if (Array.isArray(v)) return fragToSql(v as SQLFrag);
  if (isSQL(v) || isRaw(v)) return fragToSql(v as SQLFrag);
  if (typeof v === "string") {
    // If caller already supplied a single-quoted literal, keep it verbatim.
    if (isSingleQuoted(v)) return v;
    // Heuristic: sqlCat/result-like or grouped SQL → treat as expression.
    if (looksLikeSqlExpr(v)) return v.trim();
    // Otherwise, it's a plain JS string → literalize safely.
    return literal(v);
  }
  return literal(v);
}

/**
 * Quote/escape SQL identifiers, supporting dotted paths like schema.table or t.col.
 * Bare identifiers pass through; others are "quoted" with doubled internal quotes.
 *
 * Examples:
 *  sqlIdent("users")         -> users
 *  sqlIdent("order items")   -> "order items"
 *  sqlIdent("public.users")  -> public.users
 *  sqlIdent('t."weird col"') -> t."weird col"
 */
export function sqlIdent(id: string): string {
  const parts: string[] = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (ch === "." && !inQuote) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);

  return parts.map((p) => {
    const bare = /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(p);
    if (bare) return p;
    if (p.startsWith('"') && p.endsWith('"')) return p; // already quoted
    return `"${p.replaceAll('"', '""')}"`;
  }).join(".");
}

/** Comma-joined, identifier-escaped column list. */
export function colList(cols: readonly string[]): string {
  return cols.map(sqlIdent).join(", ");
}

/** Render a list of values/expressions as a SQL IN (...) list. */
export function sqlIn(values: readonly (SQLFrag | unknown)[]): string {
  return `(${values.map((v) => toExpr(v)).join(", ")})`;
}

/**
 * name = value, name2 = value2 from a record
 * Keys are identifiers; values are SQLFrag (expr) or plain JS (literal).
 */
export function assignments(obj: Record<string, SQLFrag | unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${sqlIdent(k)} = ${toExpr(v)}`)
    .join(", ");
}

/** Pair list: expr AS alias, with alias quoted via sqlIdent. */
export function selectAs(
  pairs: readonly { expr: SQLFrag | unknown; as: string }[],
): string {
  return pairs.map((p) => `${toExpr(p.expr)} AS ${sqlIdent(p.as)}`).join(", ");
}

/**
 * VALUES (...) tuples for INSERT using ordered column names and row records.
 * Row values can be SQL fragments (used verbatim) or plain JS (literalized).
 */
export function valuesTuples(
  rows: readonly Record<string, SQLFrag | unknown>[],
  cols: readonly string[],
): string {
  return rows
    .map((r) => `(${cols.map((c) => toExpr(r[c])).join(", ")})`)
    .join(",\n");
}

/** CASE WHEN builder. Supply WHEN/THEN as SQLFrag/JS; ELSE as SQLFrag/JS. */
export function caseWhen(
  rules: readonly { when: SQLFrag | unknown; then: SQLFrag | unknown }[],
  elseExpr: SQLFrag | unknown,
): string {
  const body = rules
    .map((r) => `WHEN ${toExpr(r.when)} THEN ${toExpr(r.then)}`)
    .join("\n    ");
  return `CASE\n    ${body}\n    ELSE ${toExpr(elseExpr)}\nEND`;
}

// Replace the helper(s) inside withCTE section:

// Normalize a multi-line SQL block: trim outer whitespace and left-trim each line.
function normalizeBlock(s: string): string {
  return s.trim().split("\n").map((l) => l.trim()).join("\n");
}

// Indent each non-empty line by n spaces (after normalization).
function indentBlock(s: string, n = 2): string {
  return normalizeBlock(s)
    .split("\n")
    .map((l) => (l.length ? " ".repeat(n) + l : l))
    .join("\n");
}

export function withCTE(
  ctes: readonly { name: string; sql: SQLFrag | unknown }[],
  finalSql: SQLFrag | unknown,
): string {
  const head = ctes
    .map((c) => {
      const body = fragToSql(c.sql as SQLFrag);
      return `${sqlIdent(c.name)} AS (\n${indentBlock(body)}\n)`;
    })
    .join(",\n");

  const tail = normalizeBlock(fragToSql(finalSql as SQLFrag));
  return `WITH ${head}\n${tail}`;
}

/** UNION ALL join with block trimming. Accepts SQLFrag or JS (literal). */
export function unionAll(chunks: readonly (SQLFrag | unknown)[]): string {
  return chunks.map((c) => fragToSql(c as SQLFrag).trim()).join(
    "\nUNION ALL\n",
  );
}

/**
 * Convenience for ON CONFLICT ... DO UPDATE SET ... (Postgres/SQLite).
 * If updateCols not supplied, defaults to non-PK columns (see upsertFromStage()).
 */
export function onConflictSet(cols: readonly string[]): string {
  return cols.map((c) => `${sqlIdent(c)} = EXCLUDED.${sqlIdent(c)}`).join(", ");
}

/**
 * dbt-like helper: stage -> target UPSERT with ON CONFLICT semantics.
 * `target` and `stage` are identifier paths; columns are identifier names.
 * Useful with `valuesTuples()`/`selectAs()` when composing larger statements.
 */
export function upsertFromStage(args: {
  target: string;
  stage: string;
  cols: readonly string[];
  pk: readonly string[];
  updateCols?: readonly string[];
}): string {
  const { target, stage, cols, pk, updateCols } = args;
  const upd = updateCols ?? cols.filter((c) => !pk.includes(c));
  const selectCols = cols.map((c) => `${sqlIdent("s")}.${sqlIdent(c)}`).join(
    ", ",
  );
  return `
INSERT INTO ${sqlIdent(target)} (${colList(cols)})
SELECT ${selectCols}
FROM ${sqlIdent(stage)} AS ${sqlIdent("s")}
ON CONFLICT (${colList(pk)}) DO UPDATE SET ${onConflictSet(upd)}
`.trim();
}

/** Prefix-qualified columns as `prefix.col AS col` for projection cloning. */
export function cols(prefix: string, names: readonly string[]): string {
  return names
    .map((n) => `${sqlIdent(prefix)}.${sqlIdent(n)} AS ${sqlIdent(n)}`)
    .join(", ");
}

// lib/connect/safe-sql.ts

import { z } from "@zod";
import {
  colList,
  isSQL,
  type SQL,
  SQL as sqlTemplate,
  sqlIdent,
  sqlRaw,
} from "./sql-text.ts";
import { CourierError, CourierMeta } from "./core.ts";

export type SchemaColumnInfo = {
  table?: string;
  name: string;
  type?: string;
  nullable?: boolean;
  default?: unknown;
};

export type SchemaToZodOptions = {
  typeMap?: Record<string, z.ZodTypeAny>;
  defaultType?: z.ZodTypeAny;
  partial?: boolean;
};

export type Operator =
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "ne"
  | "eq";

export type OperatorValue<V> = {
  op: Operator;
  value: V;
};

export type SchemaWhereFilter<
  T extends z.ZodRawShape,
> = Partial<
  {
    [K in keyof z.input<z.ZodObject<T>>]:
      | z.input<z.ZodObject<T>>[K]
      | OperatorValue<z.input<z.ZodObject<T>>[K]>;
  }
>;

export type SchemaWhereInput<T extends z.ZodRawShape> =
  | SQL
  | SchemaWhereFilter<T>;

const DEFAULT_TYPE = z.unknown();

function normalizeTypeKey(type?: string): string {
  return (type ?? "").trim().toLowerCase();
}

function joinSQLParts(parts: readonly SQL[], separator: string): SQL {
  if (!parts.length) {
    throw new CourierError("SQL fragment list must not be empty");
  }
  return parts.slice(1).reduce(
    (acc, part) => sqlTemplate`${acc}${sqlRaw`${separator}`}${part}`,
    parts[0],
  );
}

function ensureWhereClause(where: SQL): SQL {
  const trimmed = where.text().trimStart();
  if (/^WHERE\b/i.test(trimmed)) {
    return where;
  }
  return sqlTemplate`WHERE ${where}`;
}

function resolveWhereInput<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  where: SchemaWhereInput<T> | undefined,
): SQL {
  if (!where) {
    throw new CourierError("WHERE clause is required");
  }
  return isSQL(where)
    ? ensureWhereClause(where)
    : whereClauseFromSchema(schema, where);
}

export function columnsToZodSchema(
  columns: readonly SchemaColumnInfo[],
  opts?: SchemaToZodOptions,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const map = opts?.typeMap ?? {};
  const fallback = opts?.defaultType ?? DEFAULT_TYPE;
  for (const col of columns) {
    const key = col.name;
    const normalized = normalizeTypeKey(col.type);
    const base = map[normalized] ?? fallback;
    shape[key] = col.nullable ? base.nullish() : base;
  }
  const schema = z.object(shape);
  return opts?.partial ? schema.partial() : schema;
}

export async function zodSchemaFromMeta(
  meta: CourierMeta,
  table: string,
  opts?: SchemaToZodOptions,
): Promise<z.ZodObject<Record<string, z.ZodTypeAny>>> {
  if (!meta.columns) {
    throw new CourierError("Driver metadata does not expose columns");
  }
  const columns = await meta.columns({ table });
  if (!columns || columns.length === 0) {
    throw new CourierError(`No metadata found for table ${table}`);
  }
  return columnsToZodSchema(columns as readonly SchemaColumnInfo[], opts);
}

function isOperatorValue<V>(
  v: unknown,
): v is { op: Operator; value: V } {
  return (
    typeof v === "object" &&
    v !== null &&
    "op" in v &&
    "value" in (v as Record<string, unknown>)
  );
}

function conditionSQL(
  key: string,
  operand: unknown,
): SQL {
  if (isSQL(operand)) {
    return operand;
  }
  if (isOperatorValue(operand)) {
    const opMap: Record<Operator, string> = {
      eq: "=",
      ne: "<>",
      lt: "<",
      lte: "<=",
      gt: ">",
      gte: ">=",
    };
    const sqlOp = opMap[operand.op] ?? "=";
    const opRaw = sqlRaw`${sqlOp}`;
    return sqlTemplate`${sqlRaw`${sqlIdent(key)}`} ${opRaw} ${operand.value}`;
  }
  return sqlTemplate`${sqlRaw`${sqlIdent(key)}`} = ${operand}`;
}

export function whereClauseFromSchema<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  filter: SchemaWhereFilter<T>,
): SQL {
  const entries = Object.entries(filter).filter(([, value]) =>
    value !== undefined
  );
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    normalized[key] = isOperatorValue(value) ? value.value : value;
  }
  schema.partial().parse(normalized);
  if (!entries.length) {
    throw new CourierError("WHERE clause cannot be empty");
  }
  const parts = entries.map(([key, value]) => conditionSQL(key, value));
  const clause = joinSQLParts(parts, " AND ");
  return sqlTemplate`WHERE ${clause}`;
}

export function insertFromSchema<
  T extends z.ZodRawShape,
>(
  table: string,
  schema: z.ZodObject<T>,
  data: z.input<typeof schema>,
  options?: { returning?: readonly string[] },
): SQL {
  const parsed = schema.parse(data);
  const entries = Object.entries(parsed);
  if (!entries.length) {
    throw new CourierError("INSERT payload must contain at least one column");
  }
  const columns = entries.map(([key]) => key);
  const values = entries.map(([, value]) => value);
  const tableIdent = sqlRaw`${sqlIdent(table)}`;
  const columnList = sqlRaw`${colList(columns)}`;
  let statement =
    sqlTemplate`insert into ${tableIdent} (${columnList}) values (${values})`;
  if (options?.returning?.length) {
    statement = sqlTemplate`${statement} returning ${sqlRaw`${
      colList(
        options.returning,
      )
    }`}`;
  }
  return statement;
}

export function updateFromSchema<
  T extends z.ZodRawShape,
>(
  table: string,
  schema: z.ZodObject<T>,
  changes: Partial<z.input<typeof schema>>,
  where: SchemaWhereInput<T>,
  options?: { returning?: readonly string[] },
): SQL {
  const parsed = schema.partial().parse(changes);
  const entries = Object.entries(parsed).filter(([, value]) =>
    value !== undefined
  );
  if (!entries.length) {
    throw new CourierError("UPDATE payload must contain at least one column");
  }
  const parts = entries.map(([key, value]) =>
    sqlTemplate`${sqlRaw`${sqlIdent(key)}`} = ${value}`
  );
  const setClause = joinSQLParts(parts, ", ");
  const whereClause = resolveWhereInput(schema, where);
  const tableIdent = sqlRaw`${sqlIdent(table)}`;
  let statement =
    sqlTemplate`update ${tableIdent} set ${setClause} ${whereClause}`;
  if (options?.returning?.length) {
    statement = sqlTemplate`${statement} returning ${sqlRaw`${
      colList(
        options.returning,
      )
    }`}`;
  }
  return statement;
}

export function deleteFromSchema<
  T extends z.ZodRawShape,
>(
  table: string,
  schema: z.ZodObject<T>,
  where: SchemaWhereInput<T>,
  options?: { returning?: readonly string[] },
): SQL {
  const whereClause = resolveWhereInput(schema, where);
  const tableIdent = sqlRaw`${sqlIdent(table)}`;
  let statement = sqlTemplate`delete from ${tableIdent} ${whereClause}`;
  if (options?.returning?.length) {
    statement = sqlTemplate`${statement} returning ${sqlRaw`${
      colList(
        options.returning,
      )
    }`}`;
  }
  return statement;
}

type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL";

type TableReference = string | SQL;

type SchemaSelectMode = "select" | "count";

interface SchemaSelectOptions {
  distinct?: boolean;
}

interface CTEClause {
  alias: string;
  query: SQL;
  columns?: readonly string[];
}

interface JoinDefinition {
  table: TableReference;
  alias?: string;
  type: JoinType;
  on: SQL;
}

type OrderByKey<T extends z.ZodRawShape> =
  | keyof z.input<z.ZodObject<T>>
  | SQL
  | string;

function buildColumnClause(
  mode: SchemaSelectMode,
  columns?: readonly string[] | undefined,
): SQL {
  if (mode === "count") {
    return sqlTemplate`count(*)`;
  }
  if (columns && columns.length) {
    return sqlTemplate`${sqlRaw`${colList(columns)}`}`;
  }
  return sqlTemplate`*`;
}

function buildJoinSQL(join: JoinDefinition): SQL {
  const joinType = sqlRaw`${join.type} JOIN`;
  const tableExpr = isSQL(join.table)
    ? join.table
    : sqlRaw`${sqlIdent(join.table)}`;
  const aliased = join.alias
    ? sqlTemplate`${tableExpr} ${sqlRaw`${sqlIdent(join.alias)}`}`
    : tableExpr;
  return sqlTemplate`${joinType} ${aliased} ON ${join.on}`;
}

function buildWithClause(ctes: readonly CTEClause[]): SQL | undefined {
  if (!ctes.length) {
    return undefined;
  }
  const parts = ctes.map((cte) => {
    const columns = cte.columns?.length
      ? sqlTemplate`(${sqlRaw`${colList(cte.columns)}`})`
      : sqlRaw``;
    return sqlTemplate`${sqlRaw`${sqlIdent(cte.alias)}`}${columns} AS (${cte.query})`;
  });
  const clause = joinSQLParts(parts, ", ");
  return sqlTemplate`WITH ${clause}`;
}

function columnToSQL<T extends z.ZodRawShape>(
  value: OrderByKey<T>,
): SQL {
  if (isSQL(value)) {
    return value;
  }
  return sqlTemplate`${sqlRaw`${sqlIdent(String(value))}`}`;
}

export class SchemaSQLBuilder<T extends z.ZodRawShape> {
  constructor(
    public readonly table: string,
    public readonly schema: z.ZodObject<T>,
  ) {}

  insert(
    payload: z.input<typeof this.schema>,
    options?: { returning?: readonly string[] },
  ): SQL {
    return insertFromSchema(this.table, this.schema, payload, options);
  }

  update(
    payload: Partial<z.input<typeof this.schema>>,
    where: SchemaWhereInput<T>,
    options?: { returning?: readonly string[] },
  ): SQL {
    return updateFromSchema(this.table, this.schema, payload, where, options);
  }

  delete(
    where: SchemaWhereInput<T>,
    options?: { returning?: readonly string[] },
  ): SQL {
    return deleteFromSchema(this.table, this.schema, where, options);
  }

  select<K extends readonly (keyof z.input<typeof this.schema>)[]>(
    columns?: K,
    options?: SchemaSelectOptions,
  ): SchemaSelectBuilder<T> {
    const columnNames = columns && columns.length
      ? columns.map((col) => String(col))
      : undefined;
    return new SchemaSelectBuilder(
      this.table,
      this.schema,
      columnNames,
      options,
      "select",
    );
  }

  count(options?: SchemaSelectOptions): SchemaSelectBuilder<T> {
    return new SchemaSelectBuilder(
      this.table,
      this.schema,
      undefined,
      options,
      "count",
    );
  }
}

export class SchemaSelectBuilder<T extends z.ZodRawShape> {
  private readonly columnNames?: readonly string[];
  private readonly distinctClause: SQL;
  private readonly mode: SchemaSelectMode;

  private readonly ctes: CTEClause[] = [];
  private readonly joins: JoinDefinition[] = [];
  private whereClause?: SQL;
  private readonly groupings: SQL[] = [];
  private havingClause?: SQL;
  private readonly orderings: SQL[] = [];
  private limitClause?: SQL;
  private offsetClause?: SQL;

  constructor(
    private readonly table: string,
    private readonly schema: z.ZodObject<T>,
    columns?: readonly string[],
    options?: SchemaSelectOptions,
    mode: SchemaSelectMode = "select",
  ) {
    this.columnNames = columns;
    this.mode = mode;
    this.distinctClause = options?.distinct && mode === "select"
      ? sqlTemplate`DISTINCT `
      : sqlTemplate``;
  }

  with(
    alias: string,
    query: SQL,
    opts?: { columns?: readonly string[] },
  ): this {
    this.ctes.push({
      alias,
      query,
      columns: opts?.columns,
    });
    return this;
  }

  join(
    table: TableReference,
    on: SQL,
    opts?: { alias?: string; type?: JoinType },
  ): this {
    this.joins.push({
      table,
      alias: opts?.alias,
      type: (opts?.type ?? "INNER"),
      on,
    });
    return this;
  }

  innerJoin(
    table: TableReference,
    on: SQL,
    opts?: { alias?: string },
  ): this {
    return this.join(table, on, { alias: opts?.alias, type: "INNER" });
  }

  leftJoin(
    table: TableReference,
    on: SQL,
    opts?: { alias?: string },
  ): this {
    return this.join(table, on, { alias: opts?.alias, type: "LEFT" });
  }

  where(filter: SchemaWhereInput<T>): this {
    this.whereClause = resolveWhereInput(this.schema, filter);
    return this;
  }

  groupBy(
    ...keys: readonly OrderByKey<T>[]
  ): this {
    for (const key of keys) {
      this.groupings.push(columnToSQL(key));
    }
    return this;
  }

  having(clause: SQL): this {
    this.havingClause = clause;
    return this;
  }

  orderBy(
    ...keys: readonly OrderByKey<T>[]
  ): this {
    for (const key of keys) {
      this.orderings.push(columnToSQL(key));
    }
    return this;
  }

  limit(value: number | SQL): this {
    this.limitClause = sqlTemplate`limit ${value}`;
    return this;
  }

  offset(value: number | SQL): this {
    this.offsetClause = sqlTemplate`offset ${value}`;
    return this;
  }

  sql(): SQL {
    const baseColumns = buildColumnClause(this.mode, this.columnNames);
    const tableIdent = sqlRaw`${sqlIdent(this.table)}`;
    const main = this.mode === "count"
      ? sqlTemplate`select ${baseColumns} from ${tableIdent}`
      : sqlTemplate`select ${this.distinctClause}${baseColumns} from ${tableIdent}`;

    const joinClause = this.joins.length
      ? joinSQLParts(this.joins.map((join) => buildJoinSQL(join)), " ")
      : undefined;
    let statement = joinClause ? sqlTemplate`${main} ${joinClause}` : main;
    if (this.whereClause) {
      statement = sqlTemplate`${statement} ${this.whereClause}`;
    }
    if (this.groupings.length) {
      const groupClause = joinSQLParts(this.groupings, ", ");
      statement = sqlTemplate`${statement} group by ${groupClause}`;
    }
    if (this.havingClause) {
      statement = sqlTemplate`${statement} having ${this.havingClause}`;
    }
    if (this.orderings.length) {
      const orderClause = joinSQLParts(this.orderings, ", ");
      statement = sqlTemplate`${statement} order by ${orderClause}`;
    }
    if (this.limitClause) {
      statement = sqlTemplate`${statement} ${this.limitClause}`;
    }
    if (this.offsetClause) {
      statement = sqlTemplate`${statement} ${this.offsetClause}`;
    }

    const withClause = buildWithClause(this.ctes);
    if (withClause) {
      return sqlTemplate`${withClause} ${statement}`;
    }
    return statement;
  }
}

export const lt = <V>(value: V): OperatorValue<V> => ({ op: "lt", value });
export const lte = <V>(value: V): OperatorValue<V> => ({ op: "lte", value });
export const gt = <V>(value: V): OperatorValue<V> => ({ op: "gt", value });
export const gte = <V>(value: V): OperatorValue<V> => ({ op: "gte", value });
export const ne = <V>(value: V): OperatorValue<V> => ({ op: "ne", value });

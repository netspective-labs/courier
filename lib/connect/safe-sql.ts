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

export type SchemaWhereInput<T extends z.ZodRawShape> =
  | SQL
  | Partial<z.input<z.ZodObject<T>>>;

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

function resolveWhereInput<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  where: SchemaWhereInput<T> | undefined,
): SQL {
  if (!where) {
    throw new CourierError("WHERE clause is required");
  }
  return isSQL(where) ? where : whereClauseFromSchema(schema, where);
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

export function whereClauseFromSchema<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  filter: Partial<z.input<typeof schema>>,
): SQL {
  const parsed = schema.partial().parse(filter);
  const entries = Object.entries(parsed).filter(([, value]) =>
    value !== undefined
  );
  if (!entries.length) {
    throw new CourierError("WHERE clause cannot be empty");
  }
  const parts = entries.map(([key, value]) =>
    sqlTemplate`${sqlRaw`${sqlIdent(key)}`} = ${value}`
  );
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

  where(filter: SchemaWhereInput<T>): SQL {
    return resolveWhereInput(this.schema, filter);
  }
}

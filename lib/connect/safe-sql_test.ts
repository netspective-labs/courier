// typed-sql_test.ts
import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "@zod";

import {
  columnsToZodSchema,
  insertFromSchema,
  lt,
  SchemaSQLBuilder,
  whereClauseFromSchema,
} from "./safe-sql.ts";
import { SQL } from "./sql-text.ts";

Deno.test("columnsToZodSchema + insertFromSchema produce parameterized SQL", () => {
  const columns = [
    { name: "id", type: "integer" },
    { name: "label", type: "text", nullable: true },
  ] as const;
  const schema = columnsToZodSchema(columns, {
    typeMap: {
      integer: z.number().int(),
      text: z.string(),
    },
  });

  const insert = insertFromSchema(
    "items",
    schema,
    { id: 1, label: "alpha" },
    { returning: ["id"] },
  );

  const safe = insert.safe();
  assertEquals(
    safe.text,
    "insert into items (id, label) values ($1, $2) returning id",
  );
  assertEquals(safe.values, [1, "alpha"]);
});

Deno.test("whereClauseFromSchema derives WHERE fragments", () => {
  const schema = z.object({ id: z.number(), name: z.string() });
  const where = whereClauseFromSchema(schema, { id: 7 });
  assertEquals(where.safe().text, "WHERE id = $1");
});

Deno.test("SchemaSQLBuilder supports insert/update/delete flows", () => {
  const schema = z.object({ id: z.number(), label: z.string() });
  const builder = new SchemaSQLBuilder("items", schema);

  const insert = builder.insert({ id: 1, label: "raw" });
  assertEquals(
    insert.safe().text,
    "insert into items (id, label) values ($1, $2)",
  );

  const update = builder.update({ label: "updated" }, { id: 1 });
  assertEquals(update.safe().text, "update items set label = $1 WHERE id = $2");

  const del = builder.delete({ id: 1 });
  assertEquals(del.safe().text, "delete from items WHERE id = $1");
});

Deno.test("SchemaSQLBuilder.select().where() builds typed selects", () => {
  const schema = z.object({ id: z.number(), label: z.string() });
  const builder = new SchemaSQLBuilder("items", schema);

  const sel = builder.select(["label"], { distinct: true });
  assertEquals(
    sel.where({ id: 1 }).sql().safe().text,
    "select DISTINCT label from items WHERE id = $1",
  );

  const sw = builder.select(["id"]).where({ id: lt(2) }).sql();
  assertEquals(sw.safe().text, "select id from items WHERE id < $1");
});

Deno.test("SchemaSQLBuilder.count().where() honors operators", () => {
  const schema = z.object({ id: z.number(), label: z.string() });
  const builder = new SchemaSQLBuilder("items", schema);

  const cnt = builder.count();
  assertEquals(
    cnt.where({ id: lt(5) }).sql().safe().text,
    "select count(*) from items WHERE id < $1",
  );
});

Deno.test("SchemaSelectBuilder honors dialect-specific limit clauses", () => {
  const schema = z.object({ id: z.number(), label: z.string() });
  const builder = new SchemaSQLBuilder("items", schema);
  const query = builder
    .select(["id"])
    .usingDialect("postgres")
    .limit(2)
    .offset(5)
    .sql();
  const safe = query.safe();
  assertStringIncludes(safe.text, "OFFSET $1 ROWS");
  assertStringIncludes(safe.text, "FETCH NEXT $2 ROWS ONLY");
  assertEquals(safe.values, [5, 2]);
});

Deno.test("SchemaSelectBuilder supports typed column aliases and fragments", () => {
  const schema = z.object({ id: z.number(), label: z.string() });
  const builder = new SchemaSQLBuilder("items", schema);
  const query = builder.select([
    ["id", "item_id"],
    "label",
    SQL`upper(label) AS label_upper`,
  ]).sql();
  const safe = query.safe();
  assertStringIncludes(safe.text, "id AS item_id");
  assertStringIncludes(safe.text, "label");
  assertStringIncludes(safe.text, "upper(label) AS label_upper");
});

Deno.test("SchemaSelectBuilder composes CTEs, joins, and clauses", () => {
  const schema = z.object({ id: z.number(), label: z.string() });
  const builder = new SchemaSQLBuilder("items", schema);
  const query = builder.select(["label"])
    .with("recent_items", SQL`select id, label from items`, {
      columns: ["id", "label"],
    })
    .join(
      "recent_items",
      SQL`recent_items.id = items.id`,
      { alias: "recent_items" },
    )
    .where({ id: 1 })
    .orderBy("label")
    .limit(5)
    .offset(2)
    .sql();

  const safe = query.safe();
  assertStringIncludes(
    safe.text,
    "WITH recent_items(id, label) AS (select id, label from items)",
  );
  assertStringIncludes(safe.text, "INNER JOIN recent_items");
  assertStringIncludes(safe.text, "ON recent_items.id = items.id");
  assertStringIncludes(safe.text, "order by label");
  assertEquals(safe.values, [1, 5, 2]);
});

// typed-sql_test.ts
import { assertEquals } from "@std/assert";
import { z } from "@zod";

import {
  columnsToZodSchema,
  insertFromSchema,
  SchemaSQLBuilder,
  whereClauseFromSchema,
} from "./safe-sql.ts";

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

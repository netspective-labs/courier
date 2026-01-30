// sql-text_test.ts
// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  ensureTrailingSemicolon,
  inlinedSQL,
  isSQL,
  raw,
  SQL,
  sqlCat,
  sqlRaw,
  withCTE,
} from "./sql-text.ts"; // adjust path

Deno.test("isSQL type guard", () => {
  const q = SQL`select ${1}`;
  assert(isSQL(q));
  assert(!isSQL(123));
  assert(!isSQL({}));
});

Deno.test("safe(): default identifier `$` with primitives and ordering", () => {
  const q =
    SQL`select * from users where id = ${123} and active = ${true} and name = ${"Ann"}`;
  const s = q.safe();
  assertEquals(
    s.text,
    "select * from users where id = $1 and active = $2 and name = $3",
  );
  assertEquals(s.values, [123, true, "Ann"]);
  assert(Object.isFrozen(s.values));
});

Deno.test("safe(): identifier ':' style", () => {
  const q = SQL`where a = ${1} and b in (${[2, 3]})`;
  const s = q.safe({ identifier: ":" });
  assertEquals(s.text, "where a = :1 and b in (:2, :3)");
  assertEquals(s.values, [1, 2, 3]);
});

Deno.test("safe(): custom identifier function (named)", () => {
  const q = SQL`update t set a = ${1}, b = ${2} where id = ${99}`;
  const s = q.safe({ identifier: (i) => `:p${i}` });
  assertEquals(s.text, "update t set a = :p1, b = :p2 where id = :p3");
  assertEquals(s.values, [1, 2, 99]);
});

Deno.test("safe(): arrays expand; multi-digit placeholders correct", () => {
  const vals = Array.from({ length: 12 }, (_, i) => i + 1); // [1..12]
  const q = SQL`insert into t ( ${vals} ) values ( ${vals} )`;
  const s = q.safe();
  assertEquals(
    s.text,
    "insert into t ( $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 ) values ( $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24 )",
  );
  assertEquals(s.values, [...vals, ...vals]);
});

Deno.test("safe(): nested SQL merges and reindexes across boundaries", () => {
  const where = SQL`where a = ${1} and b in (${[2, 3]})`;
  const q = SQL`select * from t ${where} and c = ${"x"}`;
  const s = q.safe();
  assertEquals(
    s.text,
    "select * from t where a = $1 and b in ($2, $3) and c = $4",
  );
  assertEquals(s.values, [1, 2, 3, "x"]);
});

Deno.test("safe(): nested SQL inside arrays mixes with primitives", () => {
  const a = SQL`a = ${1}`;
  const b = SQL`b = ${2}`;
  const q = SQL`select * from t where (${[a, b, "c"]})`;
  const s = q.safe();
  assertEquals(s.text, "select * from t where (a = $1, b = $2, $3)");
  assertEquals(s.values, [1, 2, "c"]);
});

Deno.test("safe(): values array is frozen; each call returns a new instance", () => {
  const q = SQL`select * from x where a = ${1} and b = ${2}`;
  const s1 = q.safe();
  const s2 = q.safe();
  assertNotStrictEquals(s1.values, s2.values);
  assertEquals(s1.values, s2.values);
  assert(Object.isFrozen(s1.values));
  assert(Object.isFrozen(s2.values));
  let threw = false;
  try {
    (s1.values as any).push(999);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("safe(): identifier propagates through nested SQL", () => {
  const inner = SQL`x = ${1} and y = ${2}`;
  const outer = SQL`update t set ${raw`flag = 1`} where ${inner} and z = ${3}`;
  const s = outer.safe({ identifier: (i) => `:p${i}` });
  assertEquals(
    s.text,
    "update t set flag = 1 where x = :p1 and y = :p2 and z = :p3",
  );
  assertEquals(s.values, [1, 2, 3]);
});

Deno.test("raw(): inserted verbatim and does not add to values", () => {
  const q = SQL`select * from t ${raw`where "a" IS NOT NULL`} and x = ${1}`;
  const s = q.safe();
  assertEquals(s.text, `select * from t where "a" IS NOT NULL and x = $1`);
  assertEquals(s.values, [1]);
});

Deno.test("raw(): nested SQL is inlined in text() and verbatim in safe()", () => {
  const inner = SQL`a = ${"O'Brien"}`; // would be parameterized if used directly
  const snippet = raw`(${inner}) OR (b = 1)`;
  const q = SQL`where ${snippet} and c = ${2}`;

  // text(): inline literals, including those from nested SQL inside raw()
  assertEquals(q.text(), "where (a = 'O''Brien') OR (b = 1) and c = 2");

  // safe(): raw chunk is verbatim; only 'c = ${2}' contributes a placeholder
  const s = q.safe();
  assertEquals(s.text, "where (a = 'O''Brien') OR (b = 1) and c = $1");
  assertEquals(s.values, [2]);
});

Deno.test("raw(): safe() keeps raw verbatim and does not parameterize nested SQL text", () => {
  const inner = SQL`a = ${"O'Brien"}`; // would be parameterized if used directly
  const snippet = raw`(${inner}) OR (b = 1)`;
  const q = SQL`where ${snippet} and c = ${2}`;
  const s = q.safe();
  // The raw chunk is literal; only trailing 'c = ${2}' produces a placeholder
  assertEquals(s.text, "where (a = 'O''Brien') OR (b = 1) and c = $1");
  assertEquals(s.values, [2]);

  // And text() shows fully inlined output as well
  assertEquals(q.text(), "where (a = 'O''Brien') OR (b = 1) and c = 2");
});

Deno.test("text(): inlines primitives, arrays, nested SQL; escapes strings; booleans uppercased", () => {
  const where = SQL`where id in (${[1, 2]}) and active = ${false}`;
  const q = SQL`select * from users ${where} and name = ${"O'Brien"}`;
  assertEquals(
    q.text(),
    "select * from users where id in (1, 2) and active = FALSE and name = 'O''Brien'",
  );
});

Deno.test("text(): date formatter via options.ifDate including nested SQL", () => {
  const d = new Date("2025-01-02T03:04:05.678Z");
  const inner = SQL`created_at >= ${d}`;
  const outer = SQL`where ${inner} and level = ${"info"}`;

  const formatted = outer.text({
    ifDate: (dt) =>
      `to_timestamp('${dt.toISOString()}', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')`,
  });

  assertEquals(
    formatted,
    "where created_at >= to_timestamp('2025-01-02T03:04:05.678Z', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') and level = 'info'",
  );
});

Deno.test("toString() delegates to text()", () => {
  const d = new Date("2025-09-06T12:00:00Z");
  const q = SQL`insert into t (d, s) values (${d}, ${"a'b"})`;
  assertStrictEquals(String(q), q.text());
});

Deno.test("ensureTrailingSemicolon()", () => {
  assertEquals(ensureTrailingSemicolon("select 1"), "select 1;");
  assertEquals(ensureTrailingSemicolon("select 1;   "), "select 1;");
  assertEquals(ensureTrailingSemicolon("select 1;;; \n"), "select 1;");
});

Deno.test("inlinedSQL", async (t) => {
  await t.step("replaces simple scalars and appends semicolon", () => {
    const out = inlinedSQL({
      sql: "select * from t where id = ? and ok = ?",
      params: [123, true],
    });
    assertEquals(out, "select * from t where id = 123 and ok = TRUE;");
    assertMatch(out, /;$/);
  });

  await t.step("leaves placeholders inside quoted strings untouched", () => {
    const out = inlinedSQL({
      sql: "select '?' as q, '?'||col as s, col2 = ?",
      params: [7],
    });
    assertEquals(out, "select '?' as q, '?'||col as s, col2 = 7;");
  });

  await t.step("honors doubled '' escapes inside quoted strings", () => {
    const out = inlinedSQL({
      sql: "select 'it''s fine ? here' as s, x = ?",
      params: [1],
    });
    assertEquals(out, "select 'it''s fine ? here' as s, x = 1;");
  });

  await t.step("string escaping doubles single quotes", () => {
    const out = inlinedSQL({
      sql: "insert into users(name) values(?)",
      params: ["O'Hara"],
    });
    assertEquals(out, "insert into users(name) values('O''Hara');");
  });

  await t.step("numbers: finite vs non-finite", () => {
    const out = inlinedSQL({
      sql: "values(?, ?, ?)",
      params: [3.14, NaN, Infinity],
    });
    assertEquals(out, "values(3.14, NULL, NULL);");
  });

  await t.step("bigint literal", () => {
    const out = inlinedSQL({
      sql: "select ? as big",
      params: [12345678901234567890n],
    });
    assertEquals(out, "select 12345678901234567890 as big;");
  });

  await t.step("boolean renders TRUE/FALSE", () => {
    const out = inlinedSQL({
      sql: "select ?, ?",
      params: [true, false],
    });
    assertEquals(out, "select TRUE, FALSE;");
  });

  await t.step("Date is ISO string in UTC", () => {
    const d = new Date("2023-01-02T03:04:05.678Z");
    const out = inlinedSQL({
      sql: "insert into logs(ts) values(?)",
      params: [d],
    });
    assertEquals(
      out,
      "insert into logs(ts) values('2023-01-02T03:04:05.678Z');",
    );
  });

  await t.step("Uint8Array to hex blob", () => {
    const out = inlinedSQL({
      sql: "insert into files(bin) values(?)",
      params: [new Uint8Array([0, 255, 16])],
    });
    assertEquals(out, "insert into files(bin) values(X'00ff10');");
  });

  await t.step("object/array fallback to JSON in single quotes", () => {
    const out = inlinedSQL({
      sql: "insert into meta(js) values(?), (?)",
      params: [{ a: 1, s: "b'c" }, [1, 2, 3]],
    });
    assertEquals(
      out,
      "insert into meta(js) values('{\"a\":1,\"s\":\"b''c\"}'), ('[1,2,3]');",
    );
  });

  await t.step("null and undefined become null", () => {
    const out = inlinedSQL({
      sql: "values(?, ?)",
      params: [null, undefined],
    });
    assertEquals(out, "values(NULL, NULL);");
  });

  await t.step("extra placeholders vs extra params", () => {
    const out1 = inlinedSQL({
      sql: "select ?, ?, ?",
      params: [1],
    });
    assertEquals(out1, "select 1, ?, ?;");

    const out2 = inlinedSQL({
      sql: "select ?",
      params: [1, 2, 3],
    });
    assertEquals(out2, "select 1;");
  });

  await t.step("question marks in various contexts", () => {
    const out = inlinedSQL({
      sql: "where a='?''?' and b=? and c='x?y' and d=?",
      params: [10, 20],
    });
    assertEquals(out, "where a='?''?' and b=10 and c='x?y' and d=20;");
  });
});

Deno.test("sqlCat", async (t) => {
  await t.step("handles single literal (no parens)", () => {
    const result = sqlCat`hello`;
    assertEquals(result, `'hello'`);
  });

  await t.step("joins literal and SQL identifier", () => {
    const result = sqlCat`/details?id=${"user_id"}`;
    assertEquals(result, "('/details?id=' || user_id)");
  });

  await t.step("multiple interpolations and text parts", () => {
    const result = sqlCat`prefix-${"col"}-mid-${"other"}-suffix`;
    assertEquals(
      result,
      "('prefix-' || col || '-mid-' || other || '-suffix')",
    );
  });

  await t.step("escapes single quotes in literal text", () => {
    const result = sqlCat`O'Hara-${"name"}`;
    assertEquals(result, "('O''Hara-' || name)");
  });

  await t.step("empty template returns empty SQL string", () => {
    const result = sqlCat``;
    assertEquals(result, "''");
  });

  await t.step("only SQL identifier interpolation (no parens)", () => {
    const result = sqlCat`${"username"}`;
    assertEquals(result, "username");
  });

  await t.step("literal before and after SQL expression", () => {
    const result = sqlCat`User: ${"username"}!`;
    assertEquals(result, "('User: ' || username || '!')");
  });

  await t.step("nesting: sqlCat result inside sqlCat", () => {
    const url = sqlCat`/details?id=${"id"}`;
    const anchor = sqlCat`[${"label"}](${url})`;
    assertEquals(
      anchor,
      "('[' || label || '](' || '/details?id=' || id || ')')",
    );
  });

  await t.step(
    "arrays: flatten and join with || (no outer parens when single part)",
    () => {
      const result = sqlCat`${["'A'", "col", "'B'"]}`;
      // Single interpolation becomes a single joined string without outer parentheses:
      assertEquals(result, "'A' || col || 'B'");
    },
  );

  await t.step("sqlRaw: splices verbatim trusted SQL", () => {
    const upper = sqlRaw`upper(${"name"})`; // → "upper(name)"
    const result = sqlCat`Hello, ${upper}!`;
    assertEquals(result, "('Hello, ' || upper(name) || '!')");
  });

  await t.step(
    "SQL fragments: splice .text() from SQL() (identifier via sqlRaw)",
    () => {
      // name should be an identifier, not a string literal
      const frag = sqlRaw`coalesce(${"name"}, ${"'N/A'"})`;
      const result = sqlCat`Hello, ${frag}!`;
      assertEquals(result, "('Hello, ' || coalesce(name, 'N/A') || '!')");
    },
  );
});

// ------------------------- Template helpers — cookbook -------------------------

import {
  assignments,
  caseWhen,
  colList,
  cols,
  onConflictSet,
  selectAs,
  sqlIdent,
  sqlIn,
  unionAll,
  upsertFromStage,
  valuesTuples,
} from "./sql-text.ts"; // adjust path if needed

Deno.test("Template helpers — cookbook", async (t) => {
  await t.step(
    "sqlIdent(): dotted paths, spaces, and pre-quoted pieces",
    () => {
      assertEquals(sqlIdent("users"), "users");
      assertEquals(sqlIdent("order items"), `"order items"`);
      assertEquals(sqlIdent("public.users"), "public.users");
      assertEquals(sqlIdent(`t."weird col"`), `t."weird col"`);
      assertEquals(sqlIdent(`MixedCase`), `MixedCase`);
      assertEquals(sqlIdent(`needs-quote`), `"needs-quote"`);
    },
  );

  await t.step("colList(): identifier-escaped join", () => {
    assertEquals(
      colList(["id", "first name", "email"]),
      `id, "first name", email`,
    );
  });

  await t.step("sqlIn(): mix plain JS (literal) and SQL fragments", () => {
    // Plain JS → literal(); sqlRaw/sqlCat/SQL → spliced as expressions.
    const frag = SQL`lower(${sqlRaw`${"email"}`})`;
    const cat = sqlCat`/u/${"id"}`; // → ('/u/' || id)
    const out = sqlIn([1, "O'Hara", true, null, sqlRaw`${"name"}`, frag, cat]);
    assertEquals(
      out,
      `(` +
        `1, 'O''Hara', TRUE, NULL, name, lower(email), ('/u/' || id)` +
        `)`,
    );
  });

  await t.step("assignments(): safe key=expr with mixed value types", () => {
    const out = assignments({
      id: 7, // literal
      name: sqlRaw`${"full_name"}`, // identifier expr
      updated_at: SQL`${new Date("2025-01-01T00:00:00Z")}`, // literalized by .text()
      path: sqlCat`/p/${"id"}`, // ('/p/' || id)
      "odd key": "O'Hara", // key quoted, value literal
    });
    assertEquals(
      out,
      [
        `id = 7`,
        `name = full_name`,
        `updated_at = '2025-01-01T00:00:00.000Z'`,
        `path = ('/p/' || id)`,
        `"odd key" = 'O''Hara'`,
      ].join(", "),
    );
  });

  await t.step("selectAs(): expression AS quoted alias", () => {
    const pairs = [
      { expr: sqlRaw`count(*)`, as: "total" },
      { expr: sqlRaw`${"dept"}`, as: "department name" },
      { expr: SQL`coalesce(${sqlRaw`${"note"}`}, ${"N/A"})`, as: "note" },
    ] as const;
    assertEquals(
      selectAs(pairs),
      `count(*) AS total, dept AS "department name", coalesce(note, 'N/A') AS note`,
    );
  });

  await t.step(
    "valuesTuples(): INSERT VALUES rows (JS values + SQL frags)",
    () => {
      const rows = [
        { id: 1, name: "Alice", slug: sqlCat`/u/${"id"}` },
        { id: 2, name: "O'Hara", slug: sqlRaw`'/u/' || ${sqlRaw`${"id"}`}` },
      ] as const;
      const out = valuesTuples(rows, ["id", "name", "slug"]);
      assertEquals(
        out,
        [
          `(1, 'Alice', ('/u/' || id))`,
          `(2, 'O''Hara', '/u/' || id)`,
        ].join(",\n"),
      );
    },
  );

  await t.step("caseWhen(): readable CASE blocks with mixed inputs", () => {
    const out = caseWhen(
      [
        { when: sqlRaw`${"score"} >= 90`, then: "'A'" },
        { when: sqlRaw`${"score"} >= 80`, then: "'B'" },
        { when: sqlRaw`${"score"} >= 70`, then: "'C'" },
      ],
      sqlRaw`'F'`,
    );
    assertEquals(
      out,
      [
        `CASE`,
        `    WHEN score >= 90 THEN 'A'`,
        `    WHEN score >= 80 THEN 'B'`,
        `    WHEN score >= 70 THEN 'C'`,
        `    ELSE 'F'`,
        `END`,
      ].join("\n"),
    );
  });

  await t.step("withCTE(): tidy CTE header + final SQL", () => {
    const ctes = [
      {
        name: "base users",
        sql: `
          select id, name
          from ${sqlIdent("public.users")}
          where active = TRUE
        `,
      },
      {
        name: "named",
        sql:
          SQL`select id, upper(${sqlRaw`${"name"}`}) as name from ${sqlRaw`"base users"`}`,
      },
    ] as const;
    const finalSql = `
      select *
      from "named"
      where name like 'A%'
    `;
    const out = withCTE(ctes, finalSql);
    assertEquals(
      out,
      [
        `WITH "base users" AS (`,
        `  select id, name`,
        `  from public.users`,
        `  where active = TRUE`,
        `),`,
        `named AS (`,
        `  select id, upper(name) as name from "base users"`,
        `)`,
        `select *`,
        `from "named"`,
        `where name like 'A%'`,
      ].join("\n"),
    );
  });

  await t.step("unionAll(): clean join with trimming", () => {
    const out = unionAll([
      ` select 1 as n `,
      `select 2 as n`,
      SQL` select ${3} as n `,
    ]);
    assertEquals(
      out,
      ["select 1 as n", "select 2 as n", "select 3 as n"].join("\nUNION ALL\n"),
    );
  });

  await t.step("onConflictSet(): projection for EXCLUDED.* updates", () => {
    assertEquals(
      onConflictSet(["name", "email", "updated_at"]),
      `name = EXCLUDED.name, email = EXCLUDED.email, updated_at = EXCLUDED.updated_at`,
    );
  });

  await t.step("upsertFromStage(): dbt-like stage→target UPSERT", () => {
    const out = upsertFromStage({
      target: "public.users",
      stage: "stg_users",
      cols: ["id", "name", "email", "updated_at"],
      pk: ["id"],
      updateCols: ["name", "email", "updated_at"],
    });
    assertEquals(
      out,
      [
        `INSERT INTO public.users (id, name, email, updated_at)`,
        `SELECT s.id, s.name, s.email, s.updated_at`,
        `FROM stg_users AS s`,
        `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, updated_at = EXCLUDED.updated_at`,
      ].join("\n"),
    );
  });

  await t.step("cols(): prefix-qualified projection cloning", () => {
    assertEquals(
      cols("u", ["id", "full name", "email"]),
      `u.id AS id, u."full name" AS "full name", u.email AS email`,
    );
  });
});

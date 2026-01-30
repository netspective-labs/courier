// courier_test.ts
import { assert, assertEquals } from "@std/assert";
import { Courier } from "../connect/core.ts";
import { SQL } from "../connect/sql-text.ts";
import { z } from "@zod";
import "./sqlite.ts";
import { SchemaSQLBuilder } from "../connect/safe-sql.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test(
  "Courier SQLite driver (:memory:) supports arrays default, typed object transform, and drop-ins",
  async () => {
    const c = await Courier.connect("courier:sqlite::memory:");

    // Schema + data
    await c.exec(
      "create table people (id integer primary key, name text not null, age integer not null)",
    );
    await c.exec("insert into people(name, age) values (?, ?)", ["alice", 41]);
    await c.exec("insert into people(name, age) values (?, ?)", ["bob", 55]);

    // Default: arrays
    const r1 = await c.query(
      "select id, name, age from people where age > ? order by id",
      [40],
    );
    const a1 = await r1.all();
    assertEquals(a1.length, 2);
    assert(Array.isArray(a1[0]));
    assertEquals(a1[0].length, 3);
    assertEquals(a1[0][1], "alice");
    await r1.close();

    // Object mode with typed transform (safety)
    type Person = { id: number; name: string; age: number };
    const r2 = await c.query(
      "select id, name, age from people where name = ?",
      [
        "bob",
      ],
    );
    const p = await r2.first<Person>("object", {
      transform: (raw) => ({
        id: Number(raw.id),
        name: String(raw.name),
        age: Number(raw.age),
      }),
    });
    assert(p);
    assertEquals(p.name, "bob");
    assertEquals(p.age, 55);
    await r2.close();

    // Drop-ins stored in ".courier.d"
    await c.exec(
      `insert into ".courier.d"(path, contents, elaboration) values (?, ?, ?)`,
      [
        "config/app.json",
        JSON.stringify({ mode: "test" }),
        JSON.stringify({ purpose: "unit-test" }),
      ],
    );

    const m = await c.meta();
    assert(m.dropIns);

    const dropIns = [...m.dropIns((di) => di.path.startsWith("config/"))];
    assertEquals(dropIns.length, 1);
    assertEquals(dropIns[0].path, "config/app.json");
    assert(dropIns[0].lastModified instanceof Date);

    await c.close();
  },
);

Deno.test("Courier SQLite driver accepts SQL tagged templates", async () => {
  const c = await Courier.connect("courier:sqlite::memory:");
  await c.exec(
    "create table template_sql(id integer primary key, label text not null)",
  );
  await c.exec(
    SQL`insert into template_sql(label) values (${"templated"})`,
  );
  const r = await c.query(
    SQL`select label from template_sql where label = ${"templated"}`,
  );
  const rows = await r.all();
  assertEquals(rows.length, 1);
  assertEquals(rows[0][0], "templated");
  await r.close();
  await c.close();
});

Deno.test(
  "Courier SQLite driver emits Courier events when executing SQL tagged templates",
  async () => {
    const captured: Array<{ type: string; detail: unknown }> = [];
    const watch = (type: string) =>
      ((ev: Event) => {
        const ce = ev as CustomEvent;
        captured.push({ type, detail: ce.detail });
      }) as EventListener;

    const handlers = [
      { type: "courier:exec", handler: watch("courier:exec") },
      { type: "courier:query", handler: watch("courier:query") },
    ];
    for (const { type, handler } of handlers) {
      Courier.events.addEventListener(type, handler);
    }

    const c = await Courier.connect("courier:sqlite::memory:");
    try {
      await c.exec(
        SQL`create table template_sql(id integer primary key, label text not null)`,
      );
      await c.exec(
        SQL`insert into template_sql(label) values (${"templated"})`,
      );
      const q = await c.query(
        SQL`select label from template_sql where label = ${"templated"}`,
      );
      await q.all();
      await q.close();

      const execEvents = captured.filter(
        (e) =>
          e.type === "courier:exec" &&
          ((e.detail as Any).sql ?? "").includes("template_sql"),
      );
      assert(
        execEvents.some(
          (e) =>
            (e.detail as Any).sql ===
              "insert into template_sql(label) values ($1)",
        ),
      );

      const queryEvents = captured.filter(
        (e) =>
          e.type === "courier:query" &&
          ((e.detail as Any).sql ?? "").includes("select label"),
      );
      assertEquals(queryEvents.length, 1);
      assertEquals(
        (queryEvents[0].detail as Any).sql,
        "select label from template_sql where label = $1",
      );
      assertEquals((queryEvents[0].detail as Any).paramsKind, "array");
    } finally {
      for (const { type, handler } of handlers) {
        Courier.events.removeEventListener(type, handler);
      }
      await c.close();
    }
  },
);

Deno.test("SchemaSQLBuilder integrates with Courier DML", async () => {
  const c = await Courier.connect("courier:sqlite::memory:");
  const builder = new SchemaSQLBuilder(
    "builder_sql",
    z.object({
      id: z.number().int(),
      label: z.string(),
    }),
  );

  await c.exec(
    "create table builder_sql (id integer primary key, label text not null)",
  );
  await c.exec(builder.insert({ id: 1, label: "initial" }));
  await c.exec(builder.update({ label: "changed" }, { id: 1 }));

  const row = await c.query(
    builder.select(["label"]).where({ id: 1 }),
  );
  const rowData = await row.all();
  assertEquals(rowData[0][0], "changed");
  await row.close();

  await c.exec(builder.delete({ id: 1 }));
  const counts = await c.query(
    builder.count().where({ id: 1 }),
  );
  const countData = await counts.all();
  assertEquals(countData[0][0], 0);
  await counts.close();

  await c.close();
});

Deno.test(
  "Courier SQLite diagnostics: versions, capabilities, hints, and events",
  async () => {
    // Capture global Courier events
    const globalEvents: Array<{ type: string; detail: unknown }> = [];
    const onAnyGlobal = (type: string) =>
      ((ev: Event) => {
        const ce = ev as CustomEvent;
        globalEvents.push({ type, detail: ce.detail });
      }) as EventListener;

    const globalTypes = [
      "courier:driver-registered",
      "courier:connect",
      "courier:query",
      "courier:exec",
      "courier:tx",
      "courier:error",
      "courier:close",
    ] as const;

    const globalHandlers = globalTypes.map((t) => ({ t, h: onAnyGlobal(t) }));
    for (const { t, h } of globalHandlers) {
      Courier.events.addEventListener(t, h);
    }

    // Connect
    const c = await Courier.connect("courier:sqlite::memory:");

    // Capture per-connection events too (Courier wraps ops to emit them)
    const connEvents: Array<{ type: string; detail: unknown }> = [];
    const onAnyConn = (type: string) =>
      ((ev: Event) => {
        const ce = ev as CustomEvent;
        connEvents.push({ type, detail: ce.detail });
      }) as EventListener;

    const connTypes = [
      "courier:query",
      "courier:exec",
      "courier:tx",
      "courier:error",
      "courier:close",
    ] as const;
    const connHandlers = connTypes.map((t) => ({ t, h: onAnyConn(t) }));
    for (const { t, h } of connHandlers) c.events.addEventListener(t, h);

    // Drivers and basic info
    const drivers = Courier.getDrivers();
    assert(drivers.length > 0);
    assert(drivers.some((d) => d.accepts("courier:sqlite::memory:")));

    // Capabilities sanity
    const caps = c.capabilities.supports;
    assert(caps.size > 0);
    assert(caps.has("transactions"));
    assert(caps.has("streaming"));
    assert(caps.has("metadata.dropIns"));

    // Metadata diagnostics (product/driver identity + version presence if available)
    const meta = await c.meta();
    assert(meta.product?.name);
    assert(meta.driver?.name);
    assert(meta.url);

    // Create table and insert; these should emit exec events
    await c.exec("create table diag (id integer primary key, v text not null)");
    await c.exec("insert into diag(v) values (?)", ["x"]);
    await c.exec("insert into diag(v) values (?)", ["y"]);

    // Query with hint rowMode=array (advisory). Default consumption is arrays regardless.
    const rA = await c.query("select id, v from diag order by id", undefined, {
      tag: "diag-array",
      hints: { rowMode: "array" },
    });
    const rowsA = await rA.all(); // default arrays
    assertEquals(rowsA.length, 2);
    assert(Array.isArray(rowsA[0]));
    assertEquals(rowsA[0][1], "x");
    await rA.close();

    // Query with hint rowMode=object and consume with typed transform
    type DiagRow = { id: number; v: string };
    const rO = await c.query("select id, v from diag order by id", undefined, {
      tag: "diag-object",
      hints: { rowMode: "object" },
    });
    const typed = await rO.all<DiagRow>("object", {
      transform: (raw) => ({ id: Number(raw.id), v: String(raw.v) }),
    });
    assertEquals(typed[0].v, "x");
    assertEquals(typed[1].v, "y");
    await rO.close();

    // Transaction event diagnostics
    const txOut = await c.tx(async (tx) => {
      await tx.exec("insert into diag(v) values (?)", ["z"]);
      const r = await tx.query("select count(*) as c from diag");
      const first = await r.first("object");
      await r.close();
      // deno-lint-ignore no-explicit-any
      return Number((first as any)?.c);
    }, { tag: "diag-tx", mode: "immediate" });

    assertEquals(txOut, 3);

    // Ensure events occurred (at least once) in both scopes
    const hasGlobal = (t: string) => globalEvents.some((e) => e.type === t);
    const hasConn = (t: string) => connEvents.some((e) => e.type === t);

    assert(hasGlobal("courier:connect"));
    assert(hasGlobal("courier:exec"));
    assert(hasGlobal("courier:query"));
    assert(hasGlobal("courier:tx"));

    assert(hasConn("courier:exec"));
    assert(hasConn("courier:query"));
    assert(hasConn("courier:tx"));

    // Basic event payload sanity checks (not brittle)
    const qEvent = globalEvents.find((e) => e.type === "courier:query")
      // deno-lint-ignore no-explicit-any
      ?.detail as any;
    assert(qEvent);
    assert(typeof qEvent.sql === "string");
    assert(typeof qEvent.durationMs === "number");
    assert(qEvent.driver?.name);

    // Close connection (should emit close)
    await c.close();
    assert(hasGlobal("courier:close"));
    assert(hasConn("courier:close"));

    // Detach listeners
    for (const { t, h } of connHandlers) c.events.removeEventListener(t, h);
    for (const { t, h } of globalHandlers) {
      Courier.events.removeEventListener(t, h);
    }
  },
);

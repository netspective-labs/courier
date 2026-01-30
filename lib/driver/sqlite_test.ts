// courier_test.ts
import { assert, assertEquals } from "@std/assert";
import { Courier } from "../connect/core.ts";
import "./sqlite.ts";

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

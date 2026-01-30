# Courier Data Federation Library

Courier is a JDBC-inspired, TypeScript-native data federation library for Deno.
It provides a consistent, observable, and performance-first way to connect to
multiple data sources using a single API, while embracing modern web and
TypeScript idioms instead of Java-style ceremony.

Courier is **not an ORM**. It is a thin, principled abstraction over database
drivers designed for correctness, performance, and long-term maintainability.

Courier is developed under **Netspective Labs** and reflects Netspective’s
philosophy of deterministic systems, explicit tradeoffs, and production-grade
observability.

## Why Courier

Most database libraries fall into one of two traps:

- Low-level drivers that leak vendor complexity everywhere
- Heavy ORMs that hide too much and fail in edge cases

Courier sits deliberately in the middle:

- One mental model across data sources (JDBC/ODBC-inspired)
- No leaky abstractions
- No hidden state
- No guessing of types
- No magic

If you understand SQL and data systems, Courier stays out of your way.

## Design Philosophy

### Familiar mental model, modern execution

Courier mirrors the proven JDBC/ODBC model:

- Drivers self-register
- Connections are created from URLs
- Queries return result sets
- Metadata is queryable
- Errors are normalized

But Courier removes Java ceremony. Everything is async, iterable, and composable
using TypeScript-first idioms.

### Performance first, safety on demand

Courier defaults to **array-based rows**, mirroring JDBC’s index-based access
pattern.

- Fast
- Predictable
- Allocation-efficient

Type safety is opt-in:

- Object rows are requested explicitly
- Typed transforms are supplied by the consumer
- Drivers never infer types

Performance is the default. Safety is explicit.

### Web-native observability

Courier uses `EventTarget` and `CustomEvent`.

Events are emitted at two scopes:

- Global (`Courier.events`)
- Per-connection (`connection.events`)

This enables tracing, metrics, diagnostics, and audit logging without coupling
application logic to logging frameworks.

### Federation, not lowest common denominator

Courier does not attempt to homogenize databases.

- Core behavior is uniform
- Optional features are advertised via capabilities
- Driver-specific behavior is explicit

Courier favors correctness over pretending all databases are the same.

## Architecture Overview

```
Application
   ↓
Courier (registry, events, wrappers)
   ↓
CourierConnection
   ↓
Driver implementation
   ↓
Native / Node / Remote DB client
```

Courier consists of:

- **Core API** (`courier.ts`)
- **Drivers** (for example `sqlite.ts`)

## Quick Start

### Install

Courier is designed for Deno and modern TypeScript runtimes.

```
deno add jsr:@netspective-labs/courier
```

(Or import directly from the repository during development.)

### Connect to SQLite

```ts
import { Courier } from "./courier.ts";
import "./sqlite.ts"; // registers the SQLite driver

const conn = await Courier.connect("courier:sqlite::memory:");
```

### Execute SQL

```ts
await conn.exec(
  "create table people (id integer primary key, name text, age integer)",
);

await conn.exec(
  "insert into people(name, age) values (?, ?)",
  ["alice", 41],
);
```

### Query with default array rows (fast path)

```ts
const r = await conn.query("select id, name, age from people");
const rows = await r.all();

// rows: number[][]
console.log(rows[0][1]); // "alice"
```

### Query with typed object rows (safe path)

```ts
type Person = { id: number; name: string; age: number };

const r = await conn.query("select id, name, age from people");
const people = await r.all<Person>("object", {
  transform: (raw) => ({
    id: Number(raw.id),
    name: String(raw.name),
    age: Number(raw.age),
  }),
});
```

### Transactions

```ts
await conn.tx(async (tx) => {
  await tx.exec("insert into people(name, age) values (?, ?)", ["bob", 55]);
});
```

## Core API (`courier.ts`)

### Driver registry (JDBC: DriverManager)

Drivers register themselves and declare which URLs they accept. The first
matching driver is selected.

### Connections (JDBC: Connection)

A `CourierConnection` represents a logical session.

Responsibilities:

- Query and command execution
- Transaction management
- Metadata access
- Event emission
- Capability advertisement

Low-level access is available only via `unwrap()`.

### Queries and commands (JDBC: Statement / PreparedStatement)

Courier exposes:

- `query(sql, params?, options?)`
- `exec(sql, params?, options?)`

There is no explicit prepared-statement API in v1. Drivers may optimize
internally.

### Results (JDBC: ResultSet)

A `CourierResult` is a stream of rows.

- Default: arrays
- Optional: objects
- Optional: typed objects via transform

Row shape is chosen by the **consumer at read time**.

### Transactions (JDBC: Transaction management)

Transactions are function-scoped:

```ts
await conn.tx(async (tx) => {
  ...
});
```

Courier guarantees commit or rollback.

### Metadata (JDBC: DatabaseMetaData)

Courier exposes a practical subset:

- Product and driver identity
- Tables
- Columns
- Primary keys
- Drop-ins

All metadata is capability-guarded.

### Drop-ins (Courier-specific)

Drop-ins are a database-embedded filesystem abstraction.

Each drop-in has:

- `path`
- `contents`
- `elaboration`
- `lastModified`

They allow configuration and annotations to live inside the database itself.

### Capabilities

Connections advertise supported features such as:

- transactions
- streaming
- metadata access
- drop-ins
- driver hints

Capabilities allow tools to adapt safely.

### Events

Courier emits structured events for:

- Driver registration
- Connect / close
- Query / exec
- Transactions
- Errors

Events include timing and sanitized context.

## SQLite Driver (`sqlite.ts`)

### Implementation choice

The SQLite driver uses Deno’s built-in `node:sqlite` module.

Benefits:

- No native library downloads
- No segmentation faults
- Reliable `:memory:` usage
- Predictable behavior across environments

### URL scheme

Supported forms:

- `courier:sqlite::memory:`
- `courier:sqlite:file:./db.sqlite`
- `courier:sqlite:///absolute/or/relative/path.db`

### Drop-ins table

The driver creates a table named:

```
".courier.d"
```

Schema:

- `path` TEXT PRIMARY KEY
- `contents` (untyped)
- `elaboration` TEXT (JSON)
- `lastModified` TEXT (timestamp)

This table behaves like a database-embedded configuration directory.

## Testing

The test suite validates:

- Default array row behavior
- Typed object transforms
- Drop-ins persistence
- Metadata correctness
- Capabilities exposure
- Driver hints
- Global and per-connection events
- Transaction behavior

All tests use `:memory:` SQLite databases.

## Roadmap

Planned and likely future work:

- Additional drivers (PostgreSQL, MySQL, DuckDB)
- Optional high-performance SQLite FFI driver
- Driver preference and selection rules
- Statement caching and reuse
- Streaming backpressure hints
- Federated queries across multiple connections
- Tooling built on Courier metadata and events

Courier’s surface area will remain intentionally small.

## What Courier Is Not

Courier is intentionally not:

- An ORM
- A query builder
- A migration framework
- A “universal SQL” abstraction

Courier assumes you know your database and want control.

## Summary

Courier provides:

- JDBC-style federation without Java baggage
- Performance by default
- Type safety when requested
- Web-native observability
- Database-embedded configuration via drop-ins
- A clean path for future drivers and federation

Courier is designed to be boring, predictable, and dependable. That is the
point.

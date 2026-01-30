# Courier Data Federation Library

Courier is a JDBC-inspired, TypeScript-native data federation library for Deno.  
It provides a consistent, observable, and performance-first way to connect to multiple data sources using a single API, while embracing modern web and TypeScript idioms instead of Java-style ceremony.

Courier is **not an ORM**. It is a thin, principled abstraction over database drivers designed for correctness, performance, and long-term maintainability.

---

## Design Philosophy

Courier is built around a few non-negotiable ideas.

### Familiar mental model, modern execution

Courier intentionally mirrors the conceptual shape of JDBC and ODBC:

- Drivers register themselves
- Connections are created from URLs
- Queries return results
- Metadata can be queried
- Errors are normalized

At the same time, Courier avoids Java-style verbosity. Everything is async, iterable, and composable.

### Performance first, safety on demand

Courier defaults to **array-based rows** for performance.

- Arrays mirror JDBC’s index-based access pattern
- No object allocation overhead by default

Safety is opt-in:

- Consumers can request object rows
- Consumers can provide typed transforms
- Drivers never guess types

Performance is the default; correctness is explicit.

### Web-native observability

Courier uses `EventTarget` and `CustomEvent` instead of logging hooks or callbacks.

Events are emitted at two levels:

- Global (`Courier.events`)
- Per-connection (`connection.events`)

This enables tracing, metrics, auditing, and debugging without modifying driver code.

### Federation, not lowest common denominator

Courier does not attempt to hide database differences.

- Core behavior is uniform
- Optional features are advertised via capabilities
- Driver-specific features are explicit

This avoids fragile abstractions that work poorly everywhere.

---

## Architecture Overview

Courier has two main layers:

1. **Core API** (`courier.ts`)
2. **Drivers** (for example, `sqlite.ts`)

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

---

## Core API (`courier.ts`)

### Driver registry

Drivers register themselves with Courier and declare which URLs they accept.

The first matching driver is used, similar to JDBC’s `DriverManager`, but simpler and explicit.

### Connections

A `CourierConnection` represents a logical session with a data source.

Responsibilities:

- Execute queries and commands
- Manage transactions
- Expose metadata
- Emit events
- Advertise capabilities

Low-level vendor access is available only via `unwrap()`.

### Query execution

Courier exposes two core operations:

- `query(sql, params?, options?)`
- `exec(sql, params?, options?)`

There is no distinction between statements and prepared statements in v1.  
Drivers may optimize internally.

### Results and row shapes

A `CourierResult` represents a stream of rows.

Default behavior:

- `rows()` → arrays
- `all()` → arrays
- `first()` → array

Opt-in safety:

- `rows("object")` → objects
- `rows<T>("object", { transform })` → typed objects

The **consumer chooses the row shape at read time**, not at query time.

### Typed transforms

Typed transforms are consumer-defined functions that convert raw object rows into domain types.

Courier deliberately avoids automatic type inference.

### Transactions

Transactions are expressed as functions:

```
await conn.tx(async (tx) => {
  await tx.exec(...)
  await tx.query(...)
})
```

Courier guarantees:

- Automatic commit on success
- Automatic rollback on error
- Optional transaction modes when supported

### Metadata

`CourierMeta` exposes a practical subset of database metadata:

- Product and driver identity
- Tables
- Columns
- Primary keys
- Drop-ins (Courier-specific)

All metadata methods are capability-guarded.

### Drop-ins

Drop-ins are a Courier-specific abstraction that models a simple filesystem stored inside the data source.

Each drop-in has:

- `path`
- `contents`
- `elaboration` (optional metadata)
- `lastModified`

Drop-ins allow configuration, feature flags, and annotations to live inside the database itself.

### Capabilities

Each connection advertises supported features such as:

- transactions
- streaming
- metadata access
- drop-ins
- driver hints

Capabilities allow tools and applications to adapt safely.

### Events

Courier emits structured events for:

- Driver registration
- Connection open/close
- Query execution
- Command execution
- Transactions
- Errors

Events include timing and sanitized context and are suitable for production observability.

---

## SQLite Driver (`sqlite.ts`)

### Why `node:sqlite`

The SQLite driver uses Deno’s built-in `node:sqlite` module.

Benefits:

- No native `.so` downloads
- No segmentation faults
- Stable across environments
- Works reliably with `:memory:` databases

This prioritizes correctness and portability for v1.

### URL scheme

Supported forms:

- `courier:sqlite::memory:`
- `courier:sqlite:file:./db.sqlite`
- `courier:sqlite:///absolute/or/relative/path.db`

### Query strategy

Internally:

- SQLite yields object rows
- Courier projects arrays by default using column order
- Object rows are returned only when requested
- Typed transforms are applied only when supplied

### Driver hints

The SQLite driver honors `rowMode` hints when possible.

Hints are advisory and never change semantics.

### Transactions

Transactions are implemented using explicit `BEGIN / COMMIT / ROLLBACK`.

Supported modes:

- deferred
- immediate
- exclusive

### Metadata

Metadata is implemented using:

- `sqlite_master`
- `PRAGMA table_info`

This supports tooling, diagnostics, and introspection.

### Drop-ins table

The SQLite driver creates a table named:

```
".courier.d"
```

Schema:

- `path` TEXT PRIMARY KEY
- `contents` (untyped)
- `elaboration` TEXT (JSON)
- `lastModified` TEXT (timestamp)

This table acts like a database-embedded configuration directory.

---

## Testing

Courier includes a comprehensive test suite that validates:

- Default array row behavior
- Typed object transforms
- Drop-ins persistence
- Metadata correctness
- Capabilities exposure
- Driver hints
- Global and per-connection events
- Transaction behavior

All tests use `:memory:` SQLite databases for isolation and speed.

---

## Extension Guidelines

When extending Courier:

- Do not change the default row shape
- Do not infer types automatically
- Add features behind capabilities
- Prefer hints over flags
- Keep driver contracts minimal
- Preserve event semantics

If a feature cannot be implemented safely for all drivers, it should not be part of the core API.

---

## What Courier Is Not

Courier is intentionally not:

- An ORM
- A query builder
- A schema migration tool
- A database abstraction that hides differences

Courier is a federation layer with strong guarantees and explicit trade-offs.

---

## Summary

Courier provides:

- JDBC-style federation without Java baggage
- Performance by default
- Type safety when requested
- Built-in observability
- Database-embedded configuration via drop-ins
- A clean path for future drivers and extensions

Courier is designed to be boring, predictable, and dependable.  
That is the point.

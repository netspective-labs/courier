# Courier Data Movement (DM) Library

Courier DM is a family of modules for moving data between systems in a
consistent, typed, and testable way.

It has three main goals:

1. Treat “data movement” (ETL/ELT, CDC, streaming, batch, etc.) as a first-class
   concept in Courier, not just ad-hoc scripts.
2. Provide a small, composable TypeScript API that can be used directly in Deno,
   but is generic enough to be wrapped by higher-level markdown playbooks and
   notebooks.
3. Make Singer and Airbyte “first-class citizens” of the Courier world, while
   still treating them as profiles within a more general Data Movement Protocol
   (DataMP).

In other words: Courier is the infrastructure layer; pipelines and markdown
notebooks build orchestration and UX on top.

## DataMP and profiles

Courier starts by defining a protocol model, called the Data Movement Protocol
(DataMP or “Data Move”):

- A protocol id (`DataMoveProtocolId`) identifies which profile is in use, e.g.:

  - `"singer"` for Singer-style JSON messages.
  - `"airbyte"` for Airbyte-style JSON messages.
  - `"data-move-protocol"` for Courier’s own control/diagnostics envelopes.
  - Other lowercase strings for additional profiles (CDC, logs, metrics, etc.).

- A “profile” is a concrete shape and behavior for messages on the wire. Singer
  is one such profile, and Airbyte is another.

This lets Courier unify:

- Singer-style taps/targets that already speak the Singer JSON protocol.
- Airbyte-style sources/destinations that already speak the Airbyte JSON
  protocol.
  - Native taps/targets that speak typed DataMP messages and may be adapted into
    Singer, Airbyte, or other profiles.
- Future profiles (e.g., bespoke CDC streams or observability feeds) without
  redesigning the system.

## What `protocol.ts` defines

`protocol.ts` is the foundational module for Courier. It provides all
profile-agnostic DataMP types and the Courier control/diagnostics layer.
Profile-specific wire details for Singer and Airbyte live alongside it in
`singer.ts` and `airbyte.ts`.

### Profile wire schemas (Singer and Airbyte)

Singer and Airbyte are implemented as DataMP profiles with their own Zod schemas
and adapters:

- `singer.ts` defines:

  - `SingerMessageType` – discriminator: "SCHEMA", "RECORD", "STATE",
    "ACTIVATE_VERSION".
  - `singerSchemaWireSchema` – Singer SCHEMA messages (stream, JSON Schema, key
    and bookmark properties).
  - `singerRecordWireSchema` – Singer RECORD messages (stream, record object,
    extracted time, version).
  - `singerStateWireSchema` – Singer STATE messages (opaque state JSON).
  - `singerActivateVersionWireSchema` – Singer ACTIVATE_VERSION messages (stream

    - version).
  - `singerWireMessageSchema` – discriminated union of all Singer wire messages.

- `airbyte.ts` defines equivalent Airbyte profile wire shapes, e.g.:

  - Configured catalog and stream metadata types.
  - RECORD messages with Airbyte’s `record` envelope.
  - STATE messages using Airbyte’s state format.
  - LOG/TRACE and other control messages as per the Airbyte spec.
  - A discriminated union of all Airbyte wire messages.

These provide typed, validated surfaces for interacting with existing Singer
taps/targets and Airbyte sources/destinations.

### Data Move superset messages

A small Courier-specific envelope layer for control and diagnostics:

- `dataMoveNatureSchema` – nature of the message: "TRACE", "ERROR", "BARRIER",
  "METRICS".
- Base envelope with:

  - `protocol: "data-move-protocol"`
  - `nature`
  - optional `stream`, `payload`, `ts`.

Concrete superset message types:

- `dmTraceMessageSchema` – TRACE diagnostics with message, optional level
  (debug/info/warn).
- `dmErrorMessageSchema` – ERROR envelope with human-readable `error` and
  optional `details`.
- `dmBarrierMessageSchema` – BARRIER envelope for checkpoints, with `barrierId`.
- `dmMetricsMessageSchema` – METRICS envelope with a string→number map.

All of these are combined in `dataMoveMessageSchema`, the discriminated union on
`nature`.

This gives Courier a standard way to carry logs, errors, metrics, and pipeline
barriers alongside data records, regardless of whether the records are flowing
via Singer, Airbyte, or a Courier-native profile.

### Unified wire message union

`dataMoveWireMessageSchema` is the top-level of the wire side:

- Union of:

  - Singer wire messages (`singerWireMessageSchema`),
  - Airbyte wire messages (from `airbyte.ts`),
  - and `dataMoveMessageSchema`.

This is the “everything that can appear on the wire” union for initial profiles.
It allows a single stream or log to carry Singer data, Airbyte data, and Courier
control messages together.

### Typed Zod layer for Data Move streams

On top of the wire formats, Courier defines a typed layer for actual data:

- `StreamSchemaMap` – map from stream name to Zod object schema.
- `InferStreamRecord` – infers the TypeScript type of records for a given stream
  key.
- `DataMoveStreamDef` – definition of a stream:

  - `name`
  - `schema` (the Zod schema)
  - optional `keyProperties`
  - optional `bookmarkProperties`

This is the bridge between:

- Strongly typed data models (per stream, using Zod).
  - Profile-specific representations on the wire (Singer, Airbyte, Data Move
    superset, etc.).

### Typed Data Move messages

Typed typed-level abstractions:

- `dataMoveTypedSchemaMessageSchema(schemas)` – typed SCHEMA messages which wrap
  a `DataMoveStreamDef`.
- `dataMoveTypedRecordMessageSchema(streamName, streamSchema)` – typed RECORD
  messages for a given stream.
- `dataMoveTypedStateMessageSchema<TState>()` – typed STATE messages for
  arbitrary state shapes.

A generic union function:

- `dataMoveTypedMessageSchema(schemas, TState?)` – returns a union of:

  - typed SCHEMA messages,
  - typed STATE messages,
  - a generic RECORD message,
  - and Data Move superset messages (TRACE/ERROR/BARRIER/METRICS).

These define how the Data Move Engine sees messages internally: as typed,
Zod-validated objects rather than raw JSON, regardless of whether they will
eventually be emitted as Singer or Airbyte messages.

### Transforms between typed and profile wire (Singer, Airbyte)

Zod transforms are used to adapt typed messages into profile-specific wire
messages:

- In `singer.ts`:

  - `dataMoveTypedRecordToSingerRecordWireSchema(streamName, streamSchema)`

    - Typed RECORD → Singer RECORD wire shape.
  - `dataMoveTypedStateToSingerStateWireSchema<TState>()`

    - Typed STATE → Singer STATE wire shape (opaque JSON).
  - `dataMoveSingerSchemaWireFromMetaSchema`

    - Takes metadata (stream name, JSON Schema, key/bookmark properties) and
      generates a Singer SCHEMA wire message.

- In `airbyte.ts`:

  - Equivalent helpers that map typed RECORD/STATE and stream metadata into
    Airbyte’s RECORD, STATE, and catalog messages.

These are the primary adaptation points for using typed pipelines with both
Singer and Airbyte ecosystems.

### Data Move Engine (taps, targets, transforms, pipeline)

Defines the core runtime plumbing:

- `DataMoveTapContext<TState>` – context for taps, including initial state.

- `DataMoveTap<TSchemas, TState>` – a source of messages:

  - `id`
  - `streams` – map of stream definitions
  - `read(ctx)` – async iterator of `DataMoveTypedMessage`.

- `DataMoveTarget<TSchemas, TState>` – a sink:

  - `id`
  - optional `init()`
  - `handleMessage(msg)`
  - optional `finalize()`

- `DataMoveMessageTransform<TSchemas, TState>` – mid-pipeline transform/filter:

  - `name`
  - `apply(msg)` returns one, many, or zero messages (sync or async).

- `DataMovePipelineOptions<TSchemas, TState>` – describes a pipeline:

  - `tap`
  - `target`
  - optional `transforms[]`
  - optional `initialState`, `onState(state)` callback
  - optional `logger`

The pipeline runner:

- `dataMovementPipeline(opts)`:

  - Calls `target.init()`.
  - Iterates the tap, runs each message through transforms.
  - Delivers final messages to the target.
  - Tracks and surfaces STATE messages via `onState`.
  - Logs and rethrows target errors.
  - Calls `target.finalize()` at the end.

This is the “engine block” of Courier: taps + transforms + target wired together
in a standard way, independent of whether the tap/target are Singer-based,
Airbyte-based, or native.

### Single-stream convenience helpers

For simple or early use cases, Courier provides helpers for single-stream
scenarios:

- `dataMoveSingleStreamMap(name, schema)` – build a one-stream
  `StreamSchemaMap`.
- `dataMoveSingleStreamDef(name, schema, opts?)` – build a single
  `DataMoveStreamDef`.
- `dataMoveSingleStreamRecordMessageSchema(streamName, schema)` – typed RECORD
  schema for single-stream pipelines.
- Profile adapters such as:

  - `dataMoveSingleStreamRecordToSingerWireSchema(streamName, schema)` – direct
    transform from typed single-stream RECORD to Singer RECORD wire message.
  - Airbyte equivalents for transforming single-stream typed messages into
    Airbyte RECORDs.

These helpers make it easy to use Courier in small utilities or prototypes
without committing to multi-stream complexity, while still being able to emit
either Singer or Airbyte messages.

## What the tests do

The Courier tests are designed as both correctness suites and living specs for
how to use `protocol.ts` plus the profile modules:

- `protocol_test.ts` focuses on:

  - Typed DataMP abstractions (streams, typed messages, and the union).
  - Single-stream helpers.
  - The Data Move Engine with synthetic taps/targets and superset diagnostics
    messages.

- `singer_test.ts` focuses on:

  - Canonical Singer wire messages (SCHEMA, RECORD, STATE, ACTIVATE_VERSION).
  - The Singer discriminated union.
  - Typed ↔ Singer transforms and single-stream helpers that emit Singer
    messages.

- `airbyte_test.ts` focuses on:

  - Canonical Airbyte messages (e.g., RECORD, STATE, LOG, catalog).
  - The Airbyte discriminated union.
  - Typed ↔ Airbyte transforms and single-stream helpers that emit Airbyte
    messages.

Together, they:

1. Validate profile schemas

   - Use canonical-looking Singer and Airbyte examples (inspired by their
     official docs).
   - Ensure the wire schemas and profile unions accept and preserve these
     messages.
   - Confirm `dataMoveWireMessageSchema` can accept both Singer and Airbyte
     messages as part of its union.

2. Exercise typed ↔ profile transforms

   - Build simple `users` stream schemas with Zod.
   - Verify:

     - Typed RECORD messages round-trip through
       `dataMoveTypedRecordMessageSchema`.
     - Typed → Singer and typed → Airbyte transforms for RECORD and STATE behave
       as expected.
     - The metadata-driven SCHEMA/catalog builders produce valid Singer and
       Airbyte messages.

3. Demonstrate the typed union

   - Use `dataMoveTypedMessageSchema` to parse:

     - typed SCHEMA messages,
     - typed STATE messages,
     - typed RECORD messages,
     - and superset TRACE/ERROR/BARRIER/METRICS messages.

   - The tests show how to narrow and work with these variants in TypeScript.

4. Exercise the Data Move Engine end-to-end

   - Use synthetic taps emitting:

     - A typed SCHEMA message.
     - A sequence of typed RECORD messages.
     - A typed STATE message that increments a cursor/offset.
     - A BARRIER message using the superset schema.

   - Use in-memory targets that:

     - Track `init()` and `finalize()` calls.
     - Collect every message they receive.
     - Fail on purpose to test logging and error propagation.

5. Validate the superset diagnostics

   - Create examples of TRACE, ERROR, BARRIER, and METRICS messages.
   - Ensure `dataMoveMessageSchema` correctly discriminates and preserves their
     fields.

These tests serve as:

- Specs for how Courier is supposed to behave today.
- Concrete, copy-pastable patterns for future profiles and transports.
- A safety net for refactors in `protocol.ts`, `singer.ts`, `airbyte.ts`, and
  future Courier modules.

## Future evolution of Courier

Courier is meant to grow into a full family of modules under the `courier`
namespace:

- New profiles

  - Additional `DataMoveProtocolId` values for non-Singer / non-Airbyte
    integrations (CDC, log shipping, observability data, etc.).
  - Profile-specific adapters similar to the existing Singer and Airbyte
    adapters.

- Transports

  - Adapters for stdin/stdout, HTTP, S3/Blob storage, message queues, etc.
  - Reusable components that can “speak” DataMP on top of these transports.

- Higher-level orchestration hooks

  - Utilities for wiring Courier pipelines from markdown playbooks and
    notebooks.
  - Prebuilt taps and targets for common data sources (e.g., CSV, SQLite, HTTP
    APIs, etc.), emitting Singer or Airbyte protocol messages as needed.

The design principle: Courier stays focused on typed data movement and
protocol-level concerns; higher layers handle orchestration, UX, and markdown-
native workflows.

## Summary

- `courier` is the library for typed, protocol-aware data movement.

- `protocol.ts` defines the DataMP core:

  - Data Move superset diagnostics,
  - typed Zod schemas for streams and messages,
  - and the Data Move Engine.

- `singer.ts` and `airbyte.ts` define first-class profile adapters:

  - Singer wire schemas and transforms.
  - Airbyte wire schemas and transforms.

- The tests (`protocol_test.ts`, `singer_test.ts`, `airbyte_test.ts`) are both
  verification and documentation:

  - They demonstrate typical usage of the schemas, transforms, and pipeline
    engine.
  - They validate behavior end-to-end with synthetic Singer- and Airbyte-style
    taps and targets.

This gives Courier a solid, test-driven foundation to build richer orchestration
and “data courier” behavior on top of DataMP, with both Singer and Airbyte
treated as first-class ecosystems.

// lib/transfer/singer.ts
//
// Singer profile for Courier Data Movement Protocol (DataMP).
//
// This module contains:
// - Singer wire-level schemas (SCHEMA / RECORD / STATE / ACTIVATE_VERSION)
// - Transforms from typed DataMove messages -> Singer wire messages
// - A unified Singer+Courier-superset wire union for convenience.

import { z } from "@zod";

import {
  dataMoveMessageSchema,
  type DataMoveSupersetMessage,
  dataMoveTypedRecordMessageSchema,
  dataMoveTypedStateMessageSchema,
  type StreamSchemaMap,
} from "./protocol.ts";

/* -------------------------------------------------------------------------- */
/*                         Singer Profile – Wire Messages                     */
/* -------------------------------------------------------------------------- */

// Singer message "type" discriminator (Singer profile of DataMP).
export const singerMessageTypeSchema = z.union([
  z.literal("SCHEMA"),
  z.literal("RECORD"),
  z.literal("STATE"),
  z.literal("ACTIVATE_VERSION"),
]);
export type SingerMessageType = z.infer<typeof singerMessageTypeSchema>;

// Singer SCHEMA wire message (DataMP Singer profile).
export const singerSchemaWireSchema = z
  .object({
    type: z.literal("SCHEMA"),
    stream: z.string(),
    schema: z.record(z.string(), z.unknown()),
    key_properties: z.array(z.string()).optional(),
    bookmark_properties: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());

export type SingerSchemaWire = z.infer<typeof singerSchemaWireSchema>;

// Singer RECORD wire message (DataMP Singer profile).
export const singerRecordWireSchema = z
  .object({
    type: z.literal("RECORD"),
    stream: z.string(),
    record: z.record(z.string(), z.unknown()),
    time_extracted: z.string().optional(),
    version: z.number().optional(),
  })
  .catchall(z.unknown());

export type SingerRecordWire = z.infer<typeof singerRecordWireSchema>;

// Singer STATE wire message (DataMP Singer profile).
export const singerStateWireSchema = z
  .object({
    type: z.literal("STATE"),
    value: z.record(z.string(), z.unknown()),
  })
  .catchall(z.unknown());

export type SingerStateWire = z.infer<typeof singerStateWireSchema>;

// Singer ACTIVATE_VERSION wire message (DataMP Singer profile).
export const singerActivateVersionWireSchema = z
  .object({
    type: z.literal("ACTIVATE_VERSION"),
    stream: z.string(),
    version: z.number(),
  })
  .catchall(z.unknown());

export type SingerActivateVersionWire = z.infer<
  typeof singerActivateVersionWireSchema
>;

// Union of all Singer profile wire messages.
export const singerWireMessageSchema = z.discriminatedUnion("type", [
  singerSchemaWireSchema,
  singerRecordWireSchema,
  singerStateWireSchema,
  singerActivateVersionWireSchema,
]);

export type SingerWireMessage = z.infer<typeof singerWireMessageSchema>;

/* -------------------------------------------------------------------------- */
/*                 Unified Wire-Level DataMove (Singer + Superset)            */
/* -------------------------------------------------------------------------- */

// Unified wire-level message schema (Singer profile + Courier extensions).
export const dataMoveWireMessageSchema = z.union([
  singerWireMessageSchema,
  dataMoveMessageSchema,
]);

export type DataMoveWireMessage =
  | SingerWireMessage
  | DataMoveSupersetMessage;

/* -------------------------------------------------------------------------- */
/*     Zod Transforms: Typed DataMove Messages -> Singer Profile (Wire)       */
/* -------------------------------------------------------------------------- */

/**
 * Build a Zod transform schema that turns a typed DataMove RECORD message
 * into a Singer profile RECORD wire message.
 */
export function dataMoveTypedRecordToSingerRecordWireSchema<
  TSchemas extends StreamSchemaMap,
  TStream extends keyof TSchemas & string,
>(
  streamName: TStream,
  streamSchema: TSchemas[TStream],
) {
  return dataMoveTypedRecordMessageSchema<TSchemas, TStream>(
    streamName,
    streamSchema,
  ).transform(
    (msg): SingerRecordWire => ({
      type: "RECORD",
      stream: streamName,
      record: (msg as { record: unknown }).record as Record<string, unknown>,
      time_extracted: (msg as { timeExtracted?: Date }).timeExtracted
        ?.toISOString(),
    }),
  );
}

/**
 * Build a Zod transform schema that turns a typed DataMove STATE message into
 * a Singer profile STATE wire message. State remains opaque JSON.
 */
export function dataMoveTypedStateToSingerStateWireSchema<
  TState extends object,
>() {
  return dataMoveTypedStateMessageSchema<TState>().transform(
    (msg): SingerStateWire => ({
      type: "STATE",
      value: (msg as { state: unknown }).state as Record<string, unknown>,
    }),
  );
}

/**
 * Build a Zod schema for Singer SCHEMA wire messages from metadata plus
 * an externally provided JSON Schema. We intentionally avoid introspecting
 * Zod; upstream tooling can use zod-to-json-schema and feed that JSON here.
 */
export const dataMoveSingerSchemaWireFromMetaSchema = z
  .object({
    stream: z.string(),
    jsonSchema: z.record(z.string(), z.unknown()),
    keyProperties: z.array(z.string()).optional(),
    bookmarkProperties: z.array(z.string()).optional(),
  })
  .transform(
    (meta): SingerSchemaWire => ({
      type: "SCHEMA",
      stream: meta.stream,
      schema: meta.jsonSchema,
      key_properties: meta.keyProperties,
      bookmark_properties: meta.bookmarkProperties,
    }),
  );

/* -------------------------------------------------------------------------- */
/*  Single-Stream Singer Convenience Transform (on top of DataMove helpers)   */
/* -------------------------------------------------------------------------- */

/**
 * Convenience: build a Zod transform that turns a typed single-stream
 * DataMove RECORD message into a Singer profile RECORD wire message.
 */
export function dataMoveSingleStreamRecordToSingerWireSchema<
  TStreamName extends string,
>(
  streamName: TStreamName,
  schema: import("@zod").ZodObject<
    Record<string, import("@zod").ZodType>
  >,
) {
  // Minimal single-stream map for typing.
  const singleMap = { [streamName]: schema } as {
    [K in TStreamName]: import("@zod").ZodObject<
      Record<string, import("@zod").ZodType>
    >;
  };

  return dataMoveTypedRecordToSingerRecordWireSchema<
    typeof singleMap,
    TStreamName
  >(streamName, singleMap[streamName]);
}

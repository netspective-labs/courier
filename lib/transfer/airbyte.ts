// lib/transfer/airbyte.ts
//
// Courier data movement Airbyte profile.
//
// This module provides Zod schemas and helpers for working with the
// Airbyte protocol as a DataMove profile, including RECORD/STATE/LOG
// and other core Airbyte connector messages.
//
// Airbyte docs (protocol v1):
// - https://docs.airbyte.com/understanding-airbyte/airbyte-protocol
//
// The goal is to allow:
// - Running typed DataMove pipelines and emitting Airbyte messages.
// - Treating Airbyte sources/targets as first-class DataMP participants.

import { z, type ZodObject, type ZodType } from "@zod";

import {
  dataMoveTypedRecordMessageSchema,
  type DataMoveTypedStateMessage,
  dataMoveTypedStateMessageSchema,
  type StreamSchemaMap,
} from "./protocol.ts";

/* -------------------------------------------------------------------------- */
/*                      Airbyte Protocol Identifier (DataMP)                  */
/* -------------------------------------------------------------------------- */

export const AIRBYTE_PROTOCOL_ID = "airbyte" as const;

// dataMoveProtocolIdSchema already accepts arbitrary lowercase IDs,
// so "airbyte" is a valid DataMoveProtocolId. This constant is for
// convenience and consistency in pipelines.

/* -------------------------------------------------------------------------- */
/*                            Airbyte Message Types                           */
/* -------------------------------------------------------------------------- */

export const airbyteMessageTypeSchema = z.union([
  z.literal("RECORD"),
  z.literal("STATE"),
  z.literal("LOG"),
  z.literal("SPEC"),
  z.literal("CATALOG"),
  z.literal("CONNECTION_STATUS"),
  z.literal("TRACE"),
  z.literal("CONTROL"),
]);
export type AirbyteMessageType = z.infer<typeof airbyteMessageTypeSchema>;

/* -------------------------------------------------------------------------- */
/*                          Airbyte RECORD / STATE                            */
/* -------------------------------------------------------------------------- */

// Inner RECORD payload (AirbyteRecord).
export const airbyteRecordSchema = z
  .object({
    stream: z.string(),
    data: z.record(z.string(), z.unknown()),
    emitted_at: z.number().int().optional(), // epoch millis
  })
  .catchall(z.unknown());

export type AirbyteRecord = z.infer<typeof airbyteRecordSchema>;

// Top-level RECORD message.
export const airbyteRecordMessageSchema = z
  .object({
    type: z.literal("RECORD"),
    record: airbyteRecordSchema,
  })
  .catchall(z.unknown());

export type AirbyteRecordMessage = z.infer<typeof airbyteRecordMessageSchema>;

// Inner STATE payload (AirbyteState).
export const airbyteStateSchema = z
  .object({
    data: z.record(z.string(), z.unknown()),
  })
  .catchall(z.unknown());

export type AirbyteState = z.infer<typeof airbyteStateSchema>;

// Top-level STATE message.
export const airbyteStateMessageSchema = z
  .object({
    type: z.literal("STATE"),
    state: airbyteStateSchema,
  })
  .catchall(z.unknown());

export type AirbyteStateMessage = z.infer<typeof airbyteStateMessageSchema>;

/* -------------------------------------------------------------------------- */
/*                          Airbyte LOG / SPEC / ETC                          */
/* -------------------------------------------------------------------------- */

// LOG message.
export const airbyteLogMessageSchema = z
  .object({
    type: z.literal("LOG"),
    log: z
      .object({
        level: z.enum([
          "FATAL",
          "ERROR",
          "WARN",
          "INFO",
          "DEBUG",
          "TRACE",
        ]),
        message: z.string(),
        stack_trace: z.string().optional(),
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown());

export type AirbyteLogMessage = z.infer<typeof airbyteLogMessageSchema>;

// SPEC message (opaque spec object, we don’t enforce full structure here).
export const airbyteSpecMessageSchema = z
  .object({
    type: z.literal("SPEC"),
    spec: z.record(z.string(), z.unknown()),
  })
  .catchall(z.unknown());

export type AirbyteSpecMessage = z.infer<typeof airbyteSpecMessageSchema>;

// CATALOG message (AirbyteCatalog is complex; keep generic).
export const airbyteCatalogMessageSchema = z
  .object({
    type: z.literal("CATALOG"),
    catalog: z.record(z.string(), z.unknown()),
  })
  .catchall(z.unknown());

export type AirbyteCatalogMessage = z.infer<typeof airbyteCatalogMessageSchema>;

// CONNECTION_STATUS message.
export const airbyteConnectionStatusMessageSchema = z
  .object({
    type: z.literal("CONNECTION_STATUS"),
    connectionStatus: z
      .object({
        status: z.enum(["SUCCEEDED", "FAILED"]),
        message: z.string().optional(),
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown());

export type AirbyteConnectionStatusMessage = z.infer<
  typeof airbyteConnectionStatusMessageSchema
>;

// TRACE message (Airbyte trace types are nested; keep generic).
export const airbyteTraceMessageSchema = z
  .object({
    type: z.literal("TRACE"),
    trace: z.record(z.string(), z.unknown()),
  })
  .catchall(z.unknown());

export type AirbyteTraceMessage = z.infer<typeof airbyteTraceMessageSchema>;

// CONTROL message (Airbyte Cloud control plane; generic here).
export const airbyteControlMessageSchema = z
  .object({
    type: z.literal("CONTROL"),
    control: z.record(z.string(), z.unknown()),
  })
  .catchall(z.unknown());

export type AirbyteControlMessage = z.infer<typeof airbyteControlMessageSchema>;

/* -------------------------------------------------------------------------- */
/*                          Unified Airbyte Union (Wire)                      */
/* -------------------------------------------------------------------------- */

export const airbyteWireMessageSchema = z.discriminatedUnion("type", [
  airbyteRecordMessageSchema,
  airbyteStateMessageSchema,
  airbyteLogMessageSchema,
  airbyteSpecMessageSchema,
  airbyteCatalogMessageSchema,
  airbyteConnectionStatusMessageSchema,
  airbyteTraceMessageSchema,
  airbyteControlMessageSchema,
]);

export type AirbyteWireMessage = z.infer<typeof airbyteWireMessageSchema>;

/* -------------------------------------------------------------------------- */
/*       DataMove Typed <-> Airbyte Wire: Transform Schemas (Zod)            */
/* -------------------------------------------------------------------------- */

/**
 * Build a Zod transform that turns a typed DataMove RECORD message
 * into an Airbyte RECORD message.
 *
 * This lets Courier pipelines emit Airbyte-compatible output that
 * Airbyte destinations (or surveilr ingestion) can consume.
 */
export function dataMoveTypedRecordToAirbyteRecordSchema<
  TSchemas extends StreamSchemaMap,
  TStream extends keyof TSchemas & string,
>(
  streamName: TStream,
  streamSchema: TSchemas[TStream],
) {
  return dataMoveTypedRecordMessageSchema<TSchemas, TStream>(
    streamName,
    streamSchema,
  ).transform((msg): AirbyteRecordMessage => {
    // Zod 4 transform input is a complex inferred type; we narrow it to what we need.
    const m = msg as { record: unknown; timeExtracted?: Date };

    return {
      type: "RECORD",
      record: {
        stream: streamName,
        data: m.record as Record<string, unknown>,
        emitted_at: m.timeExtracted?.getTime(),
      },
    };
  });
}

/**
 * Build a Zod transform that turns a typed DataMove STATE message
 * into an Airbyte STATE message (opaque JSON state in state.data).
 *
 * This is sufficient for Airbyte connectors which expect standard
 * STATE messages to support incremental sync.
 */
export function dataMoveTypedStateToAirbyteStateSchema<
  TState extends object,
>() {
  return dataMoveTypedStateMessageSchema<TState>().transform(
    (msg): AirbyteStateMessage => {
      const m = msg as DataMoveTypedStateMessage<TState>;
      return {
        type: "STATE",
        state: {
          data: m.state as Record<string, unknown>,
        },
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/*      Convenience Aliases for Single-Stream Airbyte DataMove Pipelines      */
/* -------------------------------------------------------------------------- */

/**
 * Convenience helper for single-stream pipelines:
 * Given a single-stream Zod schema, build a transform from a typed
 * DataMove RECORD message into an Airbyte RECORD message.
 */
export function dataMoveSingleStreamRecordToAirbyteRecordSchema<
  TStreamName extends string,
>(
  streamName: TStreamName,
  schema: ZodObject<Record<string, ZodType>>,
) {
  // Minimal single-stream map for typing.
  const singleMap = { [streamName]: schema } as {
    [K in TStreamName]: ZodObject<Record<string, ZodType>>;
  };

  return dataMoveTypedRecordToAirbyteRecordSchema<
    typeof singleMap,
    TStreamName
  >(streamName, singleMap[streamName]);
}

/**
 * Convenience helper to turn typed DataMove STATE into Airbyte STATE
 * in single-state pipelines (no special typing beyond TState).
 */
export function dataMoveStateToAirbyteStateSchema<TState extends object>() {
  return dataMoveTypedStateToAirbyteStateSchema<TState>();
}

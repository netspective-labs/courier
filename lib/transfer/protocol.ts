// lib/transfer/protocol.ts
//
// Courier Data Movement Protocol (DataMP) and DataMove Engine.
//
// - "Data Movement Protocol (DataMP)" = protocol + message model (wire + typed).
// - "DataMove Engine" = runner that executes DataMove pipelines.
// - Profiles (Singer, Airbyte, etc.) live in separate modules.
// - Zod 4 is the core validation + transform layer; TS types are z.infer<>.

import { z, type ZodObject, ZodType } from "@zod";

/* -------------------------------------------------------------------------- */
/*                         Protocol Identifiers (DataMP)                      */
/* -------------------------------------------------------------------------- */

// Wire-level protocol identifiers.
//
// - "singer" : DataMP Singer profile (classic Singer wire JSON).
// - "data-move-protocol": Courier ETL superset / internal control messages.
// - Any other string: other DataMP profiles (CDC, logs, metrics, etc.).
export const dataMoveProtocolIdSchema = z.union([
  z.literal("singer"),
  z.literal("data-move-protocol"),
  z.string().regex(/^[a-z0-9._-]+$/),
]);
export type DataMoveProtocolId = z.infer<typeof dataMoveProtocolIdSchema>;

/* -------------------------------------------------------------------------- */
/*                    Courier Superset – Control / Diagnostics                */
/* -------------------------------------------------------------------------- */

export const dataMoveNatureSchema = z.union([
  z.literal("TRACE"),
  z.literal("ERROR"),
  z.literal("BARRIER"),
  z.literal("METRICS"),
]);
export type DataMoveNature = z.infer<typeof dataMoveNatureSchema>;

// Base envelope for Courier data movement superset messages.
export const dataMoveBaseSchema = z.object({
  protocol: z.literal("data-move-protocol"),
  nature: dataMoveNatureSchema,
  stream: z.string().optional(),
  payload: z.unknown().optional(),
  ts: z.string().optional(), // ISO-8601
});

// TRACE message (diagnostics).
export const dmTraceMessageSchema = dataMoveBaseSchema.extend({
  nature: z.literal("TRACE"),
  level: z
    .union([z.literal("debug"), z.literal("info"), z.literal("warn")])
    .optional(),
  message: z.string(),
});

// ERROR message (error envelope).
export const dmErrorMessageSchema = dataMoveBaseSchema.extend({
  nature: z.literal("ERROR"),
  error: z.string(),
  details: z.unknown().optional(),
});

// BARRIER message (pipeline checkpoints).
export const dmBarrierMessageSchema = dataMoveBaseSchema.extend({
  nature: z.literal("BARRIER"),
  barrierId: z.string(),
});

// METRICS message (metrics envelope).
export const dmMetricsMessageSchema = dataMoveBaseSchema.extend({
  nature: z.literal("METRICS"),
  metrics: z.record(z.string(), z.number()),
});

// Union of all Courier superset messages.
export const dataMoveMessageSchema = z.discriminatedUnion("nature", [
  dmTraceMessageSchema,
  dmErrorMessageSchema,
  dmBarrierMessageSchema,
  dmMetricsMessageSchema,
]);

export type DataMoveTraceMessage = z.infer<typeof dmTraceMessageSchema>;
export type DataMoveErrorMessage = z.infer<typeof dmErrorMessageSchema>;
export type DataMoveBarrierMessage = z.infer<typeof dmBarrierMessageSchema>;
export type DataMoveMetricsMessage = z.infer<typeof dmMetricsMessageSchema>;
export type DataMoveSupersetMessage = z.infer<typeof dataMoveMessageSchema>;

/* -------------------------------------------------------------------------- */
/*                         Zod Stream Schema Layer (DataMove)                 */
/* -------------------------------------------------------------------------- */

/**
 * Map of DataMove stream name -> Zod object schema.
 *
 * A "stream" is the core unit of data movement. Profiles (Singer, CDC, etc.)
 * share this conceptual model.
 */
export type StreamSchemaMap = Record<
  string,
  ZodObject<Record<string, ZodType>>
>;

/**
 * Infer the TypeScript record type for a given stream in a schema map.
 */
export type InferStreamRecord<
  TSchemas extends StreamSchemaMap,
  TStream extends keyof TSchemas & string,
> = z.infer<TSchemas[TStream]>;

/**
 * Typed DataMove stream definition with Zod schema and profile-level metadata.
 */
export interface DataMoveStreamDef<
  TSchemas extends StreamSchemaMap,
  TStream extends keyof TSchemas & string,
> {
  name: TStream;
  schema: TSchemas[TStream];
  keyProperties?: (keyof InferStreamRecord<TSchemas, TStream> & string)[];
  bookmarkProperties?: (keyof InferStreamRecord<TSchemas, TStream> & string)[];
}

/* -------------------------------------------------------------------------- */
/*                       Typed DataMove Message Abstractions                  */
/* -------------------------------------------------------------------------- */

/**
 * Typed SCHEMA message (local representation).
 * Wraps DataMoveStreamDef; usable under any profile.
 */
export const dataMoveTypedSchemaMessageSchema = <
  TSchemas extends StreamSchemaMap,
>(
  _schemas: TSchemas,
) =>
  z.object({
    protocol: dataMoveProtocolIdSchema,
    type: z.literal("SCHEMA"),
    stream: z.custom<
      DataMoveStreamDef<TSchemas, keyof TSchemas & string>
    >(),
  });

export type DataMoveTypedSchemaMessage<
  TSchemas extends StreamSchemaMap,
> = z.infer<ReturnType<typeof dataMoveTypedSchemaMessageSchema<TSchemas>>>;

/**
 * Typed RECORD message for a specific stream.
 */
export const dataMoveTypedRecordMessageSchema = <
  TSchemas extends StreamSchemaMap,
  TStream extends keyof TSchemas & string,
>(
  streamName: TStream,
  streamSchema: TSchemas[TStream],
) =>
  z.object({
    protocol: dataMoveProtocolIdSchema,
    type: z.literal("RECORD"),
    stream: z.literal(streamName),
    record: streamSchema,
    timeExtracted: z.date().optional(),
  });

export type DataMoveTypedRecordMessage<
  TSchemas extends StreamSchemaMap,
  TStream extends keyof TSchemas & string,
> = z.infer<
  ReturnType<typeof dataMoveTypedRecordMessageSchema<TSchemas, TStream>>
>;

/**
 * Typed STATE message (opaque state, protocol-level).
 */
export const dataMoveTypedStateMessageSchema = <TState = unknown>() =>
  z.object({
    protocol: dataMoveProtocolIdSchema,
    type: z.literal("STATE"),
    state: z.custom<TState>(),
  });

export type DataMoveTypedStateMessage<TState = unknown> = z.infer<
  ReturnType<typeof dataMoveTypedStateMessageSchema<TState>>
>;

/**
 * Generic union schema for typed DataMove messages.
 * (DataMove Engine will operate on these.)
 */
export const dataMoveTypedMessageSchema = <
  TSchemas extends StreamSchemaMap,
  TState = unknown,
>(
  schemas: TSchemas,
) => {
  const schemaMsg = dataMoveTypedSchemaMessageSchema(schemas);
  const stateMsg = dataMoveTypedStateMessageSchema<TState>();

  const genericRecordMsg = z.object({
    protocol: dataMoveProtocolIdSchema,
    type: z.literal("RECORD"),
    stream: z.string(),
    record: z.unknown(),
    timeExtracted: z.date().optional(),
  });

  return z.union([
    schemaMsg,
    stateMsg,
    genericRecordMsg,
    dataMoveMessageSchema,
  ]);
};

export type DataMoveTypedMessage<
  TSchemas extends StreamSchemaMap = StreamSchemaMap,
  TState = unknown,
> =
  | DataMoveTypedSchemaMessage<TSchemas>
  | DataMoveTypedRecordMessage<TSchemas, keyof TSchemas & string>
  | DataMoveTypedStateMessage<TState>
  | DataMoveSupersetMessage;

/* -------------------------------------------------------------------------- */
/*     DataMove Engine – Taps, Targets, Transforms, and Pipelines             */
/* -------------------------------------------------------------------------- */

export interface DataMoveTapContext<TState = unknown> {
  state?: TState;
}

/**
 * DataMove Tap: produces typed DataMove messages (DataMoveTypedMessage) for
 * one or more streams, under a specific profile (Singer or others).
 */
export interface DataMoveTap<
  TSchemas extends StreamSchemaMap,
  TState = unknown,
> {
  id: string;

  // Stream definitions (Zod-native).
  streams: {
    [K in keyof TSchemas & string]: DataMoveStreamDef<TSchemas, K>;
  };

  // Core read method: emits a stream of typed DataMove messages.
  read(ctx: DataMoveTapContext<TState>): AsyncIterable<
    DataMoveTypedMessage<TSchemas, TState>
  >;
}

/**
 * DataMove Target: consumes typed DataMove messages for
 * data movement/materialization.
 */
export interface DataMoveTarget<
  TSchemas extends StreamSchemaMap,
  TState = unknown,
> {
  id: string;

  init?(): Promise<void> | void;

  handleMessage(
    msg: DataMoveTypedMessage<TSchemas, TState>,
  ): Promise<void> | void;

  finalize?(): Promise<void> | void;
}

/**
 * DataMove Transform: mid-pipeline profile-aware transformation/filtering.
 */
export interface DataMoveMessageTransform<
  TSchemas extends StreamSchemaMap,
  TState = unknown,
> {
  name: string;
  apply(
    msg: DataMoveTypedMessage<TSchemas, TState>,
  ):
    | DataMoveTypedMessage<TSchemas, TState>
    | DataMoveTypedMessage<TSchemas, TState>[]
    | null
    | undefined
    | Promise<
      | DataMoveTypedMessage<TSchemas, TState>
      | DataMoveTypedMessage<TSchemas, TState>[]
      | null
      | undefined
    >;
}

/**
 * DataMovePipelineOptions: describes a DataMove pipeline to be executed
 * by the DataMove Engine. The pipeline is profile-neutral.
 */
export interface DataMovePipelineOptions<
  TSchemas extends StreamSchemaMap,
  TState = unknown,
> {
  tap: DataMoveTap<TSchemas, TState>;
  target: DataMoveTarget<TSchemas, TState>;
  transforms?: DataMoveMessageTransform<TSchemas, TState>[];

  initialState?: TState;
  onState?(state: TState): Promise<void> | void;

  logger?: Pick<typeof console, "debug" | "info" | "warn" | "error">;
}

/* ------------------------------ Type Guards -------------------------------- */

function isDataMoveStateMessage<
  TSchemas extends StreamSchemaMap,
  TState,
>(
  msg: DataMoveTypedMessage<TSchemas, TState>,
): msg is DataMoveTypedStateMessage<TState> {
  return "type" in msg && msg.type === "STATE";
}

/* ------------------------------ DataMove Engine ---------------------------- */

/**
 * dataMovementPipeline:
 * Executes a DataMove pipeline defined by DataMovePipelineOptions.
 *
 * Responsibilities:
 * - Invoke the tap to obtain typed DataMove messages.
 * - Run transforms (message-level).
 * - Dispatch messages to the target.
 * - Handle STATE messages via onState callback.
 */
export async function dataMovementPipeline<
  TSchemas extends StreamSchemaMap,
  TState = unknown,
>(opts: DataMovePipelineOptions<TSchemas, TState>): Promise<void> {
  const {
    tap,
    target,
    transforms = [],
    initialState,
    onState,
    logger = console,
  } = opts;

  let currentState = initialState;

  if (target.init) {
    await target.init();
  }

  const ctx: DataMoveTapContext<TState> = { state: currentState };

  for await (const msg of tap.read(ctx)) {
    let queue: DataMoveTypedMessage<TSchemas, TState>[] = [msg];

    for (const transform of transforms) {
      const nextQueue: DataMoveTypedMessage<TSchemas, TState>[] = [];

      for (const entry of queue) {
        const result = await transform.apply(entry);
        if (!result) continue;

        if (Array.isArray(result)) {
          nextQueue.push(...result);
        } else {
          nextQueue.push(result);
        }
      }

      queue = nextQueue;
      if (queue.length === 0) break;
    }

    for (const finalMsg of queue) {
      if (isDataMoveStateMessage(finalMsg)) {
        currentState = finalMsg.state;
        if (onState) await onState(currentState);
      }

      try {
        await target.handleMessage(finalMsg);
      } catch (err) {
        logger.error(
          `[DataMove Engine] target "${target.id}" failed to handle message`,
          err,
        );
        throw err;
      }
    }
  }

  if (target.finalize) {
    await target.finalize();
  }
}

/* -------------------------------------------------------------------------- */
/*      Single-Stream DataMove Convenience Builders (Zod-Native Profiles)     */
/* -------------------------------------------------------------------------- */

/**
 * Build a minimal single-stream schema map.
 */
export function dataMoveSingleStreamMap<TStreamName extends string>(
  name: TStreamName,
  schema: ZodObject<Record<string, ZodType>>,
) {
  return { [name]: schema } as {
    [K in TStreamName]: ZodObject<Record<string, ZodType>>;
  };
}

/**
 * Build a DataMoveStreamDef for a single stream.
 */
export function dataMoveSingleStreamDef<
  TStreamName extends string,
>(
  name: TStreamName,
  schema: ZodObject<Record<string, ZodType>>,
  opts?: {
    keyProperties?: string[];
    bookmarkProperties?: string[];
  },
): DataMoveStreamDef<
  { [K in TStreamName]: ZodObject<Record<string, ZodType>> },
  TStreamName
> {
  return {
    name,
    schema,
    keyProperties: opts?.keyProperties as
      | (
        & keyof InferStreamRecord<
          { [K in TStreamName]: ZodObject<Record<string, ZodType>> },
          TStreamName
        >
        & string
      )[]
      | undefined,
    bookmarkProperties: opts?.bookmarkProperties as
      | (
        & keyof InferStreamRecord<
          { [K in TStreamName]: ZodObject<Record<string, ZodType>> },
          TStreamName
        >
        & string
      )[]
      | undefined,
  };
}

/**
 * Build a Zod schema for a typed single-stream RECORD message.
 */
export function dataMoveSingleStreamRecordMessageSchema<
  TStreamName extends string,
>(
  streamName: TStreamName,
  schema: ZodObject<Record<string, ZodType>>,
) {
  return dataMoveTypedRecordMessageSchema<
    { [K in TStreamName]: ZodObject<Record<string, ZodType>> },
    TStreamName
  >(streamName, schema);
}

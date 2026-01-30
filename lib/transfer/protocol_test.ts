// lib/transfer/protocol_test.ts
//
// Tests for Courier Data Movement Protocol (DataMP) core and DataMove Engine.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "@zod";

import {
  dataMovementPipeline,
  dataMoveMessageSchema,
  type DataMoveMessageTransform,
  dataMoveSingleStreamDef,
  dataMoveSingleStreamMap,
  dataMoveSingleStreamRecordMessageSchema,
  type DataMoveStreamDef,
  type DataMoveSupersetMessage,
  type DataMoveTap,
  type DataMoveTapContext,
  type DataMoveTarget,
  type DataMoveTypedMessage,
  dataMoveTypedMessageSchema,
  type DataMoveTypedRecordMessage,
  type DataMoveTypedSchemaMessage,
  type DataMoveTypedStateMessage,
  dmBarrierMessageSchema,
} from "./protocol.ts";

/* -------------------------------------------------------------------------- */
/*                  Typed DataMove union + helper builder tests               */
/* -------------------------------------------------------------------------- */

Deno.test("Typed DataMove core helpers and unions", async (t) => {
  await t.step("dataMoveTypedMessageSchema generic union", () => {
    const userRecordSchema = z.object({
      id: z.number(),
      name: z.string(),
    });

    type UserState = { cursor: number };

    const schemas = {
      users: userRecordSchema,
    } satisfies Record<string, z.ZodObject<Record<string, z.ZodType>>>;

    const unionSchema = dataMoveTypedMessageSchema<typeof schemas, UserState>(
      schemas,
    );

    const schemaMsg: DataMoveTypedSchemaMessage<typeof schemas> = {
      protocol: "singer",
      type: "SCHEMA",
      stream: {
        name: "users",
        schema: schemas.users,
      } as DataMoveStreamDef<typeof schemas, "users">,
    };

    const stateMsg: DataMoveTypedStateMessage<UserState> = {
      protocol: "singer",
      type: "STATE",
      state: { cursor: 1 },
    };

    const recordMsg: DataMoveTypedRecordMessage<typeof schemas, "users"> = {
      protocol: "singer",
      type: "RECORD",
      stream: "users",
      record: { id: 1, name: "Mary" },
      timeExtracted: new Date("2020-01-01T00:00:00.000Z"),
    };

    const traceMsg: DataMoveSupersetMessage = {
      protocol: "data-move-protocol",
      nature: "TRACE",
      message: "ok",
      ts: new Date().toISOString(),
    };

    const parsedSchema = unionSchema.parse(
      schemaMsg,
    ) as DataMoveTypedSchemaMessage<typeof schemas>;
    assertEquals(parsedSchema.type, "SCHEMA");

    const parsedState = unionSchema.parse(
      stateMsg,
    ) as DataMoveTypedStateMessage<UserState>;
    assertEquals(parsedState.type, "STATE");

    const parsedRecord = unionSchema.parse(
      recordMsg,
    ) as DataMoveTypedRecordMessage<typeof schemas, "users">;
    assertEquals(parsedRecord.type, "RECORD");

    const parsedTrace = unionSchema.parse(
      traceMsg,
    ) as DataMoveSupersetMessage;
    assertEquals(parsedTrace.nature, "TRACE");
  });

  await t.step("dataMoveSingleStreamMap + dataMoveSingleStreamDef", () => {
    const streamName = "users";
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });

    const schemas = dataMoveSingleStreamMap(streamName, schema);
    type Schemas = typeof schemas;

    assert("users" in schemas);
    const def: DataMoveStreamDef<Schemas, "users"> = dataMoveSingleStreamDef(
      streamName,
      schemas[streamName],
      {
        keyProperties: ["id"],
        bookmarkProperties: [],
      },
    );

    assertEquals(def.name, "users");
    assert(def.schema === schemas.users);
    assertEquals(def.keyProperties, ["id"]);
  });

  await t.step("dataMoveSingleStreamRecordMessageSchema", () => {
    const streamName = "users";
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });

    const msgSchema = dataMoveSingleStreamRecordMessageSchema(
      streamName,
      schema,
    );

    const input = {
      protocol: "singer" as const,
      type: "RECORD" as const,
      stream: "users" as const,
      record: { id: 1, name: "Mary" },
      timeExtracted: new Date("2020-01-01T00:00:00.000Z"),
    };

    const typed = msgSchema.parse(input);
    assertEquals(typed.record.id, 1);
    assertEquals(typed.record.name, "Mary");
  });
});

/* -------------------------------------------------------------------------- */
/*            Synthetic tap + target – DataMove Engine pipeline tests         */
/* -------------------------------------------------------------------------- */

Deno.test("DataMove Engine pipelines with synthetic tap/target", async (t) => {
  const userSchema = z.object({
    id: z.number(),
    name: z.string(),
  });

  const userSchemas = dataMoveSingleStreamMap("users", userSchema);
  type UserSchemas = typeof userSchemas;
  type UserState = { offset: number };

  const userStreamDef: DataMoveStreamDef<UserSchemas, "users"> =
    dataMoveSingleStreamDef("users", userSchemas.users, {
      keyProperties: ["id"],
    });

  function makeSyntheticUserTap(
    records: { id: number; name: string }[],
  ): DataMoveTap<UserSchemas, UserState> {
    return {
      id: "synthetic-users-tap",
      streams: {
        users: userStreamDef,
      },
      async *read(
        ctx: DataMoveTapContext<UserState>,
      ): AsyncIterable<DataMoveTypedMessage<UserSchemas, UserState>> {
        const schemaMsg: DataMoveTypedSchemaMessage<UserSchemas> = {
          protocol: "singer",
          type: "SCHEMA",
          stream: userStreamDef,
        };
        yield schemaMsg;

        for (const rec of records) {
          const recordMsg: DataMoveTypedRecordMessage<
            UserSchemas,
            "users"
          > = {
            protocol: "singer",
            type: "RECORD",
            stream: "users",
            record: rec,
            timeExtracted: new Date("2020-01-01T00:00:00.000Z"),
          };
          yield recordMsg;
        }

        const initialOffset = ctx.state?.offset ?? 0;
        const finalState: DataMoveTypedStateMessage<UserState> = {
          protocol: "singer",
          type: "STATE",
          state: {
            offset: initialOffset + records.length,
          },
        };
        yield finalState;

        const barrierMsg = dmBarrierMessageSchema.parse({
          protocol: "data-move-protocol",
          nature: "BARRIER",
          barrierId: "end-of-batch",
        });
        yield barrierMsg;
      },
    };
  }

  class CollectingTarget implements DataMoveTarget<UserSchemas, UserState> {
    id = "collecting-target";
    initCalled = false;
    finalizeCalled = false;
    messages: DataMoveTypedMessage<UserSchemas, UserState>[] = [];

    init() {
      this.initCalled = true;
    }

    handleMessage(
      msg: DataMoveTypedMessage<UserSchemas, UserState>,
    ): void {
      this.messages.push(msg);
    }

    finalize() {
      this.finalizeCalled = true;
    }
  }

  await t.step("runs tap -> target without transforms", async () => {
    const tap = makeSyntheticUserTap([
      { id: 1, name: "Mary" },
      { id: 2, name: "John" },
    ]);

    const target = new CollectingTarget();
    let observedState: UserState | undefined;

    await dataMovementPipeline<UserSchemas, UserState>({
      tap,
      target,
      initialState: { offset: 0 },
      onState(state) {
        observedState = state;
      },
    });

    assert(target.initCalled);
    assert(target.finalizeCalled);

    // SCHEMA, RECORD, RECORD, STATE, BARRIER
    assertEquals(target.messages.length, 5);

    const last = target.messages[target.messages.length - 1];
    const lastAsBarrier = last as DataMoveSupersetMessage;
    assert(lastAsBarrier.nature === "BARRIER");
    assertEquals(lastAsBarrier.barrierId, "end-of-batch");

    assertEquals(observedState, { offset: 2 });
  });

  await t.step("applies transforms (filter + duplicate)", async () => {
    const tap = makeSyntheticUserTap([
      { id: 1, name: "Mary" },
      { id: 2, name: "John" },
    ]);

    const target = new CollectingTarget();

    const transforms: DataMoveMessageTransform<UserSchemas, UserState>[] = [
      {
        name: "filter-records-with-id-1",
        apply(msg) {
          const m = msg as {
            type?: string;
            record?: { id?: number };
          };
          if (m.type === "RECORD" && m.record?.id === 1) {
            return null;
          }
          return msg;
        },
      },
      {
        name: "duplicate-records-with-id-2",
        apply(msg) {
          const m = msg as {
            type?: string;
            record?: { id?: number };
          };
          if (m.type === "RECORD" && m.record?.id === 2) {
            return [msg, msg];
          }
          return msg;
        },
      },
    ];

    await dataMovementPipeline<UserSchemas, UserState>({
      tap,
      target,
      transforms,
      initialState: { offset: 0 },
    });

    const recordMessages = target.messages.filter((m) =>
      (m as { type?: string }).type === "RECORD"
    ) as DataMoveTypedRecordMessage<UserSchemas, "users">[];

    assertEquals(recordMessages.length, 2);
    for (const m of recordMessages) {
      assertEquals(m.record.id, 2);
    }
  });

  await t.step("handles target errors and logs", async () => {
    const tap = makeSyntheticUserTap([
      { id: 1, name: "Mary" },
    ]);

    class FailingTarget implements DataMoveTarget<UserSchemas, UserState> {
      id = "failing-target";
      handleMessage(): void {
        throw new Error("intentional failure");
      }
    }

    const target = new FailingTarget();
    const errors: unknown[] = [];

    const logger: Pick<
      typeof console,
      "debug" | "info" | "warn" | "error"
    > = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    };

    await assertRejects(
      () =>
        dataMovementPipeline<UserSchemas, UserState>({
          tap,
          target,
          initialState: { offset: 0 },
          logger,
        }),
      Error,
      "intentional failure",
    );

    assert(errors.length > 0);
  });
});

/* -------------------------------------------------------------------------- */
/*                      Superset diagnostics message tests                    */
/* -------------------------------------------------------------------------- */

Deno.test("DataMove superset diagnostics messages validate", async (t) => {
  await t.step("TRACE message", () => {
    const msg: DataMoveSupersetMessage = {
      protocol: "data-move-protocol",
      nature: "TRACE",
      message: "debug trace",
      level: "debug",
      stream: "users",
      ts: new Date().toISOString(),
    };
    const parsed = dataMoveMessageSchema.parse(msg);
    if (parsed.nature === "TRACE") {
      assertEquals(parsed.message, "debug trace");
      assertEquals(parsed.level, "debug");
    } else {
      throw new Error("Expected TRACE nature");
    }
  });

  await t.step("ERROR message", () => {
    const msg: DataMoveSupersetMessage = {
      protocol: "data-move-protocol",
      nature: "ERROR",
      error: "something went wrong",
      details: { code: "E_TEST" },
    };
    const parsed = dataMoveMessageSchema.parse(msg);
    if (parsed.nature === "ERROR") {
      assertEquals(parsed.error, "something went wrong");
      assertEquals(
        (parsed.details as { code: string }).code,
        "E_TEST",
      );
    } else {
      throw new Error("Expected ERROR nature");
    }
  });

  await t.step("BARRIER message", () => {
    const msg: DataMoveSupersetMessage = {
      protocol: "data-move-protocol",
      nature: "BARRIER",
      barrierId: "checkpoint-1",
    };
    const parsed = dataMoveMessageSchema.parse(msg);
    if (parsed.nature === "BARRIER") {
      assertEquals(parsed.barrierId, "checkpoint-1");
    } else {
      throw new Error("Expected BARRIER nature");
    }
  });

  await t.step("METRICS message", () => {
    const msg: DataMoveSupersetMessage = {
      protocol: "data-move-protocol",
      nature: "METRICS",
      metrics: {
        rows_processed: 100,
        streams: 1,
      },
    };
    const parsed = dataMoveMessageSchema.parse(msg);
    if (parsed.nature === "METRICS") {
      assertEquals(parsed.metrics.rows_processed, 100);
      assertEquals(parsed.metrics.streams, 1);
    } else {
      throw new Error("Expected METRICS nature");
    }
  });
});

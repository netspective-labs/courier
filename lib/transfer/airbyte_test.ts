// lib/transfer/airbyte_test.ts
//
// Tests for the Courier Airbyte data movement profile and transforms.

import { z } from "@zod";
import { assert, assertEquals } from "@std/assert";

import {
  type AirbyteLogMessage,
  airbyteLogMessageSchema,
  type AirbyteRecordMessage,
  airbyteRecordMessageSchema,
  type AirbyteStateMessage,
  airbyteStateMessageSchema,
  airbyteWireMessageSchema,
  dataMoveSingleStreamRecordToAirbyteRecordSchema,
  dataMoveStateToAirbyteStateSchema,
  dataMoveTypedRecordToAirbyteRecordSchema,
  dataMoveTypedStateToAirbyteStateSchema,
} from "./airbyte.ts";

import {
  type DataMoveTypedRecordMessage,
  type DataMoveTypedStateMessage,
} from "./protocol.ts";

/* -------------------------------------------------------------------------- */
/*                        Airbyte wire message schemas                        */
/* -------------------------------------------------------------------------- */

Deno.test("Airbyte wire message schemas", async (t) => {
  await t.step("RECORD message example", () => {
    const msg: AirbyteRecordMessage = {
      type: "RECORD",
      record: {
        stream: "users",
        data: {
          id: 1,
          name: "Mary",
        },
        emitted_at: 1_609_459_200_000, // 2020-12-31T00:00:00Z
      },
    };

    const parsed = airbyteRecordMessageSchema.parse(msg);
    assertEquals(parsed.record.stream, "users");
    assertEquals(parsed.record.data.id, 1);

    const unionParsed = airbyteWireMessageSchema.parse(msg);
    assertEquals(unionParsed.type, "RECORD");
  });

  await t.step("STATE message example", () => {
    const msg: AirbyteStateMessage = {
      type: "STATE",
      state: {
        data: {
          cursor: 42,
          lastSync: "2020-01-01T00:00:00Z",
        },
      },
    };

    const parsed = airbyteStateMessageSchema.parse(msg);
    assertEquals(parsed.state.data.cursor, 42);

    const unionParsed = airbyteWireMessageSchema.parse(msg);
    assertEquals(unionParsed.type, "STATE");
  });

  await t.step("LOG message example", () => {
    const msg: AirbyteLogMessage = {
      type: "LOG",
      log: {
        level: "INFO",
        message: "sync started",
      },
    };

    const parsed = airbyteLogMessageSchema.parse(msg);
    assertEquals(parsed.log.level, "INFO");
    assertEquals(parsed.log.message, "sync started");

    const unionParsed = airbyteWireMessageSchema.parse(msg);
    assertEquals(unionParsed.type, "LOG");
  });

  await t.step("Unified union accepts multiple message types", () => {
    const recordMsg: AirbyteRecordMessage = {
      type: "RECORD",
      record: {
        stream: "orders",
        data: { id: 10 },
      },
    };

    const stateMsg: AirbyteStateMessage = {
      type: "STATE",
      state: {
        data: { cursor: 99 },
      },
    };

    const parsedRecord = airbyteWireMessageSchema.parse(recordMsg);
    const parsedState = airbyteWireMessageSchema.parse(stateMsg);

    assertEquals(parsedRecord.type, "RECORD");
    assertEquals(parsedState.type, "STATE");
  });
});

/* -------------------------------------------------------------------------- */
/*                    DataMove typed -> Airbyte transforms                    */
/* -------------------------------------------------------------------------- */

Deno.test("DataMove typed -> Airbyte transforms", async (t) => {
  const userSchema = z.object({
    id: z.number(),
    name: z.string(),
  });

  const schemas = {
    users: userSchema,
  } as const;

  type UserSchemas = typeof schemas;
  type UserState = {
    cursor: number;
    lastSync: string;
  };

  await t.step("dataMoveTypedRecordToAirbyteRecordSchema", () => {
    const typedRecord: DataMoveTypedRecordMessage<UserSchemas, "users"> = {
      protocol: "airbyte",
      type: "RECORD",
      stream: "users",
      record: {
        id: 1,
        name: "Mary",
      },
      timeExtracted: new Date("2020-01-01T00:00:00.000Z"),
    };

    const transform = dataMoveTypedRecordToAirbyteRecordSchema<
      UserSchemas,
      "users"
    >(
      "users",
      schemas.users,
    );

    const airbyteRecord = transform.parse(typedRecord);
    assertEquals(airbyteRecord.type, "RECORD");
    assertEquals(airbyteRecord.record.stream, "users");
    assertEquals(airbyteRecord.record.data.id, 1);
    assertEquals(
      airbyteRecord.record.emitted_at,
      typedRecord.timeExtracted?.getTime(),
    );
  });

  await t.step("dataMoveTypedStateToAirbyteStateSchema", () => {
    const typedState: DataMoveTypedStateMessage<UserState> = {
      protocol: "airbyte",
      type: "STATE",
      state: {
        cursor: 5,
        lastSync: "2020-01-01T00:00:00Z",
      },
    };

    const transform = dataMoveTypedStateToAirbyteStateSchema<UserState>();

    const airbyteState = transform.parse(typedState);
    assertEquals(airbyteState.type, "STATE");
    assertEquals(airbyteState.state.data.cursor, 5);
    assertEquals(
      airbyteState.state.data.lastSync,
      "2020-01-01T00:00:00Z",
    );
  });

  await t.step(
    "dataMoveSingleStreamRecordToAirbyteRecordSchema helper",
    () => {
      const typedRecord: DataMoveTypedRecordMessage<UserSchemas, "users"> = {
        protocol: "airbyte",
        type: "RECORD",
        stream: "users",
        record: {
          id: 2,
          name: "John",
        },
        timeExtracted: new Date("2021-01-01T00:00:00.000Z"),
      };

      const transform = dataMoveSingleStreamRecordToAirbyteRecordSchema(
        "users",
        userSchema,
      );

      const airbyteRecord = transform.parse(typedRecord);
      assertEquals(airbyteRecord.type, "RECORD");
      assertEquals(airbyteRecord.record.stream, "users");
      assertEquals(airbyteRecord.record.data.name, "John");
      assertEquals(
        airbyteRecord.record.emitted_at,
        typedRecord.timeExtracted?.getTime(),
      );
    },
  );

  await t.step(
    "dataMoveStateToAirbyteStateSchema helper",
    () => {
      const typedState: DataMoveTypedStateMessage<UserState> = {
        protocol: "airbyte",
        type: "STATE",
        state: {
          cursor: 10,
          lastSync: "2021-02-02T00:00:00Z",
        },
      };

      const transform = dataMoveStateToAirbyteStateSchema<UserState>();

      const airbyteState = transform.parse(typedState);
      assertEquals(airbyteState.type, "STATE");
      assertEquals(airbyteState.state.data.cursor, 10);
      assertEquals(
        airbyteState.state.data.lastSync,
        "2021-02-02T00:00:00Z",
      );
    },
  );

  await t.step("produced messages validate against Airbyte union", () => {
    const typedRecord: DataMoveTypedRecordMessage<UserSchemas, "users"> = {
      protocol: "airbyte",
      type: "RECORD",
      stream: "users",
      record: {
        id: 3,
        name: "Alice",
      },
    };

    const recordTransform = dataMoveSingleStreamRecordToAirbyteRecordSchema(
      "users",
      userSchema,
    );
    const airbyteRecord = recordTransform.parse(typedRecord);

    const stateTyped: DataMoveTypedStateMessage<UserState> = {
      protocol: "airbyte",
      type: "STATE",
      state: {
        cursor: 20,
        lastSync: "2022-01-01T00:00:00Z",
      },
    };

    const stateTransform = dataMoveStateToAirbyteStateSchema<UserState>();
    const airbyteState = stateTransform.parse(stateTyped);

    const unionRecord = airbyteWireMessageSchema.parse(airbyteRecord);
    const unionState = airbyteWireMessageSchema.parse(airbyteState);

    assert(unionRecord.type === "RECORD");
    assert(unionState.type === "STATE");
    assert(unionRecord.record.data.id === 3);
    assert(unionState.state.data.cursor === 20);
  });
});

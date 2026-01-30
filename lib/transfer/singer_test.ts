// lib/transfer/singer_test.ts
//
// Tests for Courier Data Movement Protocol (DataMP) Singer profile.

import { assertEquals } from "@std/assert";
import { z } from "@zod";

import {
  dataMoveSingleStreamMap,
  dataMoveSingleStreamRecordMessageSchema,
  type DataMoveTypedRecordMessage,
  dataMoveTypedRecordMessageSchema,
  type DataMoveTypedStateMessage,
  dataMoveTypedStateMessageSchema,
} from "./protocol.ts";

import {
  dataMoveSingerSchemaWireFromMetaSchema,
  dataMoveSingleStreamRecordToSingerWireSchema,
  dataMoveTypedRecordToSingerRecordWireSchema,
  dataMoveTypedStateToSingerStateWireSchema,
  dataMoveWireMessageSchema,
  singerActivateVersionWireSchema,
  type SingerRecordWire,
  singerRecordWireSchema,
  type SingerSchemaWire,
  singerSchemaWireSchema,
  type SingerStateWire,
  singerStateWireSchema,
  singerWireMessageSchema,
} from "./singer.ts";

/* -------------------------------------------------------------------------- */
/*                  Singer wire messages – canonical examples                 */
/* -------------------------------------------------------------------------- */

Deno.test("Singer wire message schemas validate canonical examples", async (t) => {
  await t.step("SCHEMA message example", () => {
    const msg: SingerSchemaWire = {
      type: "SCHEMA",
      stream: "users",
      schema: {
        properties: {
          id: { type: ["null", "integer"] },
          name: { type: ["null", "string"] },
          age: { type: ["null", "integer"] },
        },
      },
      key_properties: ["id"],
      bookmark_properties: ["age"],
    };

    const parsed = singerSchemaWireSchema.parse(msg);
    assertEquals(parsed.stream, "users");

    const unionParsed = singerWireMessageSchema.parse(msg);
    assertEquals(unionParsed.type, "SCHEMA");
  });

  await t.step("RECORD message example", () => {
    const msg: SingerRecordWire = {
      type: "RECORD",
      stream: "users",
      record: {
        id: 1,
        name: "Mary",
        age: 30,
      },
      time_extracted: "2017-11-20T19:22:00Z",
      version: 2,
    };

    const parsed = singerRecordWireSchema.parse(msg);
    assertEquals(parsed.record.id, 1);

    const unionParsed = singerWireMessageSchema.parse(msg);
    assertEquals(unionParsed.type, "RECORD");
  });

  await t.step("STATE message example", () => {
    const msg: SingerStateWire = {
      type: "STATE",
      value: {
        last_update: "2017-11-20T19:23:00Z",
      },
    };

    const parsed = singerStateWireSchema.parse(msg);
    assertEquals(parsed.value.last_update, "2017-11-20T19:23:00Z");

    const unionParsed = singerWireMessageSchema.parse(msg);
    assertEquals(unionParsed.type, "STATE");
  });

  await t.step("ACTIVATE_VERSION message example", () => {
    const msg = {
      type: "ACTIVATE_VERSION" as const,
      stream: "users",
      version: 42,
    };

    const parsed = singerActivateVersionWireSchema.parse(msg);
    assertEquals(parsed.version, 42);

    const unionParsed = singerWireMessageSchema.parse(msg);
    assertEquals(unionParsed.type, "ACTIVATE_VERSION");
  });

  await t.step(
    "Unified DataMoveWireMessage union accepts Singer messages",
    () => {
      const recordMsg: SingerRecordWire = {
        type: "RECORD",
        stream: "users",
        record: { id: 1 },
      };

      const parsed = dataMoveWireMessageSchema.parse(recordMsg);

      const asRecord = parsed as SingerRecordWire;
      assertEquals(asRecord.stream, "users");
      assertEquals(asRecord.record.id, 1);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                  Typed <-> Singer transform schemas (Zod)                  */
/* -------------------------------------------------------------------------- */

Deno.test("Typed DataMove <-> Singer transform helpers", async (t) => {
  const userRecordSchema = z.object({
    id: z.number(),
    name: z.string(),
  });

  const userSchemas = dataMoveSingleStreamMap("users", userRecordSchema);
  type UserSchemas = typeof userSchemas;

  await t.step("dataMoveTypedRecordToSingerRecordWireSchema", () => {
    const typedRecordSchema = dataMoveTypedRecordMessageSchema<
      UserSchemas,
      "users"
    >("users", userSchemas.users);

    const input: DataMoveTypedRecordMessage<UserSchemas, "users"> = {
      protocol: "singer",
      type: "RECORD",
      stream: "users",
      record: { id: 1, name: "Mary" },
      timeExtracted: new Date("2020-01-01T00:00:00.000Z"),
    };

    const parsedTyped = typedRecordSchema.parse(input);
    assertEquals(parsedTyped.record.name, "Mary");

    const transformSchema = dataMoveTypedRecordToSingerRecordWireSchema<
      UserSchemas,
      "users"
    >("users", userSchemas.users);

    const singerRecord = transformSchema.parse(input);
    assertEquals(singerRecord.type, "RECORD");
    assertEquals(singerRecord.stream, "users");
    assertEquals(singerRecord.record.id, 1);
    assertEquals(
      singerRecord.time_extracted,
      "2020-01-01T00:00:00.000Z",
    );
  });

  await t.step("dataMoveTypedStateToSingerStateWireSchema", () => {
    type UserState = { last_update: string };

    const stateSchema = dataMoveTypedStateMessageSchema<UserState>();

    const input: DataMoveTypedStateMessage<UserState> = {
      protocol: "singer",
      type: "STATE",
      state: { last_update: "2020-01-01T00:00:00Z" },
    };

    const typed = stateSchema.parse(input);
    assertEquals(typed.state.last_update, "2020-01-01T00:00:00Z");

    const transformSchema = dataMoveTypedStateToSingerStateWireSchema<
      UserState
    >();

    const singerState = transformSchema.parse(input);
    assertEquals(singerState.type, "STATE");
    assertEquals(
      singerState.value.last_update,
      "2020-01-01T00:00:00Z",
    );
  });

  await t.step("dataMoveSingerSchemaWireFromMetaSchema", () => {
    const meta = {
      stream: "users",
      jsonSchema: {
        properties: {
          id: { type: ["null", "integer"] },
        },
      },
      keyProperties: ["id"],
      bookmarkProperties: ["updated_at"],
    };

    const singerSchema = dataMoveSingerSchemaWireFromMetaSchema.parse(meta);

    assertEquals(singerSchema.type, "SCHEMA");
    assertEquals(singerSchema.stream, "users");
    assertEquals(
      (singerSchema.schema as Record<string, unknown>).properties,
      meta.jsonSchema.properties,
    );
    assertEquals(singerSchema.key_properties, ["id"]);
  });
});

/* -------------------------------------------------------------------------- */
/*               Single-stream helper builder tests (Singer side)             */
/* -------------------------------------------------------------------------- */

Deno.test(
  "Single-stream DataMove helper builders – Singer transforms",
  async (t) => {
    const streamName = "users";
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });

    await t.step(
      "dataMoveSingleStreamRecordMessageSchema + dataMoveSingleStreamRecordToSingerWireSchema",
      () => {
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

        const transformSchema = dataMoveSingleStreamRecordToSingerWireSchema(
          streamName,
          schema,
        );

        const singerRecord = transformSchema.parse(input);
        assertEquals(singerRecord.type, "RECORD");
        assertEquals(singerRecord.stream, "users");
        assertEquals(singerRecord.record.name, "Mary");
        assertEquals(
          singerRecord.time_extracted,
          "2020-01-01T00:00:00.000Z",
        );
      },
    );
  },
);

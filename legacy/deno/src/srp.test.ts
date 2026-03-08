import { assert, assertEquals, assertFalse } from "@std/assert";
import { Buffer } from "node:buffer";

Deno.test("isValidPakeMessage validates required SRP fields", async () => {
  const { isValidPakeMessage, parsePakeMessageType } = await import("./srp.ts");

  const valid = {
    TID: "user@example.com",
    MSG: 2,
    A: "0001",
    s: "0002",
    B: "0003",
    PROTO: 1,
    VER: "1",
    ErrCode: "0",
  };

  const invalid = {
    TID: "",
    MSG: "bad",
    A: "0001",
    s: "0002",
    B: "0003",
    PROTO: 1,
  };

  assert(isValidPakeMessage(valid));
  assertFalse(isValidPakeMessage(invalid as Record<string, unknown>));
  assertEquals(parsePakeMessageType("3"), 3);
});

Deno.test("verifyHAMK uses constant-time compare semantics", async () => {
  const { SRPSession } = await import("./srp.ts");

  const session = SRPSession.new(true);
  const first = new Uint8Array([1, 2, 3, 4]);
  const second = new Uint8Array([1, 2, 3, 4]);
  const third = new Uint8Array([1, 2, 3, 5]);

  assert(session.verifyHAMK(Buffer.from(first), Buffer.from(second)));
  assertFalse(session.verifyHAMK(Buffer.from(first), Buffer.from(third)));
  assertFalse(
    session.verifyHAMK(Buffer.from(first), Buffer.from([1, 2, 3, 4, 5])),
  );
});

Deno.test("SRPSession encrypt and decrypt data payloads", async () => {
  const { SRPSession } = await import("./srp.ts");

  const session = SRPSession.new(true);
  session.updateWithValues({
    username: "alice",
    sharedKey: 0x0102030405060708090a0b0c0d0e0f1011n,
    salt: 12n,
    serverPublicKey: 13n,
  });

  const payload = {
    STATUS: 0,
    Entries: [{
      USR: "alice",
      sites: ["https://example.com/"],
      PWD: "super-secret",
    }],
  };

  const encrypted = await session.encrypt(payload);
  const decrypted = await session.decrypt(encrypted);
  assertEquals(JSON.parse(decrypted.toString("utf8")), payload);
});

Deno.test("verifyHAMK accepts matching HMAC values", async () => {
  const { SRPSession } = await import("./srp.ts");

  const session = SRPSession.new(true);
  session.updateWithValues({
    username: "alice",
    sharedKey: 0x01n,
    salt: 0x02n,
    serverPublicKey: 0x03n,
  });

  const proof = Buffer.from(await session.computeHMAC(Buffer.from([0, 1, 2])));
  const reproof = Buffer.from(
    await session.computeHMAC(Buffer.from([0, 1, 2])),
  );

  assert(session.verifyHAMK(proof, reproof));
});

Deno.test("parsePakeMessageType and parsePakeMessageCode reject malformed values", async () => {
  const {
    parsePakeMessageCode,
    parsePakeMessageType,
  } = await import("./srp.ts");

  assertFalse(Number.isInteger(parsePakeMessageType(["bad"])));
  assertFalse(Number.isInteger(parsePakeMessageCode("1,2")));
});

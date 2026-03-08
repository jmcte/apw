import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { Buffer } from "node:buffer";

import { createSocket, type RemoteInfo } from "./deps.ts";
import type { Capabilities } from "./types.ts";

const withTmpHome = async <T>(
  fn: (home: string) => Promise<T> | T,
): Promise<T> => {
  const originalHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir();
  Deno.env.set("HOME", home);
  try {
    return await fn(home);
  } finally {
    if (originalHome) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }
    await Deno.remove(home, { recursive: true });
  }
};

const startMockDaemon = (
  responder: (
    message: string,
    remote: { address: string; port: number },
  ) => Promise<Uint8Array>,
) => {
  const socket = createSocket("udp4");
  const ready = new Promise<number>((resolve, reject) => {
    socket.on("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      if (typeof address === "string") {
        reject(new Error("unexpected address"));
        return;
      }
      resolve(address.port);
    });
  });

  socket.on("message", async (msg, rinfo: RemoteInfo) => {
    const response = await responder(new TextDecoder().decode(msg), {
      address: rinfo.address,
      port: rinfo.port,
    });
    socket.send(response, rinfo.port, rinfo.address);
  });

  return {
    port: ready,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
};

const encodePayload = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

Deno.test("full encrypted data-plane workflow succeeds", async () => {
  await withTmpHome(async () => {
    const { MSGTypes, Command, Status, APWError } = await import("./const.ts");
    const { toBase64, writeConfig } = await import("./utils.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    const context: {
      client?: {
        session: {
          computeHMAC: (value: Buffer) => Promise<Buffer>;
          deserialize: (value: string) => Buffer;
          serialize: (value: Buffer, prefix?: boolean) => string;
        };
      };
    } = {};
    const daemon = startMockDaemon(async (message) => {
      const parsed = JSON.parse(message);

      if (parsed.msg?.PAKE) {
        const raw = JSON.parse(
          Buffer.from(parsed.msg.PAKE, "base64").toString("utf8"),
        );

        if (raw.MSG === MSGTypes.CLIENT_KEY_EXCHANGE) {
          const response = {
            TID: raw.TID,
            MSG: MSGTypes.SERVER_KEY_EXCHANGE,
            A: "AQ==",
            s: "Ag==",
            B: "Aw==",
            PROTO: [1],
            VER: "1.0",
            ErrCode: 0,
          };
          return encodePayload({
            ok: true,
            code: Status.SUCCESS,
            payload: {
              PAKE: toBase64(response),
            },
          });
        }

        const currentClient = context.client;
        if (!currentClient || raw.MSG !== MSGTypes.CLIENT_VERIFICATION) {
          throw new APWError(Status.GENERIC_ERROR, "unexpected client message");
        }

        const verification = await currentClient.session.computeHMAC(
          currentClient.session.deserialize(raw.M),
        );
        const response = {
          TID: raw.TID,
          MSG: MSGTypes.SERVER_VERIFICATION,
          HAMK: currentClient.session.serialize(verification),
          PROTO: 1,
          ErrCode: 0,
          VER: "1.0",
          A: "AA==",
          s: "Ag==",
          B: "Aw==",
        };
        return encodePayload({
          ok: true,
          code: Status.SUCCESS,
          payload: {
            PAKE: toBase64(response),
          },
        });
      }

      if (parsed.cmd === Command.GET_CAPABILITIES) {
        return encodePayload({
          ok: true,
          code: Status.SUCCESS,
          payload: {
            canFillOneTimeCodes: true,
            scanForOTPURI: false,
          },
        });
      }

      if (!context.client) {
        throw new APWError(Status.GENERIC_ERROR, "missing client context");
      }

      const responsePayload = (() => {
        switch (parsed.cmd) {
          case Command.GET_LOGIN_NAMES_FOR_URL:
            return {
              STATUS: Status.SUCCESS,
              Entries: [{
                USR: "alice",
                sites: ["https://example.com/"],
                PWD: "password",
              }],
            };
          case Command.GET_PASSWORD_FOR_LOGIN_NAME:
            return {
              STATUS: Status.SUCCESS,
              Entries: [{
                USR: "alice",
                sites: ["https://example.com/"],
                PWD: "hunter2",
              }],
            };
          case Command.DID_FILL_ONE_TIME_CODE:
          case Command.GET_ONE_TIME_CODES:
            return {
              STATUS: Status.SUCCESS,
              Entries: [{
                code: "111111",
                username: "alice",
                source: "totp",
                domain: "example.com",
              }],
            };
          default:
            return {
              STATUS: Status.NO_RESULTS,
              Entries: [],
            };
        }
      })();

      const encrypted = await client.session.encrypt(responsePayload);
      return encodePayload({
        ok: true,
        code: Status.SUCCESS,
        payload: {
          SMSG: {
            TID: client.session.username,
            SDATA: client.session.serialize(encrypted),
          },
        },
      });
    });

    const port = await daemon.port;
    await writeConfig({
      username: "alice",
      sharedKey: 0x0102030405060708090a0b0c0d0e0f1011n,
      port,
      host: "127.0.0.1",
    });

    const client = new ApplePasswordManager();
    context.client = client;
    await client.requestChallenge();
    await client.verifyChallenge("123456");

    const capabilities = await client.getCapabilities() as Capabilities;
    assertEquals(capabilities.canFillOneTimeCodes, true);

    const loginNames = await client.getLoginNamesForURL("https://example.com/");
    assertEquals(loginNames.STATUS, Status.SUCCESS);
    assertEquals(loginNames.Entries[0].USR, "alice");

    const password = await client.getPasswordForURL(
      "https://example.com/",
      "alice",
    );
    assertEquals(password.STATUS, Status.SUCCESS);
    assertEquals(password.Entries[0].PWD, "hunter2");

    const otp = await client.getOTPForURL("example.com");
    assertEquals(otp.STATUS, Status.SUCCESS);
    assertEquals(otp.Entries[0].code, "111111");

    const otpList = await client.listOTPForURL("example.com");
    assertEquals(otpList.STATUS, Status.SUCCESS);

    await daemon.close();
  });
});

Deno.test("decryptPayload rejects malformed SMSG JSON response", async () => {
  await withTmpHome(async () => {
    const { APWError, Status } = await import("./const.ts");
    const { writeConfig } = await import("./utils.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    await writeConfig({
      username: "alice",
      sharedKey: 0x0102030405060708090a0b0c0d0e0f1011n,
      port: 1234,
      host: "127.0.0.1",
    });

    const client = new ApplePasswordManager();
    const broken = { SMSG: "{bad-json" };

    const error = await assertRejects(() =>
      client.decryptPayload(broken as never)
    );
    assertInstanceOf(error, APWError);
    assertEquals(error.code, Status.PROTO_INVALID_RESPONSE);
  });
});

Deno.test("decryptPayload rejects session-mismatched encrypted responses", async () => {
  await withTmpHome(async () => {
    const { APWError, Status } = await import("./const.ts");
    const { writeConfig } = await import("./utils.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    await writeConfig({
      username: "alice",
      sharedKey: 0x0102030405060708090a0b0c0d0e0f1011n,
      port: 1234,
      host: "127.0.0.1",
    });

    const client = new ApplePasswordManager();
    const encrypted = await client.session.encrypt({
      STATUS: Status.SUCCESS,
      Entries: [{ dummy: "value" }],
    });
    const payload = {
      SMSG: {
        TID: "eve",
        SDATA: client.session.serialize(encrypted),
      },
    };

    const error = await assertRejects(() =>
      client.decryptPayload(payload as never)
    );
    assertInstanceOf(error, APWError);
    assertEquals(error.code, Status.INVALID_SESSION);
  });
});

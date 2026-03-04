import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import { Buffer, createSocket } from "./deps.ts";

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
  ) => Uint8Array | undefined | Promise<Uint8Array | undefined>,
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

  socket.on("message", async (msg, rinfo) => {
    const response = await responder(new TextDecoder().decode(msg), rinfo);
    if (!response) return;
    socket.send(response, rinfo.port, rinfo.address);
  });

  return {
    socket,
    port: ready,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
};

Deno.test("sendMessage parses helper envelope payload", async () => {
  await withTmpHome(async () => {
    const { writeConfig } = await import("./utils.ts");
    const { ApplePasswordManager } = await import("./client.ts");
    const { Status } = await import("./const.ts");

    const daemon = startMockDaemon(() => {
      return new TextEncoder().encode(
        JSON.stringify({
          ok: true,
          code: 0,
          payload: {
            STATUS: Status.SUCCESS,
            Entries: [],
          },
        }),
      );
    });
    const port = await daemon.port;
    await writeConfig({
      username: "alice",
      sharedKey: 42n,
      port,
      host: "127.0.0.1",
    });
    const client = new ApplePasswordManager();
    const payload = await client.sendMessage({ cmd: 0 });
    assertEquals((payload as { STATUS?: number }).STATUS, Status.SUCCESS);
    await daemon.close();
  });
});

Deno.test("sendMessage maps malformed response JSON to protocol error", async () => {
  await withTmpHome(async () => {
    const { writeConfig } = await import("./utils.ts");
    const { APWError } = await import("./const.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    const daemon = startMockDaemon(() => new TextEncoder().encode("not-json"));
    const port = await daemon.port;
    await writeConfig({
      username: "alice",
      sharedKey: 42n,
      port,
      host: "127.0.0.1",
    });
    const client = new ApplePasswordManager();

    await assertRejects(
      () => client.sendMessage({ cmd: 0 }, { timeoutMs: 500 }),
      APWError,
    );
    await daemon.close();
  });
});

Deno.test("sendMessage accepts legacy payload", async () => {
  await withTmpHome(async () => {
    const { writeConfig } = await import("./utils.ts");
    const { Status } = await import("./const.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    const daemon = startMockDaemon(() => {
      return new TextEncoder().encode(
        JSON.stringify({
          STATUS: Status.SUCCESS,
          Entries: [],
        }),
      );
    });
    const port = await daemon.port;
    await writeConfig({
      username: "alice",
      sharedKey: 42n,
      port,
      host: "127.0.0.1",
    });
    const client = new ApplePasswordManager();
    const payload = await client.sendMessage({ cmd: 0 });
    assertEquals((payload as { STATUS?: number }).STATUS, Status.SUCCESS);
    await daemon.close();
  });
});

Deno.test("sendMessage maps envelope error responses", async () => {
  await withTmpHome(async () => {
    const { APWError, Status } = await import("./const.ts");
    const { writeConfig } = await import("./utils.ts");
    const { ApplePasswordManager } = await import("./client.ts");
    const daemon = startMockDaemon(() => {
      return new TextEncoder().encode(
        JSON.stringify({
          ok: false,
          code: Status.INVALID_SESSION,
          error: "bad",
        }),
      );
    });
    const port = await daemon.port;
    await writeConfig({
      username: "alice",
      sharedKey: 42n,
      port,
      host: "127.0.0.1",
    });
    const client = new ApplePasswordManager();
    const error = await assertRejects(() => client.sendMessage({ cmd: 0 }));
    await daemon.close();
    assert(error instanceof APWError);
    assertEquals(error.code, Status.INVALID_SESSION);
  });
});

Deno.test("sendMessage retries on timeout and eventually succeeds", async () => {
  await withTmpHome(async () => {
    const { Status } = await import("./const.ts");
    const { writeConfig } = await import("./utils.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    let attempts = 0;
    const daemon = startMockDaemon((_message) => {
      attempts += 1;
      if (attempts === 1) {
        return undefined;
      }
      return new TextEncoder().encode(
        JSON.stringify({
          ok: true,
          code: Status.SUCCESS,
          payload: {
            STATUS: Status.SUCCESS,
            Entries: [],
          },
        }),
      );
    });
    const port = await daemon.port;
    await writeConfig({
      username: "alice",
      sharedKey: 42n,
      port,
      host: "127.0.0.1",
    });
    const client = new ApplePasswordManager();
    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
      const payload = await client.sendMessage({ cmd: 0 }, {
        timeoutMs: 50,
        retries: 1,
      });
      assertEquals(attempts, 2);
      assertEquals((payload as { STATUS?: number }).STATUS, Status.SUCCESS);
    } finally {
      Math.random = originalRandom;
      await daemon.close();
    }
  });
});

Deno.test("sendMessage rejects oversized request payloads", async () => {
  await withTmpHome(async () => {
    const { writeConfig } = await import("./utils.ts");
    const { APWError } = await import("./const.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    await writeConfig({
      username: "alice",
      sharedKey: 42n,
      port: 9999,
      host: "127.0.0.1",
    });
    const client = new ApplePasswordManager();

    const oversized = "x".repeat(17_000);
    const error = await assertRejects(() =>
      client.sendMessage({
        cmd: 0,
        payload: oversized,
      })
    );
    assert(error instanceof APWError);
  });
});

Deno.test("ensureAuthenticated enforces session prerequisites", async () => {
  await withTmpHome(async () => {
    const { clearConfig, writeConfig } = await import("./utils.ts");
    const { APWError } = await import("./const.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    clearConfig();
    const unauthenticated = new ApplePasswordManager();
    assertThrows(() => {
      unauthenticated.ensureAuthenticated();
    }, APWError);

    await writeConfig({
      username: "alice",
      sharedKey: 42n,
      port: 1234,
      host: "127.0.0.1",
    });
    const client = new ApplePasswordManager();
    const cfg = client.ensureAuthenticated({ maxAgeMs: 60_000 });
    assertEquals(cfg.username, "alice");
    assertEquals(cfg.port, 1234);
    assertEquals(cfg.host, "127.0.0.1");
    assertEquals(cfg.sharedKey > 0n, true);
    assertEquals(cfg.createdAt.length > 0, true);
  });
});

Deno.test("requestChallenge and verifyChallenge complete session flow", async () => {
  await withTmpHome(async () => {
    const {
      APWError,
      MSGTypes,
      Status,
    } = await import("./const.ts");
    const { toBase64 } = await import("./utils.ts");
    const { ApplePasswordManager } = await import("./client.ts");

    let client: {
      requestChallenge: () => Promise<unknown>;
      verifyChallenge: (pin: string) => Promise<unknown>;
      session: {
        computeHMAC: (value: Buffer) => Promise<Buffer>;
        deserialize: (value: string) => Buffer;
        serialize: (value: Buffer, prefix?: boolean) => string;
      };
    } | null = null;
    const daemon = startMockDaemon(async (message) => {
      const parsed = JSON.parse(message);
      const raw = JSON.parse(Buffer.from(parsed.msg.PAKE, "base64").toString());

      if (raw.MSG === MSGTypes.CLIENT_KEY_EXCHANGE) {
        return new TextEncoder().encode(
          JSON.stringify({
            ok: true,
            code: Status.SUCCESS,
            payload: {
              PAKE: toBase64({
                TID: raw.TID,
                MSG: MSGTypes.SERVER_KEY_EXCHANGE,
                A: "0x01",
                s: "0x0200",
                B: "0x0300",
                PROTO: 1,
                VER: "1.0",
                ErrCode: 0,
              }),
            },
          }),
        );
      }

      const verification = await (async () => {
        const incoming = client;
        if (!incoming) {
          throw new APWError(Status.GENERIC_ERROR, "client missing");
        }
        const expected = await incoming.session.computeHMAC(
          incoming.session.deserialize(raw.M),
        );
        return {
          PAKE: toBase64({
            TID: raw.TID,
            MSG: MSGTypes.SERVER_VERIFICATION,
            A: "0x01",
            s: "0x0200",
            B: "0x0300",
            PROTO: 1,
            HAMK: incoming.session.serialize(expected),
            ErrCode: 0,
            VER: "1",
          }),
        };
      })();

      return new TextEncoder().encode(
        JSON.stringify({
          ok: true,
          code: Status.SUCCESS,
          payload: verification,
        }),
      );
    });

    const port = await daemon.port;
    const { writeConfig, readConfig } = await import("./utils.ts");
    await writeConfig({
      username: "alice",
      sharedKey: 1n,
      port,
      host: "127.0.0.1",
    });

    client = new ApplePasswordManager();
    await client.requestChallenge();
    await client.verifyChallenge("123456");
    const cfg = readConfig({ requireAuth: true });
    assertEquals(cfg.username, "alice");
    assertEquals(cfg.port, port);
    assertEquals(cfg.sharedKey > 1n, true);

    await daemon.close();
  });
});

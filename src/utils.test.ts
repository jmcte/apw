import { assert, assertEquals, assertThrows } from "@std/assert";
import { Buffer } from "node:buffer";

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

Deno.test("readConfig migrates legacy config and strips stale data", async () => {
  await withTmpHome(async () => {
    const {
      DEFAULT_HOST,
      SESSION_MAX_AGE_MS,
      readBigInt,
      readConfig,
      readConfigOrNull,
      writeConfig,
    } = await import("./utils.ts");
    const { APWError } = await import("./const.ts");

    const configPath = `${Deno.env.get("HOME")}/.apw/config.json`;
    const sharedKey = Buffer.from([0x01, 0x02, 0x03]).toString("base64");
    const legacy = {
      port: 4242,
      username: "alice",
      sharedKey,
    };
    await Deno.mkdir(`${Deno.env.get("HOME")}/.apw`, { recursive: true });
    await Deno.writeTextFile(configPath, JSON.stringify(legacy));

    const migrated = readConfig();
    assertEquals(migrated.schema, 1);
    assertEquals(migrated.port, 4242);
    assertEquals(migrated.host, DEFAULT_HOST);
    assertEquals(migrated.username, "alice");
    assertEquals(
      migrated.sharedKey,
      readBigInt(Buffer.from(sharedKey, "base64")),
    );
    assert(migrated.createdAt.length > 0);

    Deno.removeSync(configPath);
    const written = writeConfig({
      username: "alice",
      sharedKey: 42n,
      host: "127.0.0.1",
      port: 5005,
    });
    const stored = readConfigOrNull();
    assert(stored !== null && stored.host === "127.0.0.1");
    assertEquals(stored.username, "alice");

    const stale = {
      schema: 1,
      port: 443,
      host: "127.0.0.1",
      username: "alice",
      sharedKey: written.sharedKey,
      createdAt: new Date(Date.now() - (SESSION_MAX_AGE_MS + 1000))
        .toISOString(),
    };
    await Deno.writeTextFile(configPath, JSON.stringify(stale));

    const defaultConfig = readConfig();
    assertEquals(defaultConfig.username, "alice");
    assertEquals(
      defaultConfig.sharedKey,
      readBigInt(Buffer.from(written.sharedKey, "base64")),
    );
    assertEquals(defaultConfig.port, 443);
    assertEquals(defaultConfig.host, "127.0.0.1");
    assertEquals(readConfigOrNull(), null);

    assertThrows(
      () => readConfig({ requireAuth: true, maxAgeMs: SESSION_MAX_AGE_MS }),
      APWError,
    );
  });
});

Deno.test("writeConfig persists secure permissions", async () => {
  await withTmpHome(async () => {
    const { writeConfig, readConfig } = await import("./utils.ts");

    const updated = writeConfig({
      username: "alice",
      sharedKey: 123456789n,
      port: 5005,
      host: "127.0.0.1",
    });

    assertEquals(updated.host, "127.0.0.1");
    assertEquals(updated.port, 5005);
    assertEquals(updated.username, "alice");

    const configStat = Deno.statSync(
      `${Deno.env.get("HOME")}/.apw/config.json`,
    );
    const dirStat = Deno.statSync(`${Deno.env.get("HOME")}/.apw`);

    assertEquals(configStat.mode! & 0o777, 0o600);
    assertEquals(dirStat.mode! & 0o777, 0o700);

    const config = readConfig();
    assertEquals(config.host, "127.0.0.1");
    assertEquals(config.port, 5005);
  });
});

Deno.test("writeConfig rejects incomplete auth payload", async () => {
  await withTmpHome(async () => {
    const { APWError } = await import("./const.ts");
    const { writeConfig } = await import("./utils.ts");

    assertThrows(() => {
      writeConfig({ username: "", sharedKey: 0n });
    }, APWError);
    assertThrows(() => {
      writeConfig({ port: 123 });
    }, APWError);
  });
});

Deno.test("read/write helpers handle bigint conversion", async () => {
  await withTmpHome(async () => {
    const { readBigInt, readConfig, toBuffer, writeConfig } = await import(
      "./utils.ts"
    );
    const sessionKey = 0x1a2b3c4dn;
    await writeConfig({
      username: "alice",
      sharedKey: sessionKey,
      host: "127.0.0.1",
      port: 1234,
    });
    const config = readConfig({ requireAuth: true });
    assertEquals(config.sharedKey, sessionKey);
    assertEquals(readBigInt(toBuffer(sessionKey)), sessionKey);
  });
});

Deno.test("toBuffer and pad support core utility inputs", async () => {
  await withTmpHome(async () => {
    const { pad, powermod, mod, randomBytes, toBuffer } = await import(
      "./utils.ts"
    );

    assertEquals(toBuffer(true).toJSON().data, [1]);
    assertEquals(toBuffer(false).toJSON().data, [0]);
    assertEquals(toBuffer(255n).toJSON().data, [255]);
    assertEquals(pad(Buffer.from([0x01, 0x02]), 4).toJSON().data, [
      0,
      0,
      1,
      2,
    ]);
    assertEquals(randomBytes(8).length, 8);
    assertEquals(mod(-5n, 7n), 2n);
    assertEquals(powermod(2n, 5n, 13n), 6n);
  });
});

Deno.test("writeConfig rejects malformed payload and clears broken file", async () => {
  await withTmpHome(async () => {
    const { APWError } = await import("./const.ts");
    const { clearConfig, readConfig } = await import("./utils.ts");
    const path = `${Deno.env.get("HOME")}/.apw/config.json`;

    clearConfig();
    await Deno.mkdir(`${Deno.env.get("HOME")}/.apw`, { recursive: true });
    await Deno.writeTextFile(path, "{bad-json");

    assertThrows(() => readConfig({ requireAuth: true }), APWError);
  });
});

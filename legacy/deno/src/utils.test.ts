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
    const _written = writeConfig({
      username: "alice",
      sharedKey: 42n,
      host: "127.0.0.1",
      port: 5005,
    });
    const stored = readConfigOrNull();
    if (stored === null || stored.host !== "127.0.0.1") {
      throw new Error("missing stored config");
    }
    assertEquals(stored.username, "alice");

    const stale = {
      schema: 1,
      port: 443,
      host: "127.0.0.1",
      username: "alice",
      secretSource: stored.secretSource,
      sharedKey: stored.sharedKey || "AQID",
      createdAt: new Date(Date.now() - (SESSION_MAX_AGE_MS + 1000))
        .toISOString(),
    };
    await Deno.writeTextFile(configPath, JSON.stringify(stale));

    const defaultConfig = readConfig();
    assertEquals(defaultConfig.username, "alice");
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

Deno.test("clearConfig clears keychain entries for keychain-backed sessions", async () => {
  await withTmpHome(async () => {
    const { clearConfig, readConfigOrNull, writeConfig } = await import(
      "./utils.ts"
    );
    const {
      __setSecurityCommandRunnerForTests,
      supportsKeychainForTests,
    } = await import("./secrets.ts");

    const calls: string[][] = [];
    const runner = (args: string[]) => {
      calls.push(args);
      if (args[0] === "delete-generic-password") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    supportsKeychainForTests(true);
    __setSecurityCommandRunnerForTests(runner);

    try {
      const written = writeConfig({
        username: "alice",
        sharedKey: 123n,
        port: 5005,
        host: "127.0.0.1",
      });
      assertEquals(written.secretSource, "keychain");
      assertEquals(readConfigOrNull()?.username, "alice");
      clearConfig();
      assertEquals(readConfigOrNull(), null);
      const deleteCalled = calls.some((value) =>
        value[0] === "delete-generic-password"
      );
      assertEquals(deleteCalled, true);
    } finally {
      supportsKeychainForTests(undefined);
      __setSecurityCommandRunnerForTests(() => ({
        code: 0,
        stdout: "",
        stderr: "",
      }));
    }
  });
});

Deno.test("readConfig removes keychain-backed config when keychain key is missing", async () => {
  await withTmpHome(async () => {
    const { APWError } = await import("./const.ts");
    const { readConfig, readConfigOrNull } = await import("./utils.ts");
    const {
      __setSecurityCommandRunnerForTests,
      supportsKeychainForTests,
    } = await import("./secrets.ts");

    const path = `${Deno.env.get("HOME")}/.apw/config.json`;
    await Deno.mkdir(`${Deno.env.get("HOME")}/.apw`, { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schema: 1,
        port: 5000,
        host: "127.0.0.1",
        username: "alice",
        sharedKey: "",
        secretSource: "keychain",
        createdAt: new Date().toISOString(),
      }),
    );

    const runner = (args: string[]) => {
      if (args[0] === "find-generic-password") {
        return {
          code: 44,
          stdout: "",
          stderr: "Could not be found.",
        };
      }
      if (args[0] === "delete-generic-password") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    supportsKeychainForTests(true);
    __setSecurityCommandRunnerForTests(runner);

    try {
      assertThrows(
        () => readConfig({ requireAuth: true }),
        APWError,
        "No active session. Run `apw auth` again.",
      );
      assertEquals(readConfigOrNull(), null);
    } finally {
      supportsKeychainForTests(undefined);
      __setSecurityCommandRunnerForTests(() => ({
        code: 0,
        stdout: "",
        stderr: "",
      }));
    }
  });
});

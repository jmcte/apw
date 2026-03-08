import {
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import { createCLI, normalizePin, sanitizeUrl } from "./cli.ts";
import type { ApplePasswordManager as APWClient } from "./client.ts";

const captureOutput = async <T>(
  action: () => Promise<T> | T,
): Promise<{ logs: string[]; errors: string[]; result: T }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  try {
    const result = await action();
    return { logs, errors, result };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
};

const withPatchedClient = async (patch: {
  status?: (this: APWClient) => unknown;
  logout?: (this: APWClient) => Promise<void>;
  requestChallenge?: (this: APWClient) => Promise<unknown>;
  verifyChallenge?: (this: APWClient, pin: string) => Promise<unknown>;
  getPasswordForURL?: (
    this: APWClient,
    url: string,
    username?: string,
  ) => Promise<unknown>;
  getLoginNamesForURL?: (this: APWClient, url: string) => Promise<unknown>;
  getOTPForURL?: (this: APWClient, url: string) => Promise<unknown>;
  listOTPForURL?: (this: APWClient, url: string) => Promise<unknown>;
}): Promise<() => void> => {
  const module = await import("./client.ts");
  const proto = module.ApplePasswordManager.prototype as unknown as Record<
    string,
    unknown
  >;

  const originals: Array<[string, unknown]> = [];
  for (const [name, replacement] of Object.entries(patch)) {
    if (typeof replacement === "undefined") continue;
    originals.push([name, proto[name]]);
    proto[name] = replacement;
  }

  return () => {
    for (const [name, original] of originals) {
      proto[name] = original;
    }
  };
};

Deno.test("normalizePin enforces six numeric digits", () => {
  assertEquals(normalizePin("012345"), "012345");
  assertThrows(() => normalizePin("12345"));
  assertThrows(() => normalizePin("0000001"));
  assertThrows(() => normalizePin("12a456"));
});

Deno.test("sanitizeUrl validates URLs and preserves entry", () => {
  assertEquals(sanitizeUrl("example.com"), "example.com");
  assertEquals(sanitizeUrl("https://example.com"), "https://example.com");
  assertThrows(() => sanitizeUrl(""));
  assertThrows(() => sanitizeUrl("://bad"));
});

Deno.test("CLI command constructors are stable", () => {
  const command = createCLI();
  assertEquals(typeof command.parse, "function");
});

Deno.test("status command emits machine output", async () => {
  const restore = await withPatchedClient({
    status: () => ({
      daemon: { host: "127.0.0.1", port: 5000, schema: 1 },
      session: {
        username: "alice",
        createdAt: new Date().toISOString(),
        expired: false,
        authenticated: true,
      },
    }),
  });

  try {
    const { logs } = await captureOutput(async () => {
      await createCLI().parse(["status", "--json"]);
    });

    const output = JSON.parse(logs[0]);
    assertEquals(output.ok, true);
    assertObjectMatch(output.payload.daemon, { host: "127.0.0.1", port: 5000 });
  } finally {
    restore();
  }
});

Deno.test("pw get command formats payloads through printEntries", async () => {
  const restore = await withPatchedClient({
    getPasswordForURL: () =>
      Promise.resolve({
        STATUS: 0,
        Entries: [
          {
            USR: "alice",
            sites: ["https://example.com/"],
            PWD: "secret",
          },
        ],
      }),
  });

  try {
    const { logs } = await captureOutput(async () => {
      await createCLI().parse(["pw", "get", "example.com", "alice"]);
    });
    const output = JSON.parse(logs[0]);
    assertEquals(output.results[0], {
      username: "alice",
      domain: "https://example.com/",
      password: "secret",
    });
  } finally {
    restore();
  }
});

Deno.test("otp list command parses website response", async () => {
  const restore = await withPatchedClient({
    listOTPForURL: () =>
      Promise.resolve({
        STATUS: 0,
        Entries: [
          {
            code: "111111",
            username: "alice",
            source: "totp",
            domain: "example.com",
          },
        ],
      }),
  });

  try {
    const { logs } = await captureOutput(async () => {
      await createCLI().parse(["otp", "list", "example.com"]);
    });
    const output = JSON.parse(logs[0]);
    assertEquals(output.results[0].code, "111111");
    assertEquals(output.results[0].username, "alice");
  } finally {
    restore();
  }
});

Deno.test("auth logout invokes client logout", async () => {
  let called = false;
  const restore = await withPatchedClient({
    logout: () => {
      called = true;
      return Promise.resolve();
    },
  });

  try {
    const { logs } = await captureOutput(async () => {
      await createCLI().parse(["auth", "logout"]);
    });
    assertEquals(called, true);
    assertStringIncludes(logs[0], "logged out");
  } finally {
    restore();
  }
});

Deno.test("auth request command emits encoded challenge fields", async () => {
  const restore = await withPatchedClient({
    requestChallenge: function () {
      this.session.updateWithValues({
        username: "alice",
        salt: 1n,
        serverPublicKey: 2n,
        clientPrivateKey: 3n,
      });
      return Promise.resolve();
    },
  });

  try {
    const { logs } = await captureOutput(async () => {
      await createCLI().parse(["auth", "request"]);
    });
    const output = JSON.parse(logs[0]);
    assertEquals(typeof output.salt, "string");
    assertEquals(typeof output.clientKey, "string");
  } finally {
    restore();
  }
});

Deno.test("auth response command accepts pin input", async () => {
  const restore = await withPatchedClient({
    verifyChallenge: function (pin: string) {
      assertEquals(pin, "123456");
      return Promise.resolve(true);
    },
  });

  try {
    const { logs } = await captureOutput(async () => {
      await createCLI().parse([
        "auth",
        "response",
        "--pin",
        "123456",
        "--salt",
        "AQ==",
        "--serverKey",
        "Ag==",
        "--clientKey",
        "Aw==",
        "--username",
        "alice",
      ]);
    });
    assertStringIncludes(logs[0], "status");
  } finally {
    restore();
  }
});

Deno.test("start command rejects invalid bind host", async () => {
  await assertRejects(() =>
    createCLI().parse(["start", "--bind", "bad host!", "--port", "5000"])
  );
});

Deno.test("start command validates numeric port", async () => {
  await assertRejects(() =>
    createCLI().parse(["start", "--bind", "127.0.0.1", "--port", "bad"])
  );
});

Deno.test("auth command accepts --pin without prompting", async () => {
  let receivedPin = "";
  const restore = await withPatchedClient({
    requestChallenge: () => Promise.resolve(),
    verifyChallenge: (pin: string) => {
      receivedPin = pin;
      return Promise.resolve(true);
    },
  });

  try {
    await createCLI().parse([
      "auth",
      "--pin",
      "012345",
    ]);
    assertEquals(receivedPin, "012345");
  } finally {
    restore();
  }
});

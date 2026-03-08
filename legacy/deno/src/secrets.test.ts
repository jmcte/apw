import { assertEquals, assertThrows } from "@std/assert";

import { APWError, Status } from "./const.ts";
import {
  __setSecurityCommandRunnerForTests,
  deleteSharedKey,
  readSharedKey,
  supportsKeychainForTests,
  writeSharedKey,
} from "./secrets.ts";

const mockSecurityCommand = (
  responses: Array<{
    code: number;
    stdout: string;
    stderr: string;
  }>,
) => {
  let index = 0;
  return (_args: string[]) => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { ...response };
  };
};

Deno.test("non-darwin keychain backend is reported unsupported", () => {
  supportsKeychainForTests(false);
  try {
    assertThrows(
      () => readSharedKey("alice"),
      APWError,
      "Keychain storage is only available on macOS.",
    );
  } finally {
    supportsKeychainForTests(undefined);
  }
});

Deno.test("write/read/delete operations are routed through mocked security command", () => {
  supportsKeychainForTests(true);
  const runner = mockSecurityCommand([
    { code: 0, stdout: "", stderr: "" }, // write
    { code: 0, stdout: "abc", stderr: "" }, // read
    { code: 44, stdout: "", stderr: "Could not be found." }, // delete
  ]);

  __setSecurityCommandRunnerForTests(runner);

  try {
    writeSharedKey("alice", "abc");
    assertEquals(readSharedKey("alice"), "abc");
    deleteSharedKey("alice");
  } finally {
    supportsKeychainForTests(undefined);
  }
});

Deno.test("write failures are surfaced as APW status errors", () => {
  supportsKeychainForTests(true);
  const runner = mockSecurityCommand([
    { code: 1, stdout: "", stderr: "security failed" },
  ]);

  __setSecurityCommandRunnerForTests(runner);

  try {
    try {
      writeSharedKey("alice", "abc");
    } catch (error) {
      if (error instanceof APWError) {
        assertEquals(error.code, Status.INVALID_CONFIG);
      }
      return;
    }
    throw new Error("Expected writeSharedKey to throw");
  } finally {
    supportsKeychainForTests(undefined);
  }
});

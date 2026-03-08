import { APWError, Status } from "./const.ts";

export type SecretSource = "file" | "keychain";

const KEYCHAIN_SERVICE = "dev.benjaminedwards.apw.sharedKey";
const decoder = new TextDecoder();

type SecurityCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

let securityCommandRunner = (args: string[]): SecurityCommandResult => {
  const command = new Deno.Command("security", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = command.outputSync();
  return {
    code: output.code,
    stdout: decodeOutput(output.stdout),
    stderr: decodeOutput(output.stderr),
  };
};

let isNativeAvailableOverride: boolean | undefined;

const decodeOutput = (value: Uint8Array) => decoder.decode(value).trim();

const isUnsupportedResult = (result: SecurityCommandResult) => {
  return (
    result.code !== 0 &&
    /not\sfound|could not be found|not found|No such item/i.test(result.stderr)
  );
};

const runKeychain = (args: string[]): SecurityCommandResult => {
  if (!supportsKeychain()) {
    throw new APWError(
      Status.PROCESS_NOT_RUNNING,
      "Keychain storage is only available on macOS.",
    );
  }

  try {
    return securityCommandRunner(args);
  } catch (error) {
    throw new APWError(
      Status.GENERIC_ERROR,
      `Failed to execute security command: ${error}`,
    );
  }
};

export const supportsKeychain = (): boolean => {
  return isNativeAvailableOverride ?? (Deno.build.os === "darwin");
};

export const supportsKeychainForTests = (value?: boolean) => {
  isNativeAvailableOverride = value;
};

export const readSharedKey = (username: string): string | null => {
  if (!username) return null;

  const result = runKeychain([
    "find-generic-password",
    "-a",
    username,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);

  if (result.code === 0) {
    return result.stdout.trim();
  }

  if (isUnsupportedResult(result)) {
    return null;
  }

  if (!result.stderr) {
    throw new APWError(Status.INVALID_CONFIG, "Keychain lookup failed.");
  }

  throw new APWError(Status.INVALID_CONFIG, result.stderr);
};

export const writeSharedKey = (username: string, sharedKey: string): void => {
  if (!username) {
    throw new APWError(Status.INVALID_CONFIG, "Invalid session username.");
  }
  if (!sharedKey) {
    throw new APWError(Status.INVALID_CONFIG, "Invalid shared key value.");
  }

  const result = runKeychain([
    "add-generic-password",
    "-a",
    username,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    sharedKey,
    "-U",
  ]);

  if (result.code !== 0) {
    throw new APWError(
      Status.INVALID_CONFIG,
      result.stderr || "Failed to store secret.",
    );
  }
};

export const deleteSharedKey = (username: string): void => {
  if (!username) return;

  const result = runKeychain([
    "delete-generic-password",
    "-a",
    username,
    "-s",
    KEYCHAIN_SERVICE,
  ]);

  if (result.code === 0 || isUnsupportedResult(result)) {
    return;
  }

  if (!result.stderr) {
    throw new APWError(Status.INVALID_CONFIG, "Failed to delete secret.");
  }

  throw new APWError(Status.INVALID_CONFIG, result.stderr);
};

export const __setSecurityCommandRunnerForTests = (
  runner: (args: string[]) => SecurityCommandResult,
) => {
  securityCommandRunner = runner;
};

// deno-lint-ignore-file no-explicit-any
import { Buffer } from "./deps.ts";
import { APWError, DATA_PATH, Status } from "./const.ts";
import { APWConfig, APWConfigV1 } from "./types.ts";
import {
  deleteSharedKey,
  readSharedKey,
  SecretSource,
  supportsKeychain,
  writeSharedKey,
} from "./secrets.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 10_000;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const MAX_PORT = 65_535;
const configPath = () => `${DATA_PATH()}/config.json`;
const dataPath = () => DATA_PATH();
const CURRENT_CONFIG_SCHEMA = 1 as const;

export interface APWRuntimeConfig {
  schema: 1;
  port: number;
  host: string;
  username: string;
  sharedKey: bigint;
  createdAt: string;
}

export const toBuffer = (data: any): Buffer => {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (typeof data === "bigint") {
    const array: number[] = [];
    let remaining = data;
    if (remaining === 0n) {
      return Buffer.from([0x00]);
    }
    while (remaining > 0n) {
      array.unshift(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    return Buffer.from(array);
  }

  if (typeof data === "number") {
    return toBuffer(BigInt(data));
  }

  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }

  if (typeof data === "boolean") {
    return Buffer.from([data ? 1 : 0]);
  }

  if (data === undefined || data === null) {
    return Buffer.from(String(data), "utf8");
  }

  return Buffer.from(JSON.stringify(data), "utf8");
};

export const toBufferSource = (data: any) => {
  const buffer = toBuffer(data);
  return new Uint8Array(buffer);
};

export const toBase64 = (data: any) => toBuffer(data).toString("base64");

export const readBigInt = (buffer: Buffer): bigint => {
  return buffer.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
};

export const sha256 = async (data: any) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", toBufferSource(data)));

export const pad = (buffer: Buffer, length: number) => {
  const array = Buffer.alloc(length);
  array.set(buffer.subarray(0, length), Math.max(length - buffer.length, 0));
  return array;
};

export const mod = (A: bigint, N: bigint) => {
  A %= N;
  if (A < 0n) A += N;
  return A;
};

export const powermod = (g: bigint, x: bigint, N: bigint): bigint => {
  if (x < 0n) {
    throw new Error("Unsupported negative exponents");
  }

  let base = mod(g, N);
  let exp = x;
  let result = 1n;

  while (exp > 0n) {
    if ((exp & 1n) === 1n) {
      result = mod(result * base, N);
    }
    exp >>= 1n;
    if (exp > 0n) {
      base = mod(base * base, N);
    }
  }

  return mod(result, N);
};

export function randomBytes(count: number) {
  const array = new Uint8Array(count);
  crypto.getRandomValues(array);
  return Buffer.from(array);
}

const isValidPort = (value: unknown): value is number => {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 &&
    value <= MAX_PORT;
};

const isSecretSource = (value: unknown): value is SecretSource =>
  value === "file" || value === "keychain";

const resolveSecretSource = (input: APWConfigV1): SecretSource => {
  if (isSecretSource(input.secretSource)) {
    return input.secretSource;
  }

  if (typeof input.sharedKey === "string" && input.sharedKey.length > 0) {
    return "file";
  }

  return "keychain";
};

const isV1Config = (input: unknown): input is APWConfigV1 => {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as APWConfigV1;
  const source = resolveSecretSource(candidate);
  const hasFileSecret = typeof candidate.sharedKey === "string" && candidate
        .sharedKey.length > 0;

  return candidate.schema === CURRENT_CONFIG_SCHEMA &&
    isValidPort(candidate.port) &&
    typeof candidate.host === "string" &&
    candidate.host.length > 0 &&
    typeof candidate.username === "string" &&
    (source === "file" ? hasFileSecret : true) &&
    typeof candidate.createdAt === "string";
};

const isLegacyConfig = (input: unknown): input is APWConfig => {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as APWConfig;
  return typeof candidate.username === "string" &&
    typeof candidate.sharedKey === "string" &&
    (candidate.port === undefined || isValidPort(candidate.port));
};

const toV1Config = (input: APWConfig): APWConfigV1 => ({
  schema: CURRENT_CONFIG_SCHEMA,
  port: input.port ?? DEFAULT_PORT,
  host: DEFAULT_HOST,
  username: input.username || "",
  sharedKey: input.sharedKey || "",
  secretSource: input.sharedKey ? "file" : "keychain",
  createdAt: new Date().toISOString(),
});

const normalizeConfig = (input: unknown): APWConfigV1 => {
  if (isV1Config(input)) {
    const source = resolveSecretSource(input);
    return {
      schema: CURRENT_CONFIG_SCHEMA,
      port: input.port,
      host: input.host || DEFAULT_HOST,
      username: input.username,
      sharedKey: source === "keychain" ? "" : input.sharedKey,
      secretSource: source,
      createdAt: input.createdAt,
    };
  }

  if (isLegacyConfig(input)) {
    return toV1Config(input);
  }

  throw new APWError(
    Status.INVALID_CONFIG,
    "Invalid config format. Run `apw auth` again.",
  );
};

const ensureConfigDirectory = () => {
  try {
    const target = dataPath();
    Deno.mkdirSync(target, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
    const stat = Deno.statSync(target);
    if (
      stat.mode !== null && (stat.mode & 0o777) !== CONFIG_DIRECTORY_MODE
    ) {
      Deno.chmodSync(target, CONFIG_DIRECTORY_MODE);
    }
  } catch {
    // Best effort: if permissions cannot be normalized, continue but enforce fail-closed
    // behavior when writing config.
  }
};

const writeAtomic = (path: string, content: string) => {
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  Deno.writeTextFileSync(tempPath, content, { mode: CONFIG_FILE_MODE });
  Deno.renameSync(tempPath, path);
  try {
    Deno.chmodSync(path, CONFIG_FILE_MODE);
  } catch {
    // Ignore permission adjustment failures on constrained filesystems.
  }
};

export const clearConfig = () => {
  const existing = readConfigFileOrNull();
  const username = existing?.username || "";
  const source = existing?.secretSource || resolveSecretSource(
    existing || ({} as APWConfigV1),
  );

  if (source === "keychain" && username) {
    try {
      deleteSharedKey(username);
    } catch {
      // Ignore keychain cleanup failures and continue with config file removal.
    }
  }

  try {
    Deno.removeSync(configPath());
  } catch {
    return;
  }
};

const readConfigFileOrNull = (): APWConfigV1 | null => {
  try {
    return readConfigFile();
  } catch {
    return null;
  }
};

const readConfigFile = (): APWConfigV1 => {
  let content: string;
  const path = configPath();
  try {
    content = Deno.readTextFileSync(path);
  } catch {
    throw new APWError(
      Status.INVALID_CONFIG,
      `No config file at ${path}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    clearConfig();
    throw new APWError(
      Status.INVALID_CONFIG,
      "Config file contains invalid JSON.",
    );
  }

  const normalized = normalizeConfig(parsed);

  return normalized;
};

const readBigIntOrThrow = (input?: string) => {
  if (!input) return undefined;

  try {
    return readBigInt(Buffer.from(input, "base64"));
  } catch {
    clearConfig();
    throw new APWError(
      Status.INVALID_CONFIG,
      "Invalid config payload format. Run `apw auth` again.",
    );
  }
};

const expiredConfig = (createdAt: string, maxAgeMs: number) => {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  if (createdAtMs > Date.now()) return true;
  if (maxAgeMs <= 0) return false;
  return Date.now() - createdAtMs > maxAgeMs;
};

const emptyRuntimeConfig = (): APWRuntimeConfig => ({
  schema: 1,
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  username: "",
  sharedKey: 0n,
  createdAt: new Date(0).toISOString(),
});

const keychainAvailable = () => supportsKeychain();

const resolveSharedKey = (
  config: APWConfigV1,
): { source: SecretSource; sharedKey?: string } => {
  const source = resolveSecretSource(config);

  if (source === "file") {
    return { source, sharedKey: config.sharedKey };
  }

  if (!config.username) {
    return { source, sharedKey: undefined };
  }

  const key = readSharedKey(config.username);
  if (key) return { source, sharedKey: key };

  if (typeof config.sharedKey === "string" && config.sharedKey.length > 0) {
    return { source: "file", sharedKey: config.sharedKey };
  }

  return { source, sharedKey: undefined };
};

export const readConfig = ({
  requireAuth = false,
  maxAgeMs = SESSION_MAX_AGE_MS,
}: {
  requireAuth?: boolean;
  maxAgeMs?: number;
} = {}): APWRuntimeConfig => {
  let config: APWConfigV1;
  try {
    config = readConfigFile();
  } catch (error) {
    if (requireAuth) {
      throw error instanceof APWError
        ? error
        : new APWError(Status.INVALID_CONFIG, "Failed to load config.");
    }
    return emptyRuntimeConfig();
  }

  const createdAtMs = Date.parse(config.createdAt);
  if (!Number.isFinite(createdAtMs) || createdAtMs > Date.now()) {
    if (requireAuth) {
      clearConfig();
      throw new APWError(
        Status.INVALID_CONFIG,
        "Stored credentials have an invalid timestamp.",
      );
    }
    return emptyRuntimeConfig();
  }

  let resolved: { source: SecretSource; sharedKey?: string };
  try {
    resolved = resolveSharedKey(config);
  } catch (error) {
    clearConfig();
    if (requireAuth) {
      throw error instanceof APWError
        ? error
        : new APWError(Status.INVALID_CONFIG, "Failed to load config.");
    }
    return emptyRuntimeConfig();
  }

  let sharedKey: bigint | undefined;
  try {
    sharedKey = readBigIntOrThrow(resolved.sharedKey);
  } catch (error) {
    clearConfig();
    if (requireAuth) {
      throw error;
    }
    return emptyRuntimeConfig();
  }

  if (!config.username || sharedKey === undefined || sharedKey === 0n) {
    clearConfig();
    if (requireAuth) {
      throw new APWError(
        Status.INVALID_SESSION,
        "No active session. Run `apw auth` again.",
      );
    }
    return emptyRuntimeConfig();
  }

  if (expiredConfig(config.createdAt, maxAgeMs)) {
    clearConfig();
    if (requireAuth) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Session expired. Run `apw auth` again.",
      );
    }
    return {
      ...emptyRuntimeConfig(),
      port: config.port,
      host: config.host || DEFAULT_HOST,
      username: config.username,
      sharedKey,
      createdAt: config.createdAt,
    };
  }

  return {
    schema: 1,
    port: config.port,
    host: config.host || DEFAULT_HOST,
    username: config.username,
    sharedKey,
    createdAt: config.createdAt,
  };
};

export const readConfigOrNull = (): APWConfigV1 | null => {
  try {
    return readConfigFile();
  } catch {
    return null;
  }
};

export const writeConfig = ({
  username,
  sharedKey,
  port,
  host,
  allowEmpty = false,
}: {
  username?: string;
  sharedKey?: bigint;
  port?: number;
  host?: string;
  allowEmpty?: boolean;
}) => {
  ensureConfigDirectory();

  if (
    !allowEmpty &&
    (typeof username !== "string" || username.length === 0 ||
      typeof sharedKey !== "bigint" || sharedKey <= 0n)
  ) {
    throw new APWError(
      Status.INVALID_CONFIG,
      "Cannot persist incomplete config. Run `apw auth` first.",
    );
  }

  const existing = readConfigOrNull();
  const resolvedPort = isValidPort(port)
    ? port
    : existing?.port || DEFAULT_PORT;
  const resolvedHost = host && host.trim().length > 0 ? host : existing?.host ||
    DEFAULT_HOST;
  const resolvedUsername = username ?? existing?.username ?? "";

  if (!isValidPort(resolvedPort)) {
    throw new APWError(Status.INVALID_CONFIG, "Invalid config port.");
  }

  if (!resolvedHost || resolvedHost.includes("\0")) {
    throw new APWError(Status.INVALID_CONFIG, "Invalid config host.");
  }

  const writeToKeychain = () =>
    typeof resolvedUsername === "string" &&
    resolvedUsername.length > 0 &&
    typeof sharedKey === "bigint" &&
    sharedKey > 0n &&
    keychainAvailable();
  const hasSessionSecret = typeof sharedKey === "bigint" && sharedKey > 0n &&
    resolvedUsername.length > 0;

  let secretSource: SecretSource = existing?.secretSource ?? "file";
  let serializedKey = "";

  if (!allowEmpty && hasSessionSecret) {
    if (writeToKeychain()) {
      writeSharedKey(resolvedUsername, toBase64(sharedKey));
      secretSource = "keychain";
      serializedKey = "";
    } else {
      secretSource = "file";
      serializedKey = toBase64(sharedKey);
    }
  } else if (
    secretSource === "keychain" && existing?.secretSource === "keychain"
  ) {
    serializedKey = "";
  } else if (secretSource === "file" && existing?.sharedKey) {
    serializedKey = existing.sharedKey;
  }

  const updated: APWConfigV1 = {
    schema: CURRENT_CONFIG_SCHEMA,
    port: resolvedPort,
    host: resolvedHost,
    username: resolvedUsername,
    sharedKey: serializedKey,
    secretSource,
    createdAt: new Date().toISOString(),
  };

  if (
    !allowEmpty &&
    (updated.username.length === 0 || (updated.secretSource === "file" &&
      !updated.sharedKey) ||
      (updated.secretSource === "keychain" && !keychainAvailable()))
  ) {
    throw new APWError(
      Status.INVALID_CONFIG,
      "Cannot persist incomplete config. Run `apw auth` first.",
    );
  }

  writeAtomic(configPath(), JSON.stringify(updated));
  return updated;
};

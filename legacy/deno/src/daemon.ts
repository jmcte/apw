import { ManifestConfig } from "./types.ts";
import { APWError, describeStatus, normalizeStatus, Status } from "./const.ts";
import { Buffer, createSocket, type RemoteInfo } from "./deps.ts";
import { clearConfig, DEFAULT_HOST, writeConfig } from "./utils.ts";

export interface UDPSocket {
  data: Buffer;
  rinfo: RemoteInfo;
}

const MANIFEST_PATHS = [
  "/Library/Application Support/Mozilla/NativeMessagingHosts/com.apple.passwordmanager.json",
  "/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json",
] as const;

const MAX_HELPER_PAYLOAD = 16 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

const isSafeManifestPath = (path: string) =>
  MANIFEST_PATHS.includes(path as (typeof MANIFEST_PATHS)[number]);
const isAbsoluteUnixPath = (path: string) =>
  path.startsWith("/") && !path.includes("\0");

const isExecutable = (path: string) => {
  try {
    const stat = Deno.statSync(path);
    return stat.isFile && (stat.mode === null || (stat.mode & 0o111) > 0);
  } catch {
    return false;
  }
};

const isManifest = (value: unknown): value is ManifestConfig => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as ManifestConfig;
  return typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.type === "string" &&
    Array.isArray(candidate.allowedOrigins) &&
    candidate.allowedOrigins.every((origin) => typeof origin === "string");
};

const readManifest = (): ManifestConfig => {
  if (Deno.build.os !== "darwin") {
    throw new APWError(
      Status.GENERIC_ERROR,
      "APW Helper manifest unsupported outside of macOS.",
    );
  }

  const path = MANIFEST_PATHS.find((candidate) => {
    try {
      return Deno.statSync(candidate).isFile;
    } catch {
      return false;
    }
  });

  if (!path || !isSafeManifestPath(path)) {
    throw new APWError(
      Status.GENERIC_ERROR,
      "APW Helper manifest not found. You must be running macOS 14+.",
    );
  }

  let manifestContent: unknown;
  try {
    manifestContent = JSON.parse(
      new TextDecoder("utf-8").decode(Deno.readFileSync(path)),
    );
  } catch {
    throw new APWError(
      Status.INVALID_CONFIG,
      "Malformed helper manifest JSON.",
    );
  }

  if (!isManifest(manifestContent)) {
    throw new APWError(Status.INVALID_CONFIG, "Malformed helper manifest.");
  }

  if (
    !isAbsoluteUnixPath(manifestContent.path) ||
    manifestContent.path.includes("..")
  ) {
    throw new APWError(Status.INVALID_CONFIG, "Unexpected helper binary path.");
  }

  if (!isExecutable(manifestContent.path)) {
    throw new APWError(
      Status.PROCESS_NOT_RUNNING,
      "Cannot execute helper binary.",
    );
  }

  return manifestContent;
};

export const readFramedResponse = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let expectedLength: number | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      throw new APWError(
        Status.PROTO_INVALID_RESPONSE,
        "Helper closed unexpectedly.",
      );
    }
    if (!value) continue;

    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > MAX_HELPER_PAYLOAD) {
      throw new APWError(
        Status.PROTO_INVALID_RESPONSE,
        "Helper response exceeds max size.",
      );
    }

    chunks.push(chunk);
    const combined = Buffer.concat(chunks);

    if (expectedLength === null && combined.length >= 4) {
      const lengthBytes = combined.subarray(0, 4);
      expectedLength = lengthBytes.readUInt32LE(0);

      if (expectedLength <= 0 || expectedLength > MAX_HELPER_PAYLOAD) {
        throw new APWError(
          Status.PROTO_INVALID_RESPONSE,
          "Invalid helper frame size.",
        );
      }
    }

    if (expectedLength !== null) {
      if (combined.length < expectedLength + 4) continue;
      if (combined.length > expectedLength + 4) {
        throw new APWError(
          Status.PROTO_INVALID_RESPONSE,
          "Malformed helper frame: trailing bytes detected.",
        );
      }
      return Buffer.from(combined.subarray(4));
    }
  }
};

export const parseFramedPayload = (payload: Buffer) => {
  if (payload.length > MAX_HELPER_PAYLOAD) {
    throw new APWError(Status.PROTO_INVALID_RESPONSE, "Response too large.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new APWError(
      Status.PROTO_INVALID_RESPONSE,
      "Helper returned invalid JSON.",
    );
  }

  if (decoded === null || typeof decoded !== "object") {
    throw new APWError(
      Status.PROTO_INVALID_RESPONSE,
      "Invalid helper response payload.",
    );
  }

  return decoded as unknown;
};

const receiveDatagram = (listener: ReturnType<typeof createSocket>) =>
  new Promise<UDPSocket>((resolve, reject) => {
    const onError = (error: Error) => {
      listener.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: Buffer, rinfo: RemoteInfo) => {
      listener.off("error", onError);
      resolve({ data, rinfo });
    };

    listener.once("message", onMessage);
    listener.once("error", onError);
  });

const withTimeout = <T>(ms: number, action: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new APWError(Status.COMMUNICATION_TIMEOUT, "Command output timeout."),
      );
    }, ms);
    action
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });

export const parseHelperResponse = (payload: unknown) => {
  if (payload === null || typeof payload !== "object") {
    throw new APWError(
      Status.PROTO_INVALID_RESPONSE,
      "Invalid helper response payload.",
    );
  }

  const candidate = payload as {
    ok?: unknown;
    code?: unknown;
    payload?: unknown;
    error?: unknown;
  };
  if (typeof candidate.ok !== "boolean") {
    return payload;
  }

  if (candidate.ok) {
    if (candidate.payload === undefined) {
      throw new APWError(
        Status.PROTO_INVALID_RESPONSE,
        "Invalid helper envelope: missing payload",
      );
    }
    return candidate.payload;
  }

  const code = normalizeStatus(candidate.code);
  const error = typeof candidate.error === "string"
    ? candidate.error
    : describeStatus(code);
  throw new APWError(code, error);
};

const sendEnvelope = async (
  listener: ReturnType<typeof createSocket>,
  rinfo: RemoteInfo,
  code: Status,
  payload?: unknown,
  error?: string,
) => {
  const response = code === Status.SUCCESS
    ? {
      ok: true,
      code,
      payload,
    }
    : {
      ok: false,
      code,
      error: error ?? describeStatus(code),
    };

  const encoded = Buffer.from(JSON.stringify(response), "utf8");
  await listener.send(encoded, rinfo.port, rinfo.address);
};

export async function Daemon({
  port = 0,
  host = DEFAULT_HOST,
}: {
  port?: number;
  host?: string;
}) {
  await clearConfig();
  const manifest = readManifest();

  const command = new Deno.Command(manifest.path, {
    args: ["."],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  });

  const process = command.spawn();
  const writer = process.stdin.getWriter();
  let helperRunning = true;

  process.status.then((status) => {
    helperRunning = false;
    clearConfig();
    if (!status.success) {
      console.error(
        `Helper process exited unexpectedly with code ${status.code}.`,
      );
    }
  }).catch(() => {
    helperRunning = false;
    clearConfig();
  });

  const listener = createSocket("udp4");
  const listenerPort = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      listener.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      listener.off("error", onError);
      const address = listener.address();
      resolve(typeof address === "string" ? 0 : address.port);
    };
    listener.once("listening", onListening);
    listener.once("error", onError);
    listener.bind(port, host);
  });

  try {
    writeConfig({
      port: listenerPort,
      host,
      username: "",
      sharedKey: 1n,
      allowEmpty: true,
    });
  } catch {
    // keep running; write failure may indicate transient file permission issues.
  }

  console.info(`APW Helper Listening on ${host}:${listenerPort}.`);

  const frameForHelper = (value: Buffer) => {
    if (value.length > MAX_HELPER_PAYLOAD) {
      throw new APWError(
        Status.INVALID_PARAM,
        "Outgoing payload exceeds max size.",
      );
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(value.length, 0);
    return Buffer.concat([header, value]);
  };

  try {
    while (true) {
      const { data, rinfo } = await receiveDatagram(listener);

      if (data.length > MAX_HELPER_PAYLOAD) {
        await sendEnvelope(
          listener,
          rinfo,
          Status.INVALID_PARAM,
          undefined,
          "Request too large.",
        );
        continue;
      }

      if (!helperRunning) {
        await sendEnvelope(
          listener,
          rinfo,
          Status.PROCESS_NOT_RUNNING,
          undefined,
          "Helper process is not running.",
        );
        continue;
      }

      try {
        const framed = frameForHelper(Buffer.from(data));
        await writer.write(framed);
      } catch (error) {
        helperRunning = false;
        throw error instanceof APWError ? error : new APWError(
          Status.GENERIC_ERROR,
          "Failed writing to helper process.",
        );
      }

      const reader = process.stdout.getReader();
      try {
        const helperPayload = await withTimeout(
          COMMAND_TIMEOUT_MS,
          readFramedResponse(reader),
        );
        const parsed = parseFramedPayload(helperPayload);
        const payload = parseHelperResponse(parsed);
        await sendEnvelope(listener, rinfo, Status.SUCCESS, payload);
      } catch (error) {
        if (error instanceof APWError) {
          await sendEnvelope(
            listener,
            rinfo,
            error.code,
            undefined,
            error.message,
          );
          continue;
        }

        await sendEnvelope(
          listener,
          rinfo,
          Status.GENERIC_ERROR,
          undefined,
          "Command output parse failed.",
        );
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    }
  } catch (error) {
    if (error instanceof APWError) {
      console.error(error.message);
    } else {
      console.error("Unhandled daemon error.", error);
    }

    throw error;
  } finally {
    try {
      listener.close();
    } catch {
      // ignore
    }
    try {
      writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      await process.stdin.close();
    } catch {
      // ignore
    }
  }
}

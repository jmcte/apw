import { Buffer, createSocket } from "./deps.ts";
import {
  Action,
  APWError,
  Command,
  describeStatus,
  MSGTypes,
  normalizeStatus,
  SecretSessionVersion,
  Status,
} from "./const.ts";
import {
  isValidPakeMessage,
  PAKE_FIELD,
  parsePakeMessageCode,
  parsePakeMessageType,
  SRPSession,
} from "./srp.ts";
import {
  clearConfig,
  DEFAULT_HOST,
  DEFAULT_PORT,
  readBigInt,
  readConfig,
  SESSION_MAX_AGE_MS,
  toBase64,
  toBuffer,
  writeConfig,
} from "./utils.ts";
import { Message, MessagePayload, SMSG } from "./types.ts";

const BROWSER_NAME = "Arc";
const VERSION = "1.0";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 0;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_MESSAGE_BYTES = 16 * 1024;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseLegacyEnvelope = (payload: unknown): MessagePayload | undefined => {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as { STATUS?: unknown; Entries?: unknown };
  if (
    typeof candidate.STATUS === "number" &&
    candidate.STATUS >= 0 &&
    Array.isArray(candidate.Entries)
  ) {
    return candidate as MessagePayload;
  }

  return undefined;
};

const parseResponseEnvelope = (payload: unknown): MessagePayload => {
  if (payload === null || typeof payload !== "object") {
    throw new APWError(
      Status.PROTO_INVALID_RESPONSE,
      "Invalid helper response payload type.",
    );
  }

  if (typeof (payload as { ok?: unknown }).ok !== "undefined") {
    const response = payload as {
      ok?: boolean;
      code?: number;
      payload?: unknown;
      error?: unknown;
    };

    if (response.ok === true) {
      if (typeof response.payload === "undefined") {
        throw new APWError(
          Status.PROTO_INVALID_RESPONSE,
          "Missing helper payload.",
        );
      }
      return response.payload as MessagePayload;
    }

    if (response.ok === false) {
      const code = normalizeStatus(response.code);
      const error = typeof response.error === "string"
        ? response.error
        : describeStatus(code);
      throw new APWError(code, error);
    }
  }

  const legacy = parseLegacyEnvelope(payload);
  if (legacy !== undefined) return legacy;

  throw new APWError(
    Status.PROTO_INVALID_RESPONSE,
    "Malformed helper envelope.",
  );
};

const parseJsonPayload = (value: unknown, field: string): string => {
  if (
    typeof value === "object" && value !== null &&
    typeof (value as { PAKE?: unknown }).PAKE === "string"
  ) {
    return String((value as { PAKE: string }).PAKE);
  }

  throw new APWError(
    Status.PROTO_INVALID_RESPONSE,
    `Invalid ${field} payload.`,
  );
};

const parsePakeErrorCode = (code: unknown): number => {
  if (typeof code === "undefined") {
    return 0;
  }

  const parsed = parsePakeMessageCode(code);
  if (!Number.isInteger(parsed)) {
    return Number.NaN;
  }

  return parsed;
};

const parsePakeMsgType = (messageType: unknown): number => {
  const parsed = parsePakeMessageType(messageType);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
};

const parsePakeProto = (value: unknown): number => {
  const parsed = parsePakeMessageCode(value);
  if (!Number.isInteger(parsed)) {
    return Number.NaN;
  }
  return parsed;
};

export const APWMessages = {
  getCapabilities(): Message {
    return { cmd: Command.GET_CAPABILITIES };
  },

  requestChallenge(session: SRPSession): Message {
    return {
      cmd: Command.HANDSHAKE,
      msg: {
        QID: "m0",
        PAKE: toBase64({
          TID: session.username,
          MSG: MSGTypes.CLIENT_KEY_EXCHANGE,
          A: session.serialize(toBuffer(session.clientPublicKey)),
          VER: VERSION,
          PROTO: [SecretSessionVersion.SRP_WITH_RFC_VERIFICATION],
        }),
        HSTBRSR: BROWSER_NAME,
      },
      capabilities: {
        canFillOneTimeCodes: true,
      },
    };
  },

  async getLoginNamesForURL(
    session: SRPSession,
    url: string,
  ): Promise<Message> {
    const sdataEncrypted = await session.encrypt({
      ACT: Action.GHOST_SEARCH,
      URL: url,
    });
    return {
      cmd: Command.GET_LOGIN_NAMES_FOR_URL,
      tabId: 1,
      frameId: 1,
      url,
      payload: JSON.stringify({
        QID: "CmdGetLoginNames4URL",
        SMSG: {
          TID: session.username,
          SDATA: session.serialize(sdataEncrypted),
        },
      }),
    };
  },

  async getPasswordForURL(
    session: SRPSession,
    url: string,
    loginName: string,
  ): Promise<Message> {
    const sdata = session.serialize(
      await session.encrypt({
        ACT: Action.SEARCH,
        URL: url,
        USR: loginName,
      }),
    );
    return {
      cmd: Command.GET_PASSWORD_FOR_LOGIN_NAME,
      tabId: 0,
      frameId: 0,
      url,
      payload: JSON.stringify({
        QID: "CmdGetPassword4LoginName",
        SMSG: {
          TID: session.username,
          SDATA: sdata,
        },
      }),
    };
  },

  async getOTPForURL(
    session: SRPSession,
    url: string,
  ): Promise<Message> {
    const normalized = ApplePasswordManager.normalizeLookupURL(url);
    const sdata = session.serialize(
      await session.encrypt({
        ACT: Action.SEARCH,
        TYPE: "oneTimeCodes",
        frameURLs: [normalized],
      }),
    );
    return {
      cmd: Command.DID_FILL_ONE_TIME_CODE,
      tabId: 0,
      frameId: 0,
      payload: JSON.stringify({
        QID: "CmdDidFillOneTimeCode",
        SMSG: {
          TID: session.username,
          SDATA: sdata,
        },
      }),
    };
  },

  async listOTPForURL(
    session: SRPSession,
    url: string,
  ): Promise<Message> {
    const normalized = ApplePasswordManager.normalizeLookupURL(url);
    const sdata = session.serialize(
      await session.encrypt({
        ACT: Action.GHOST_SEARCH,
        TYPE: "oneTimeCodes",
        frameURLs: [normalized],
      }),
    );
    return {
      cmd: Command.GET_ONE_TIME_CODES,
      tabId: 0,
      frameId: 0,
      payload: JSON.stringify({
        QID: "CmdDidFillOneTimeCode",
        SMSG: {
          TID: session.username,
          SDATA: sdata,
        },
      }),
    };
  },

  verifyChallenge(session: SRPSession, m: Buffer): Message {
    return {
      cmd: Command.HANDSHAKE,
      msg: {
        HSTBRSR: BROWSER_NAME,
        QID: "m2",
        PAKE: toBase64({
          TID: session.username,
          MSG: MSGTypes.CLIENT_VERIFICATION,
          M: session.serialize(m, false),
        }),
      },
    };
  },
};

export class ApplePasswordManager {
  public session: SRPSession;
  private remotePort: number;
  private remoteHost: string;
  private challengeTimestamp = 0;

  public static normalizeLookupURL(url: string) {
    if (!url || typeof url !== "string") {
      return url;
    }

    const trimmed = url.trim();
    if (!trimmed) return "";
    if (!trimmed.includes("://")) return `http://${trimmed}`;
    return trimmed;
  }

  public static parseConfig() {
    return readConfig({ requireAuth: false, maxAgeMs: SESSION_MAX_AGE_MS });
  }

  public async sendMessage(
    messageContent: Message,
    opts: { timeoutMs?: number; retries?: number } = {},
  ): Promise<MessagePayload> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = opts.retries ?? DEFAULT_RETRIES;
    let attempt = 0;

    while (attempt <= retries) {
      try {
        return await this.sendMessageOnce(messageContent, timeoutMs);
      } catch (error) {
        if (
          attempt < retries &&
          error instanceof APWError &&
          error.code === Status.COMMUNICATION_TIMEOUT
        ) {
          const jitter = Math.floor(Math.random() * DEFAULT_RETRY_DELAY_MS);
          await sleep(DEFAULT_RETRY_DELAY_MS * (attempt + 1) + jitter);
          attempt += 1;
          continue;
        }
        throw error;
      }
    }

    throw new APWError(Status.GENERIC_ERROR, "Unable to send message.");
  }

  private async sendMessageOnce(
    messageContent: Message,
    timeoutMs: number,
  ): Promise<MessagePayload> {
    const listener = createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("listening", resolve);
        listener.once("error", reject);
        listener.bind();
      });

      const content = TEXT_ENCODER.encode(JSON.stringify(messageContent));
      if (content.length > MAX_MESSAGE_BYTES) {
        throw new APWError(
          Status.PROTO_INVALID_RESPONSE,
          "Request payload too large.",
        );
      }

      const response = await new Promise<Uint8Array>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new APWError(
              Status.COMMUNICATION_TIMEOUT,
              "No response from helper process",
            ),
          );
        }, timeoutMs);

        const onMessage = (msg: Buffer) => {
          clearTimeout(timeout);
          listener.off("error", onError);
          listener.off("message", onMessage);
          resolve(msg);
        };

        const onError = (error: Error) => {
          clearTimeout(timeout);
          listener.off("message", onMessage);
          listener.off("error", onError);
          reject(error);
        };

        listener.once("message", onMessage);
        listener.once("error", onError);
        listener.send(content, this.remotePort, this.remoteHost);
      });

      if (response.length > MAX_MESSAGE_BYTES) {
        throw new APWError(
          Status.PROTO_INVALID_RESPONSE,
          "Response payload too large.",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(TEXT_DECODER.decode(response));
      } catch {
        throw new APWError(
          Status.PROTO_INVALID_RESPONSE,
          "Invalid helper response JSON.",
        );
      }

      return parseResponseEnvelope(parsed);
    } finally {
      try {
        listener.close();
      } catch {
        // Intentionally ignored.
      }
    }
  }

  constructor() {
    this.session = SRPSession.new(true);
    this.remotePort = DEFAULT_PORT;
    this.remoteHost = DEFAULT_HOST;

    try {
      const config = readConfig();
      this.remotePort = config.port || DEFAULT_PORT;
      this.remoteHost = config.host || DEFAULT_HOST;
      if (config.username && config.sharedKey !== undefined) {
        this.session.updateWithValues({
          username: config.username,
          sharedKey: config.sharedKey,
        });
      }
    } catch {
      // No authenticated session yet, which is fine for startup.
    }
  }

  public ensureAuthenticated(opts: { maxAgeMs?: number } = {}) {
    const config = readConfig({
      requireAuth: true,
      maxAgeMs: opts.maxAgeMs || SESSION_MAX_AGE_MS,
    });

    this.remotePort = config.port || DEFAULT_PORT;
    this.remoteHost = config.host || DEFAULT_HOST;

    if (config.username && config.sharedKey !== undefined) {
      this.session.updateWithValues({
        username: config.username,
        sharedKey: config.sharedKey,
      });
      return config;
    }

    throw new APWError(Status.INVALID_SESSION, "No active session.");
  }

  public async decryptPayload(payload: SMSG) {
    if (typeof payload.SMSG === "string") {
      try {
        payload.SMSG = JSON.parse(payload.SMSG);
      } catch {
        throw new APWError(
          Status.PROTO_INVALID_RESPONSE,
          "Invalid server response format.",
        );
      }
    }

    if (!payload.SMSG || payload.SMSG.TID !== this.session.username) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Invalid server response: destined to another session",
      );
    }

    try {
      const data = await this.session.decrypt(
        this.session.deserialize(payload.SMSG.SDATA),
      );
      return JSON.parse(data.toString("utf8"));
    } catch (_error) {
      throw new APWError(
        Status.PROTO_INVALID_RESPONSE,
        "Invalid server response payload.",
      );
    }
  }

  async requestChallenge() {
    const now = Date.now();
    if (this.challengeTimestamp >= now - 5 * 1000) return;
    this.challengeTimestamp = now;

    const payload = await this.sendMessage(
      APWMessages.requestChallenge(this.session),
    );
    if (payload === undefined) {
      throw new APWError(Status.SERVER_ERROR, "Invalid challenge response.");
    }

    // At this point payload should be a helper response containing the handshake
    // blob; parseJsonPayload enforces the required structure.
    const encoded = parseJsonPayload(payload, "challenge");
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server hello: missing payload",
      );
    }

    if (!isValidPakeMessage(rawMessage)) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server hello: malformed PAKE message",
      );
    }

    if (rawMessage.TID !== this.session.username) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server hello: destined to another session",
      );
    }

    const errCode = parsePakeErrorCode(rawMessage[PAKE_FIELD.ERR_CODE]);
    if (!Number.isInteger(errCode)) {
      throw new APWError(
        Status.PROTO_INVALID_RESPONSE,
        "Invalid server hello: malformed error code",
      );
    }
    if (errCode !== 0) {
      throw new APWError(
        Status.SERVER_ERROR,
        `Invalid server hello: error code ${errCode}`,
      );
    }

    const messageType = parsePakeMsgType(rawMessage[PAKE_FIELD.MSG]);
    if (
      Number.isNaN(messageType) || messageType !== MSGTypes.SERVER_KEY_EXCHANGE
    ) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server hello: unexpected message",
      );
    }

    if (
      parsePakeProto(rawMessage[PAKE_FIELD.PROTO]) !== SecretSessionVersion
        .SRP_WITH_RFC_VERIFICATION
    ) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server hello: unsupported protocol",
      );
    }

    if (
      rawMessage.VER !== undefined &&
      `${rawMessage.VER}` !== `${VERSION}`
    ) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server hello: unsupported version",
      );
    }

    const serverPublicKey = readBigInt(this.session.deserialize(rawMessage.B));
    const salt = readBigInt(this.session.deserialize(rawMessage.s));
    this.session.setServerPublicKey(serverPublicKey, salt);

    return { serverPublicKey, salt };
  }

  async verifyChallenge(password: string) {
    const newKey = await this.session.setSharedKey(password);
    const m = await this.computeClientProof();
    const msg = APWMessages.verifyChallenge(this.session, m);

    const response = await this.sendMessage(msg);
    const encoded = parseJsonPayload(response, "verification");

    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server verification: missing payload",
      );
    }

    if (!isValidPakeMessage(rawMessage)) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server verification: malformed message",
      );
    }

    if (rawMessage.TID !== this.session.username) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server verification: destined to another session",
      );
    }

    const messageType = parsePakeMsgType(rawMessage[PAKE_FIELD.MSG]);
    if (
      Number.isNaN(messageType) || messageType !== MSGTypes.SERVER_VERIFICATION
    ) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server verification: unexpected message",
      );
    }

    const verificationErrCode = parsePakeErrorCode(
      rawMessage[PAKE_FIELD.ERR_CODE],
    );
    if (!Number.isInteger(verificationErrCode)) {
      throw new APWError(
        Status.PROTO_INVALID_RESPONSE,
        "Invalid server verification: malformed error code",
      );
    }

    if (verificationErrCode === 1) {
      throw new APWError(Status.INVALID_SESSION, "Incorrect challenge PIN.");
    }

    if (verificationErrCode !== 0) {
      throw new APWError(
        Status.SERVER_ERROR,
        `Invalid server verification: error code ${verificationErrCode}`,
      );
    }

    if (typeof rawMessage.HAMK !== "string") {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server verification: missing HAMK",
      );
    }

    const expected = this.session.deserialize(rawMessage.HAMK);
    const computedHamk = await this.session.computeHMAC(m);
    if (
      !this.session.verifyHAMK(Buffer.from(expected), Buffer.from(computedHamk))
    ) {
      throw new APWError(
        Status.SERVER_ERROR,
        "Invalid server verification: HAMK mismatch",
      );
    }

    writeConfig({
      username: this.session.username,
      sharedKey: newKey,
      port: this.remotePort,
      host: this.remoteHost,
    });

    return true;
  }

  private computeClientProof() {
    return this.session.computeM();
  }

  async getCapabilities() {
    this.ensureAuthenticated();
    return await this.sendMessage(APWMessages.getCapabilities());
  }

  async getLoginNamesForURL(url: string) {
    this.ensureAuthenticated();
    const msg = await APWMessages.getLoginNamesForURL(this.session, url);
    const payload = await this.sendMessage(msg);
    return await this.decryptPayload(payload as SMSG);
  }

  async getPasswordForURL(url: string, loginName = "") {
    this.ensureAuthenticated();
    const msg = await APWMessages.getPasswordForURL(
      this.session,
      url,
      loginName || "",
    );
    const payload = await this.sendMessage(msg);
    return await this.decryptPayload(payload as SMSG);
  }

  async getOTPForURL(url: string) {
    this.ensureAuthenticated();
    const msg = await APWMessages.getOTPForURL(this.session, url);
    const payload = await this.sendMessage(msg);
    return await this.decryptPayload(payload as SMSG);
  }

  async listOTPForURL(url: string) {
    this.ensureAuthenticated();
    const msg = await APWMessages.listOTPForURL(this.session, url);
    const payload = await this.sendMessage(msg);
    return await this.decryptPayload(payload as SMSG);
  }

  status() {
    try {
      const config = readConfig({
        requireAuth: false,
        maxAgeMs: SESSION_MAX_AGE_MS,
      });
      const createdAt = Date.parse(config.createdAt);
      const expired = Number.isNaN(createdAt)
        ? true
        : Date.now() - createdAt > SESSION_MAX_AGE_MS;

      return {
        daemon: {
          host: config.host,
          port: config.port,
          schema: config.schema,
        },
        session: {
          username: config.username || "",
          createdAt: config.createdAt,
          expired,
          authenticated: Boolean(
            config.username && config.sharedKey && !expired,
          ),
        },
      };
    } catch (error) {
      if (error instanceof APWError) {
        return {
          daemon: {
            host: this.remoteHost,
            port: this.remotePort,
            schema: 1,
          },
          session: {
            username: "",
            createdAt: "",
            expired: true,
            authenticated: false,
            error: error.message,
          },
        };
      }

      return {
        daemon: {
          host: this.remoteHost,
          port: this.remotePort,
          schema: 1,
        },
        session: {
          username: "",
          createdAt: "",
          expired: true,
          authenticated: false,
        },
      };
    }
  }

  async logout() {
    await clearConfig();
    this.session = SRPSession.new(true);
    this.challengeTimestamp = 0;
  }
}

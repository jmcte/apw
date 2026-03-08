import { Buffer } from "./deps.ts";
import {
  mod,
  pad,
  powermod,
  randomBytes,
  readBigInt,
  sha256,
  toBuffer,
  toBufferSource,
} from "./utils.ts";
import { APWError, Status } from "./const.ts";
import { PAKEMessage } from "./types.ts";

const GROUP_PRIME = BigInt(
  "0x" +
    `
      FFFFFFFF FFFFFFFF C90FDAA2 2168C234 C4C6628B 80DC1CD1 29024E08
      8A67CC74 020BBEA6 3B139B22 514A0879 8E3404DD EF9519B3 CD3A431B
      302B0A6D F25F1437 4FE1356D 6D51C245 E485B576 625E7EC6 F44C42E9
      A637ED6B 0BFF5CB6 F406B7ED EE386BFB 5A899FA5 AE9F2411 7C4B1FE6
      49286651 ECE45B3D C2007CB8 A163BF05 98DA4836 1C55D39A 69163FA8
      FD24CF5F 83655D23 DCA3AD96 1C62F356 208552BB 9ED52907 7096966D
      670C354E 4ABC9804 F1746C08 CA18217C 32905E46 2E36CE3B E39E772C
      180E8603 9B2783A2 EC07A28F B5C55DF0 6F4C52C9 DE2BCBF6 95581718
      3995497C EA956AE5 15D22618 98FA0510 15728E5A 8AAAC42D AD33170D
      04507A33 A85521AB DF1CBA64 ECFB8504 58DBEF0A 8AEA7157 5D060C7D
      B3970F85 A6E1E4C7 ABF5AE8C DB0933D7 1E8C94E0 4A25619D CEE3D226
      1AD2EE6B F12FFA06 D98A0864 D8760273 3EC86A64 521F2B18 177B200C
      BBE11757 7A615D6C 770988C0 BAD946E2 08E24FA0 74E5AB31 43DB5BFC
      E0FD108E 4B82D120 A93AD2CA FFFFFFFF FFFFFFFF
    `.replaceAll(/[^0-9A-F]/g, ""),
);
const GROUP_PRIME_BYTES = 3072 >> 3;
const GROUP_GENERATOR = 5n;

export const PAKE_FIELD = {
  TID: "TID" as const,
  MSG: "MSG" as const,
  A: "A" as const,
  S: "s" as const,
  B: "B" as const,
  VER: "VER" as const,
  PROTO: "PROTO" as const,
  HAMK: "HAMK" as const,
  ERR_CODE: "ErrCode" as const,
} as const;

const parseNumericToken = (value: unknown): number => {
  if (Array.isArray(value)) {
    return value.length > 0 ? parseNumericToken(value[0]) : Number.NaN;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  return Number.NaN;
};

export const parsePakeMessageCode = (value: unknown): number =>
  parseNumericToken(value);

export const parsePakeMessageType = (value: unknown): number =>
  parseNumericToken(value);

export const isValidPakeMessage = (
  candidate: unknown,
): candidate is PAKEMessage => {
  if (typeof candidate !== "object" || candidate === null) return false;
  const message = candidate as PAKEMessage;

  if (typeof message.TID !== "string") return false;
  if (!Number.isInteger(parsePakeMessageType(message.MSG))) return false;
  if (typeof message.A !== "string") return false;
  if (typeof message.s !== "string") return false;
  if (typeof message.B !== "string") return false;
  if (!Number.isInteger(parsePakeMessageType(message.PROTO))) return false;

  if (
    message.VER !== undefined &&
    (typeof message.VER !== "number" && typeof message.VER !== "string")
  ) return false;
  if (
    message.HAMK !== undefined &&
    typeof message.HAMK !== "string"
  ) return false;
  if (
    message.ErrCode !== undefined &&
    !Number.isInteger(parsePakeMessageCode(message.ErrCode))
  ) return false;

  return true;
};

const getMultiplier = async () =>
  readBigInt(
    await sha256(
      Buffer.concat([
        toBuffer(GROUP_PRIME),
        pad(toBuffer(GROUP_GENERATOR), GROUP_PRIME_BYTES),
      ]),
    ),
  );

export interface SessionValues {
  username?: string;
  sharedKey?: bigint;
  clientPrivateKey?: bigint;
  salt?: bigint;
  serverPublicKey?: bigint;
}

export class SRPSession {
  private shouldUseBase64: boolean;
  public username: string;
  private clientPrivateKey: bigint;
  private serverPublicKey?: bigint;
  private salt?: bigint;
  private sharedKey?: bigint;

  private constructor(
    username: Buffer,
    clientPrivateKey: bigint,
    shouldUseBase64 = false,
  ) {
    this.clientPrivateKey = clientPrivateKey;
    this.shouldUseBase64 = shouldUseBase64;
    this.username = this.serialize(username);
  }

  updateWithValues(args: SessionValues) {
    if (args.username !== undefined) this.username = args.username;
    if (args.sharedKey !== undefined) this.sharedKey = args.sharedKey;
    if (args.clientPrivateKey !== undefined) {
      this.clientPrivateKey = args.clientPrivateKey;
    }
    if (args.salt !== undefined) this.salt = args.salt;
    if (args.serverPublicKey !== undefined) {
      this.serverPublicKey = args.serverPublicKey;
    }
  }

  returnValues() {
    return {
      username: this.username,
      sharedKey: this.sharedKey,
      clientPrivateKey: this.clientPrivateKey,
      salt: this.salt,
      serverPublicKey: this.serverPublicKey,
    };
  }

  static new(shouldUseBase64?: boolean) {
    const username = randomBytes(16);
    const clientPrivateKey = readBigInt(randomBytes(32));
    return new SRPSession(username, clientPrivateKey, shouldUseBase64);
  }

  get clientPublicKey() {
    return powermod(GROUP_GENERATOR, this.clientPrivateKey, GROUP_PRIME);
  }

  serialize(data: Buffer, prefix = true) {
    return (
      (!this.shouldUseBase64 && prefix ? "0x" : "") +
      data.toString(this.shouldUseBase64 ? "base64" : "hex")
    );
  }

  deserialize(data: string) {
    if (!this.shouldUseBase64) data = data.replace(/^0x/, "");
    return Buffer.from(data, this.shouldUseBase64 ? "base64" : "hex");
  }

  setServerPublicKey(serverPublicKey: bigint, salt: bigint) {
    if (mod(serverPublicKey, GROUP_PRIME) === 0n) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Invalid server hello: invalid public key",
      );
    }

    this.serverPublicKey = serverPublicKey;
    this.salt = salt;
  }

  private deriveScramble() {
    if (this.serverPublicKey === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Invalid session state: missing server public key",
      );
    }

    return sha256(
      Buffer.concat([
        pad(toBuffer(this.clientPublicKey), GROUP_PRIME_BYTES),
        pad(toBuffer(this.serverPublicKey), GROUP_PRIME_BYTES),
      ]),
    );
  }

  private async deriveSessionKey(password: string) {
    if (this.serverPublicKey === undefined || this.salt === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Invalid session state: missing server values",
      );
    }

    const usernamePasswordHash = await sha256(this.username + ":" + password);
    const saltedPassword = await sha256(
      Buffer.concat([toBuffer(this.salt), usernamePasswordHash]),
    );
    const [multiplier, scramble] = await Promise.all([
      getMultiplier(),
      this.deriveScramble(),
    ]);

    const saltedPasswordInt = readBigInt(saltedPassword);
    const u = readBigInt(scramble);
    const sharedSecret = powermod(
      this.serverPublicKey -
        multiplier * powermod(GROUP_GENERATOR, saltedPasswordInt, GROUP_PRIME),
      this.clientPrivateKey + u * saltedPasswordInt,
      GROUP_PRIME,
    );

    return readBigInt(await sha256(sharedSecret));
  }

  async setSharedKey(password: string) {
    if (this.serverPublicKey === undefined || this.salt === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Invalid session state: missing handshake values",
      );
    }

    this.sharedKey = await this.deriveSessionKey(password);
    return this.sharedKey;
  }

  async computeM() {
    if (this.serverPublicKey === undefined || this.salt === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Invalid session state: missing server key",
      );
    }
    if (this.sharedKey === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Invalid session state: missing shared key",
      );
    }

    const [N, g, I, u] = await Promise.all([
      sha256(GROUP_PRIME),
      sha256(pad(toBuffer(GROUP_GENERATOR), GROUP_PRIME_BYTES)),
      sha256(this.username),
      this.deriveScramble(),
    ]);

    const NxorG = N.map((byte, i) => byte ^ g[i]);
    return sha256(
      Buffer.concat([
        NxorG,
        I,
        toBuffer(this.salt),
        toBuffer(this.clientPublicKey),
        toBuffer(this.serverPublicKey),
        toBuffer(this.sharedKey),
        toBuffer(u),
      ]),
    );
  }

  async computeHMAC(data: Buffer) {
    if (this.sharedKey === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Missing encryption key. Reauthenticate with `apw auth`.",
      );
    }

    return await sha256(
      Buffer.concat([
        toBuffer(this.clientPublicKey),
        data,
        toBuffer(this.sharedKey),
      ]),
    );
  }

  async getEncryptionKey() {
    if (this.sharedKey === undefined) {
      return undefined;
    }

    const key = toBuffer(this.sharedKey).subarray(0, 16);
    return await crypto.subtle.importKey(
      "raw",
      toBufferSource(key),
      "AES-GCM",
      true,
      ["encrypt", "decrypt"],
    );
  }

  async encrypt(data: object) {
    const encryptionKey = await this.getEncryptionKey();
    if (encryptionKey === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Missing encryption key. Reauthenticate with `apw auth`.",
      );
    }

    const iv = randomBytes(16);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBufferSource(iv) },
      encryptionKey,
      toBufferSource(data),
    );

    return Buffer.concat([iv, Buffer.from(encrypted)]);
  }

  async decrypt(data: Buffer) {
    const encryptionKey = await this.getEncryptionKey();
    if (encryptionKey === undefined) {
      throw new APWError(
        Status.INVALID_SESSION,
        "Missing encryption key. Reauthenticate with `apw auth`.",
      );
    }

    const iv = data.subarray(0, 16);
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toBufferSource(iv) },
        encryptionKey,
        toBufferSource(data.subarray(16)),
      );
      return Buffer.from(plain);
    } catch {
      throw new APWError(
        Status.PROTO_INVALID_RESPONSE,
        "Failed to decrypt helper response.",
      );
    }
  }

  private static verifyConstantTime(expected: Buffer, actual: Buffer) {
    const maxLength = Math.max(expected.length, actual.length);
    let diff = 0;

    for (let index = 0; index < maxLength; index++) {
      const expectedByte = index < expected.length ? expected[index] : 0;
      const actualByte = index < actual.length ? actual[index] : 0;
      diff |= expectedByte ^ actualByte;
    }

    if (expected.length !== actual.length) {
      diff |= 1;
    }

    return diff === 0;
  }

  verifyHAMK(expected: Buffer, actual: Buffer) {
    if (expected.length === 0 || actual.length === 0) {
      return false;
    }

    return SRPSession.verifyConstantTime(expected, actual);
  }
}

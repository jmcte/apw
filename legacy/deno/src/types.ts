import { Status } from "./const.ts";
import type { SecretSource } from "./secrets.ts";

export interface RenamedPasswordEntry {
  username: string;
  domain: string;
  password: string;
}

export interface PasswordEntry {
  USR: string;
  sites: string[];
  PWD: string;
}

export interface TOTPEntry {
  code: string;
  username: string;
  source: string;
  domain: string;
}

export type MessagePayload = SMSG | string | SRPHandshakeMessage;

export interface Payload {
  STATUS: Status;
  Entries: PasswordEntry[] | TOTPEntry[];
}

export interface Capabilities {
  canFillOneTimeCodes?: boolean;
  scanForOTPURI?: boolean;
  shouldUseBase64?: boolean;
  operatingSystem?: {
    name: string;
    majorVersion: number;
    minorVersion: number;
  };
}
export interface PAKEMessage {
  TID: string;
  MSG: number | string;
  A: string;
  s: string;
  B: string;
  VER?: number | string;
  PROTO: number;
  HAMK?: string;
  ErrCode?: number | string;
}

export interface SMSG {
  SMSG: {
    TID: string;
    SDATA: string;
  };
}

export interface SRPHandshakeMessage {
  QID: string;
  HSTBRSR: string;
  PAKE: PAKEMessage | string;
}

export interface Message {
  cmd: number;
  payload?: MessagePayload;
  msg?: SRPHandshakeMessage | string;
  capabilities?: Capabilities;
  setUpTOTPPageURL?: string;
  setUpTOTPURI?: string;
  url?: string;
  tabId?: number;
  frameId?: number;
}

export interface ManifestConfig {
  name: string;
  description: string;
  path: string;
  type: string;
  allowedOrigins: string[];
}

export interface APWConfigV1 {
  schema: 1;
  port: number;
  host: string;
  username: string;
  sharedKey?: string;
  secretSource?: SecretSource;
  createdAt: string;
}

export interface APWConfig {
  port?: number;
  sharedKey?: string;
  username?: string;
}

export interface APWErrorShape {
  code: Status;
  message: string;
}

export interface APWResponseEnvelope<T = MessagePayload> {
  ok: boolean;
  code: Status;
  payload?: T;
  error?: string;
  requestId?: string;
}

export type RequestResult<T> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: APWErrorShape;
};

export interface SRPValues {
  username?: string;
  sharedKey?: bigint;
  clientPrivateKey?: bigint;
  salt?: bigint;
  serverPublicKey?: bigint;
}

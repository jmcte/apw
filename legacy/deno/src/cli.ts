import { Buffer, Command, Input, Select } from "./deps.ts";
import { Daemon } from "./daemon.ts";
import { ApplePasswordManager } from "./client.ts";
import { readBigInt, toBase64 } from "./utils.ts";
import {
  type Payload,
  type RenamedPasswordEntry,
  type TOTPEntry,
} from "./types.ts";
import { APWError, Status, VERSION } from "./const.ts";

const firstCommandArg = Deno.args.findIndex((value) => !value.startsWith("-"));
export const globalJsonOutput = Deno.args.some(
  (value, index) =>
    value === "--json" &&
    (firstCommandArg < 0 || index < firstCommandArg),
);
export const cliArgs = Deno.args.filter(
  (value, index) =>
    value !== "--json" ||
    (firstCommandArg >= 0 && index >= firstCommandArg),
);

const toOutput = (
  payload: unknown,
  status: Status,
  forceJson = globalJsonOutput,
) => {
  if (forceJson) {
    console.log(
      JSON.stringify({ ok: status === Status.SUCCESS, code: status, payload }),
    );
    return;
  }

  if (typeof payload === "string") {
    console.log(payload);
    return;
  }

  console.log(JSON.stringify(payload));
};

export const normalizePin = (pin: string) => {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error("PIN must be exactly 6 digits.");
  }
  return pin;
};

const isValidHost = (host: string) => {
  if (!host || /[\0]/.test(host)) return false;
  return host.length > 0 && !host.includes(" ");
};

export const sanitizeUrl = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Missing or invalid URL.");
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (!parsed.hostname) {
    throw new Error("Missing URL host.");
  }

  return trimmed;
};

const printCommandResult = (
  payload: unknown,
  status = Status.SUCCESS,
  forceJson = globalJsonOutput,
) => {
  toOutput(payload, status, forceJson);
};

const printEntries = (payload: Payload, forceJson = globalJsonOutput) => {
  if (payload.STATUS !== Status.SUCCESS) {
    throw new APWError(payload.STATUS);
  }

  const entries = payload.Entries.map((entry) => {
    if ("USR" in entry) {
      return {
        username: entry.USR,
        domain: entry.sites[0],
        password: entry.PWD || "Not Included",
      } as RenamedPasswordEntry;
    }

    if ("code" in entry) {
      return {
        username: entry.username,
        domain: entry.domain,
        code: entry.code || "Not Included",
      } as TOTPEntry;
    }

    return null;
  }).filter(Boolean);

  printCommandResult(
    { results: entries, status: "ok" },
    Status.SUCCESS,
    forceJson,
  );
};

const normalizeLookupCommand = (input: string) => {
  const url = sanitizeUrl(input);
  return url;
};

const ensureNumericPort = (value: string): number => {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error("Invalid port.");
  }
  return port;
};

export const createCLI = () => {
  const client = new ApplePasswordManager();

  const otp = new Command()
    .description("Interactively list accounts/OTPs.")
    .action(async () => {
      const action = await Select.prompt({
        message: "Choose an action: ",
        options: ["list OTPs", "get OTPs"],
      });

      const url = normalizeLookupCommand(
        await Input.prompt({
          message: "Enter URL: ",
        }),
      );

      if (action === "list OTPs") {
        printEntries(await client.listOTPForURL(url));
      } else {
        printEntries(await client.getOTPForURL(url));
      }
    })
    .command("get", "Get a OTP for a website.")
    .arguments("<url:string>")
    .action(async (_, url: string) => {
      printEntries(await client.getOTPForURL(normalizeLookupCommand(url)));
    })
    .command("list", "List available OTPs for a website.")
    .arguments("<url:string>")
    .action(async (_, url: string) => {
      printEntries(await client.listOTPForURL(normalizeLookupCommand(url)));
    });

  const pw = new Command()
    .description("Interactively list accounts/passwords.")
    .action(async () => {
      const action = await Select.prompt({
        message: "Choose an action: ",
        options: ["list accounts", "get password"],
      });

      const url = normalizeLookupCommand(
        await Input.prompt({
          message: "Enter URL: ",
        }),
      );

      if (action === "list accounts") {
        printEntries(await client.getLoginNamesForURL(url));
      } else {
        printEntries(await client.getPasswordForURL(url));
      }
    })
    .command("get", "Get a password for a website.")
    .arguments("<url:string> [username:string]")
    .action(async (_, url: string, username?: string) => {
      printEntries(
        await client.getPasswordForURL(normalizeLookupCommand(url), username),
      );
    })
    .command("list", "List available accounts for a website.")
    .arguments("<url:string>")
    .action(async (_, url: string) => {
      printEntries(
        await client.getLoginNamesForURL(normalizeLookupCommand(url)),
      );
    });

  const status = new Command()
    .description("Show daemon and session status.")
    .option("--json", "Machine-readable JSON output.")
    .action(async (options) => {
      const payload = await client.status();
      printCommandResult(
        payload,
        Status.SUCCESS,
        options.json ?? globalJsonOutput,
      );
    });

  const daemon = new Command()
    .description("Start the daemon.")
    .option("-p, --port <port:number>", "Port to listen on.", { default: 0 })
    .option("-b, --bind <bind:string>", "Bind host to listen on.", {
      default: "127.0.0.1",
    })
    .action((options) => {
      const host = options.bind?.trim();
      if (!isValidHost(host)) {
        throw new Error("Invalid bind host.");
      }

      const port = ensureNumericPort(String(options.port));
      return Daemon({ port, host });
    });

  const auth = new Command()
    .description("Authenticate CLI with daemon.")
    .option("-p, --pin <pin:string>", "Challenge PIN.")
    .action(async (options) => {
      const pin = options.pin
        ? normalizePin(String(options.pin))
        : normalizePin(
          await Input.prompt({
            message: "Enter PIN: ",
            validate: (value) => {
              return /^\d{6}$/.test(value)
                ? true
                : "PIN must be exactly 6 digits.";
            },
          }),
        );

      await client.requestChallenge();
      await client.verifyChallenge(pin);
      printCommandResult({ status: "ok" }, Status.SUCCESS);
    })
    .command("logout", "Erase local session credentials.")
    .action(async () => {
      await client.logout();
      printCommandResult({ status: "logged out" }, Status.SUCCESS);
    })
    .command("request", "Request a challenge from the daemon.")
    .action(async () => {
      await client.requestChallenge();
      const srpValues = client.session.returnValues();
      printCommandResult({
        salt: toBase64(srpValues.salt),
        serverKey: toBase64(srpValues.serverPublicKey),
        username: srpValues.username,
        clientKey: toBase64(srpValues.clientPrivateKey),
      }, Status.SUCCESS);
    })
    .command("response", "Respond to a challenge from the daemon.")
    .option("-p, --pin <pin>", "Challenge-response pin.", { required: true })
    .option("-s, --salt <salt>", "Request salt.", { required: true })
    .option("-sk, --serverKey <serverKey>", "Server public key.", {
      required: true,
    })
    .option("-ck, --clientKey <clientKey>", "Client public key.", {
      required: true,
    })
    .option("-u, --username <username>", "Client username.", {
      required: true,
    })
    .action(async (options) => {
      const { serverKey, salt, username, clientKey, pin } = options;
      const serverPublicKey = readBigInt(Buffer.from(serverKey, "base64"));
      const clientPrivateKey = readBigInt(Buffer.from(clientKey, "base64"));
      const saltResponse = readBigInt(Buffer.from(salt, "base64"));

      client.session.updateWithValues({
        username,
        salt: saltResponse,
        clientPrivateKey,
        serverPublicKey,
      });

      await client.verifyChallenge(normalizePin(pin));
      printCommandResult({ status: "ok" }, Status.SUCCESS);
    });

  return new Command()
    .name("apw")
    .version(`v${VERSION}`)
    .description("🔑 a CLI for Apple Passwords 🔒")
    .command("auth", auth)
    .command("pw", pw)
    .command("otp", otp)
    .command("start", daemon)
    .command("status", status);
};

export const handlePayload = async () => {
  try {
    await createCLI().parse(cliArgs);
  } catch (error: unknown) {
    let status = Status.GENERIC_ERROR;
    let msg = "Unknown Error";

    if (error instanceof APWError) {
      status = error.code;
      msg = error.message;
    } else if (error instanceof Error) {
      msg = error.message;
    }

    if (globalJsonOutput) {
      console.error(JSON.stringify({ ok: false, code: status, error: msg }));
      Deno.exit(status);
    }

    console.error(msg);
    Deno.exit(status);
  }
};

if (import.meta.main) {
  await handlePayload();
}

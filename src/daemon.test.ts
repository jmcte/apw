import { assertEquals, assertRejects } from "@std/assert";

import { readFramedResponse } from "./daemon.ts";

const makeStream = (chunks: Uint8Array[]) =>
  new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });

Deno.test("readFramedResponse enforces frame boundaries", async () => {
  const payload = JSON.stringify({ ok: true, payload: { value: "ok" } });
  const body = new TextEncoder().encode(payload);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, 4);

  const reader = makeStream([frame]).getReader();
  const output = await readFramedResponse(reader);
  assertEquals(output.toString("utf8"), payload);
});

Deno.test("readFramedResponse rejects oversized frames", async () => {
  const body = JSON.stringify({ value: "bad" });
  const frame = new Uint8Array(body.length + 4);
  new DataView(frame.buffer).setUint32(0, body.length + 1, true);
  frame.set(new TextEncoder().encode(body), 4);

  const reader = makeStream([frame]).getReader();
  await assertRejects(() => readFramedResponse(reader));
});

Deno.test("readFramedResponse rejects truncated frame payload", async () => {
  const body = new TextEncoder().encode(JSON.stringify({ value: "partial" }));
  const frame = new Uint8Array(4 + body.length - 1);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body.subarray(0, body.length - 1), 4);

  const reader = makeStream([frame]).getReader();
  await assertRejects(() => readFramedResponse(reader));
});

Deno.test("readFramedResponse rejects zero-length frames", async () => {
  const frame = new Uint8Array(4);
  new DataView(frame.buffer).setUint32(0, 0, true);
  const reader = makeStream([frame]).getReader();
  await assertRejects(() => readFramedResponse(reader));
});

Deno.test("readFramedResponse accepts chunked framing", async () => {
  const payload = JSON.stringify({ ok: true, payload: "chunked" });
  const body = new TextEncoder().encode(payload);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, 4);

  const chunks = [
    frame.slice(0, 2),
    frame.slice(2, frame.length - 1),
    frame.slice(frame.length - 1),
  ];
  const reader = makeStream(chunks).getReader();
  const output = await readFramedResponse(reader);
  assertEquals(output.toString("utf8"), payload);
});

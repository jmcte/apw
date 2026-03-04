import { assertEquals } from "@std/assert";

import {
  describeStatus,
  normalizeStatus,
  Status,
  statusText,
} from "./const.ts";

Deno.test("normalizeStatus maps known values and falls back safely", () => {
  assertEquals(normalizeStatus(Status.SUCCESS), Status.SUCCESS);
  assertEquals(normalizeStatus(999), Status.GENERIC_ERROR);
  assertEquals(normalizeStatus("1"), Status.GENERIC_ERROR);
});

Deno.test("describeStatus returns readable strings for known and unknown status", () => {
  assertEquals(
    describeStatus(Status.INVALID_SESSION),
    "Invalid session, reauthenticate with `apw auth`",
  );
  assertEquals(describeStatus(999), "A generic error occurred");
});

Deno.test("statusText returns fallback when unknown and mapped text otherwise", () => {
  assertEquals(statusText(Status.SUCCESS), "Operation successful");
  assertEquals(statusText(999, "fallback"), "A generic error occurred");
});

import assert = require("node:assert");
import { test } from "node:test";
import errorsModule = require("../server/errors");

const { messageOf } = errorsModule;

test("Error instances keep their plain message", () => {
  const error = Object.assign(new Error("Unknown item 'x'"), {
    code: "HMP_INVENTORY_ITEM_UNKNOWN",
  });
  assert.equal(messageOf(error), "Unknown item 'x'");
});

test("engine rejections print their code and message", () => {
  assert.equal(
    messageOf({ code: "PLAYER_DISCONNECTED", message: "Player is not connected" }),
    "PLAYER_DISCONNECTED: Player is not connected",
  );
});

test("a native apply failure names the rows that failed", () => {
  const rejection = {
    code: "NATIVE_APPLY_FAILED",
    message: "The client settled the inventory revision with native apply errors",
    requestedRevision: 3,
    appliedRevision: 3,
    applyErrors: [
      { itemId: "BroomDarkWizard1", holder: "BroomStorage", code: "UNEXPECTED_ROW" },
    ],
  };
  assert.equal(
    messageOf(rejection),
    "NATIVE_APPLY_FAILED: The client settled the inventory revision with native apply errors (BroomDarkWizard1@BroomStorage UNEXPECTED_ROW)",
  );
});

test("objects print whichever of code and message they carry", () => {
  assert.equal(messageOf({ code: "HMP_INVENTORY_NATIVE_UNAVAILABLE" }), "HMP_INVENTORY_NATIVE_UNAVAILABLE");
  assert.equal(messageOf({ message: "no result" }), "no result");
  assert.equal(messageOf({ revision: 4 }), '{"revision":4}');
});

test("non-objects fall back to String()", () => {
  assert.equal(messageOf("plain text"), "plain text");
  assert.equal(messageOf(undefined), "undefined");
});

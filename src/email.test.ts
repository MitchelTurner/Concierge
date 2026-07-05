import test from "node:test";
import assert from "node:assert/strict";
import { buildFallbackDraft, normalizeMessageId } from "./email.js";

test("buildFallbackDraft addresses the contact's first name and names the blocker", () => {
  const draft = buildFallbackDraft(
    { name: "Alex" },
    { name: "Joe's Pizza website" },
    { name: "Joe Rossi" },
    "photos of the finished kitchen"
  );
  assert.equal(draft.subject, "Quick nudge: photos of the finished kitchen for Joe's Pizza website");
  assert.match(draft.body, /^Hi Joe,/);
  assert.match(draft.body, /photos of the finished kitchen/);
  assert.match(draft.body, /Alex$/);
});

test("buildFallbackDraft works without a sender name", () => {
  const draft = buildFallbackDraft({ name: null }, { name: "Site" }, { name: "Joe" }, "the logo");
  assert.match(draft.body, /Thanks!$/);
});

test("normalizeMessageId strips angle brackets and case", () => {
  assert.equal(normalizeMessageId("<ABC@Mail.example>"), "abc@mail.example");
  assert.equal(normalizeMessageId("  <x@y> "), "x@y");
  assert.equal(normalizeMessageId(null), "");
});

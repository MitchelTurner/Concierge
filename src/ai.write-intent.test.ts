import test from "node:test";
import assert from "node:assert/strict";
import { messageRequestsWrite } from "./ai.js";

test("messageRequestsWrite detects create/save idea phrasing", () => {
  assert.equal(messageRequestsWrite("Create a newsletter idea with starter tasks and save it."), true);
  assert.equal(messageRequestsWrite("add this project"), true);
  assert.equal(messageRequestsWrite("Please save this idea to my list"), true);
  assert.equal(messageRequestsWrite("draft a project and save it"), true);
  assert.equal(messageRequestsWrite("Add a new project called Newsletter"), true);
});

test("messageRequestsWrite detects short affirmations and updates", () => {
  assert.equal(messageRequestsWrite("yes"), true);
  assert.equal(messageRequestsWrite("add those"), true);
  assert.equal(messageRequestsWrite("sounds good"), true);
  assert.equal(messageRequestsWrite("mark task 12 done"), true);
  assert.equal(messageRequestsWrite("remember that I only work after 8pm"), true);
});

test("messageRequestsWrite stays false for advice-only questions", () => {
  assert.equal(messageRequestsWrite("What should I focus on tonight?"), false);
  assert.equal(messageRequestsWrite("Rank my fast projects and tell me what to do."), false);
  assert.equal(messageRequestsWrite("How should I start my project tonight?"), false);
  assert.equal(messageRequestsWrite("How is my portfolio looking?"), false);
  assert.equal(messageRequestsWrite(""), false);
});

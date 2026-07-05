import test from "node:test";
import assert from "node:assert/strict";
import { matchOutreach } from "./inbox.js";
import type { OutreachWithContext } from "./db.js";

function outreach(overrides: Partial<OutreachWithContext>): OutreachWithContext {
  const base: OutreachWithContext = {
    id: 1,
    user_id: 1,
    project_id: 1,
    contact_id: 1,
    waiting_on: "photos",
    subject: "Quick nudge",
    body: "…",
    status: "sent",
    smtp_message_id: "<abc@concierge.example>",
    sent_at: "2026-07-05T10:00:00.000Z",
    replied_at: null,
    reply_snippet: null,
    created_at: "2026-07-05T09:00:00.000Z",
    updated_at: "2026-07-05T10:00:00.000Z",
    contact_name: "Joe",
    contact_email: "joe@pizza.com",
    project_name: "Joe's Pizza website",
  };
  return { ...base, ...overrides };
}

test("matches a reply via In-Reply-To even from a different address", () => {
  const sent = [outreach({})];
  const match = matchOutreach(sent, "joe.rossi@gmail.com", "<ABC@Concierge.example>", []);
  assert.equal(match?.id, 1);
});

test("falls back to sender address match", () => {
  const sent = [outreach({ id: 2, smtp_message_id: null })];
  assert.equal(matchOutreach(sent, "JOE@pizza.com", "", [])?.id, 2);
  assert.equal(matchOutreach(sent, "stranger@example.com", "", []), undefined);
});

test("prefers Message-ID match over address match", () => {
  const sent = [
    outreach({ id: 1, smtp_message_id: "<first@x>", contact_email: "joe@pizza.com" }),
    outreach({ id: 2, smtp_message_id: "<second@x>", contact_email: "joe@pizza.com" }),
  ];
  assert.equal(matchOutreach(sent, "joe@pizza.com", "<second@x>", [])?.id, 2);
});

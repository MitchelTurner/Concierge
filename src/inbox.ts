/**
 * Reply detection for client outreach — polls an IMAP inbox and matches new
 * mail against sent outreach:
 *
 *   1. strongest: In-Reply-To / References header contains our Message-ID
 *   2. fallback: sender address equals the contact's email
 *
 * On a match the outreach is marked 'replied' and the user is notified via
 * Telegram. The watcher only connects while there is sent outreach awaiting a
 * reply, reads the mailbox read-only, and tracks progress with a UID
 * watermark in app_meta so messages are never processed twice.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Config } from "./config.js";
import { isInboxConfigured, normalizeMessageId } from "./email.js";
import {
  getAllSentOutreach,
  getAppMeta,
  setAppMeta,
  updateOutreach,
  type OutreachWithContext,
} from "./db.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const WATERMARK_KEY = "inbox:lastuid";
const SNIPPET_LENGTH = 300;

export interface ReplyEvent {
  outreach: OutreachWithContext;
  /** Plain-text reply body (may be empty when only HTML/attachments). */
  replyText: string;
}

export type ReplyHandler = (event: ReplyEvent) => Promise<void>;

function snippetOf(text: string): string {
  const collapsed = text.replace(/\r/g, "").split(/\n-{2,}|\nOn .+ wrote:/)[0]!.trim();
  return collapsed.length > SNIPPET_LENGTH ? `${collapsed.slice(0, SNIPPET_LENGTH)}…` : collapsed;
}

/** Exported for tests. */
export function matchOutreach(
  sent: OutreachWithContext[],
  fromAddress: string,
  inReplyTo: string,
  references: string[]
): OutreachWithContext | undefined {
  const refs = new Set([inReplyTo, ...references].map(normalizeMessageId).filter(Boolean));
  const byMessageId = sent.find(
    (o) => o.smtp_message_id && refs.has(normalizeMessageId(o.smtp_message_id))
  );
  if (byMessageId) return byMessageId;

  const from = fromAddress.trim().toLowerCase();
  if (!from) return undefined;
  // Most recent sent outreach to that address.
  return sent.find((o) => o.contact_email.toLowerCase() === from);
}

async function pollOnce(config: Config, onReply: ReplyHandler): Promise<void> {
  const sent = await getAllSentOutreach();
  if (sent.length === 0) return; // nothing awaited — don't touch the mailbox

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.imapUser, pass: config.imapPass },
    logger: false,
  });

  await client.connect();
  try {
    const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });

    const stored = await getAppMeta(WATERMARK_KEY);
    let lastUid = stored ? Number(stored) : NaN;
    if (!Number.isFinite(lastUid)) {
      // First run: start from the current end of the mailbox, don't scan history.
      lastUid = Math.max(0, mailbox.uidNext - 1);
      await setAppMeta(WATERMARK_KEY, String(lastUid));
      return;
    }
    if (mailbox.uidNext - 1 <= lastUid) return; // nothing new

    let maxSeen = lastUid;
    for await (const msg of client.fetch(
      { uid: `${lastUid + 1}:*` },
      { uid: true, envelope: true },
      { uid: true }
    )) {
      if (msg.uid <= lastUid) continue; // IMAP ranges can echo the last message
      maxSeen = Math.max(maxSeen, msg.uid);

      const envelope = msg.envelope;
      if (!envelope) continue;
      const fromAddress = envelope.from?.[0]?.address ?? "";
      const inReplyTo = envelope.inReplyTo ?? "";

      const match = matchOutreach(sent, fromAddress, inReplyTo, []);
      if (!match) continue;

      let replyText = "";
      try {
        const { content } = await client.download(String(msg.uid), undefined, { uid: true });
        const parsed = await simpleParser(content);
        replyText = (parsed.text ?? "").trim();
      } catch (err) {
        console.error(`[inbox] failed to download/parse uid ${msg.uid}:`, err);
      }

      await updateOutreach(match.user_id, match.id, {
        status: "replied",
        replied_at: new Date().toISOString(),
        reply_snippet: replyText ? snippetOf(replyText) : null,
      });
      // Stop matching this outreach again within the same poll.
      sent.splice(sent.indexOf(match), 1);

      try {
        await onReply({ outreach: match, replyText });
      } catch (err) {
        console.error(`[inbox] reply notification failed for outreach #${match.id}:`, err);
      }
    }

    if (maxSeen > lastUid) {
      await setAppMeta(WATERMARK_KEY, String(maxSeen));
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Start polling the inbox. No-op (returns null) when IMAP is not configured. */
export function startInboxWatcher(
  config: Config,
  onReply: ReplyHandler
): NodeJS.Timeout | null {
  if (!isInboxConfigured(config)) {
    console.log("[inbox] reply detection disabled (set IMAP_HOST / IMAP_USER / IMAP_PASS)");
    return null;
  }

  const tick = () => {
    pollOnce(config, onReply).catch((err) => {
      console.error("[inbox] poll failed:", err instanceof Error ? err.message : err);
    });
  };

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[inbox] watching ${config.imapUser}@${config.imapHost} for client replies (every 5 min)`);
  return timer;
}

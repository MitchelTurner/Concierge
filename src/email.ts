/**
 * Outgoing email for client outreach — plain SMTP via nodemailer, so any
 * provider works (Gmail app password, Fastmail, Mailgun SMTP, …). Sending is
 * enabled when SMTP_HOST and SMTP_FROM are configured.
 */
import nodemailer from "nodemailer";
import type { Config } from "./config.js";
import type { Contact, Project, User } from "./db.js";

export function isEmailConfigured(config: Config): boolean {
  return config.smtpHost.length > 0 && config.smtpFrom.length > 0;
}

export function isInboxConfigured(config: Config): boolean {
  return config.imapHost.length > 0 && config.imapUser.length > 0;
}

export interface SentEmail {
  /** RFC Message-ID of the sent mail (used to match replies). */
  messageId: string;
}

export async function sendEmail(
  config: Config,
  to: string,
  subject: string,
  text: string
): Promise<SentEmail> {
  if (!isEmailConfigured(config)) {
    throw new Error("Email sending not configured (set SMTP_HOST and SMTP_FROM).");
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });

  const info = await transporter.sendMail({
    from: config.smtpFrom,
    to,
    subject,
    text,
  });

  return { messageId: info.messageId };
}

/**
 * Deterministic chase-up email used when the AI assistant is not configured
 * (or as a base the user can edit from Telegram).
 */
export function buildFallbackDraft(
  user: Pick<User, "name">,
  project: Pick<Project, "name">,
  contact: Pick<Contact, "name">,
  waitingOn: string
): { subject: string; body: string } {
  const firstName = contact.name.split(/\s+/)[0] || contact.name;
  const signature = user.name?.trim() || "Thanks!";

  const subject = `Quick nudge: ${waitingOn} for ${project.name}`;
  const body = [
    `Hi ${firstName},`,
    "",
    `Hope you're doing well! I'm ready to keep moving on ${project.name}, but I'm currently waiting on ${waitingOn}.`,
    "",
    "Could you send that over when you get a chance? It's the main thing holding up progress on my end.",
    "",
    "Thanks!",
    signature === "Thanks!" ? "" : signature,
  ]
    .join("\n")
    .trimEnd();

  return { subject, body };
}

/** Normalize a Message-ID for comparison (strip angle brackets and whitespace). */
export function normalizeMessageId(id: string | null | undefined): string {
  return (id ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
}

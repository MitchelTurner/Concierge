/**
 * Dashboard authentication — signup, login, bearer sessions.
 *
 * Passwords are bcrypt-hashed; sessions are opaque tokens stored in Postgres
 * with a 30-day expiry. resolveUserFromToken() backs the requireAuth middleware
 * in server.ts.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Config } from "./config.js";
import {
  createSession,
  createUser,
  deleteSession,
  getUserByEmail,
  getUserById,
  getUserIdBySessionToken,
  type User,
} from "./db.js";

const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PublicUser {
  id: number;
  email: string;
  name: string | null;
  telegram_linked: boolean;
  daily_time: string;
  checkin_time: string;
  timezone: string;
  stall_days: number;
  weekly_review_day: number;
  weekly_review_time: string;
  calendar_ics_url: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    telegram_linked: Boolean(user.telegram_chat_id),
    daily_time: user.daily_time,
    checkin_time: user.checkin_time,
    timezone: user.timezone,
    stall_days: user.stall_days,
    weekly_review_day: user.weekly_review_day,
    weekly_review_time: user.weekly_review_time,
    calendar_ics_url: user.calendar_ics_url,
  };
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function sessionExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_DAYS);
  return d;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validateEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return "Invalid email address.";
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  return null;
}

export async function signup(
  config: Config,
  email: string,
  password: string,
  name?: string | null
): Promise<{ user: PublicUser; token: string }> {
  const emailErr = validateEmail(email);
  if (emailErr) throw new AuthError(emailErr);
  const pwErr = validatePassword(password);
  if (pwErr) throw new AuthError(pwErr);

  const existing = await getUserByEmail(email);
  if (existing) throw new AuthError("An account with this email already exists.");

  const password_hash = await hashPassword(password);
  const user = await createUser({
    email,
    password_hash,
    name: name?.trim() || null,
    daily_time: config.defaultDailyTime,
    checkin_time: config.defaultCheckinTime,
    timezone: config.defaultTz,
    stall_days: config.defaultStallDays,
  });

  const token = generateSessionToken();
  await createSession(user.id, token, sessionExpiresAt());
  return { user: toPublicUser(user), token };
}

export async function login(
  email: string,
  password: string
): Promise<{ user: PublicUser; token: string }> {
  const user = await getUserByEmail(email);
  if (!user || !user.password_hash) throw new AuthError("Invalid email or password.");

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw new AuthError("Invalid email or password.");

  const token = generateSessionToken();
  await createSession(user.id, token, sessionExpiresAt());
  return { user: toPublicUser(user), token };
}

export async function logout(token: string): Promise<void> {
  await deleteSession(token);
}

export async function resolveUserFromToken(token: string): Promise<PublicUser | undefined> {
  const userId = await getUserIdBySessionToken(token);
  if (!userId) return undefined;
  const user = await getUserById(userId);
  return user ? toPublicUser(user) : undefined;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

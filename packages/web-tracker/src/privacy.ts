import { findCredentialLeak } from "@frontend-insight/event-contract/security";
import type { EventPayload, TrackerEvent } from "./types.js";

const customNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
const payloadKeyPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneLike = /^\+?[0-9][0-9\s()-]{7,}$/;

export function defaultNormalizePageRoute(url: URL): string {
  return url.pathname || "/";
}

export function normalizeAndValidatePageRoute(
  url: URL,
  normalize: ((url: URL) => string) | undefined,
): string | null {
  const pageRoute = (normalize ?? defaultNormalizePageRoute)(url);
  if (!pageRoute.startsWith("/") || pageRoute.length > 512) return null;
  if (/[?#]/.test(pageRoute)) return null;
  return pageRoute;
}

export function isSafeUserReference(value: string): boolean {
  if (!value || value.length > 128) return false;
  if (emailLike.test(value) || phoneLike.test(value)) return false;
  return findCredentialLeak({ userId: value }) === null;
}

export function normalizePayload(input: EventPayload = {}): EventPayload | null {
  const entries = Object.entries(input);
  if (entries.length > 12) return null;
  const output: EventPayload = {};
  for (const [key, value] of entries) {
    if (!payloadKeyPattern.test(key)) return null;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return null;
    }
    if (typeof value === "string" && value.length > 256) return null;
    output[key] = value;
  }
  return findCredentialLeak(output) === null ? output : null;
}

export function isValidCustomName(name: string): boolean {
  return customNamePattern.test(name);
}

const mutableBeforeSendFields = new Set(["pageRoute", "payload"]);

export function applyRestrictedBeforeSend(
  original: TrackerEvent,
  candidate: TrackerEvent | null,
): TrackerEvent | null {
  if (candidate === null) return null;
  for (const key of Object.keys(original) as Array<keyof TrackerEvent>) {
    if (mutableBeforeSendFields.has(key)) continue;
    if (candidate[key] !== original[key]) return null;
  }
  for (const key of Object.keys(candidate)) {
    if (!(key in original)) return null;
  }
  if (
    !candidate.pageRoute.startsWith("/") ||
    candidate.pageRoute.length > 512 ||
    /[?#]/.test(candidate.pageRoute)
  ) {
    return null;
  }
  if (findCredentialLeak(candidate.payload)) return null;
  return candidate;
}

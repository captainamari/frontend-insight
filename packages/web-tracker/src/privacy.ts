import { findCredentialLeak } from "@frontend-insight/event-contract/security";
import type { EventProperties, TrackerEvent } from "./types.js";

const eventNamePattern = /^(?!page_|feature_)[a-z][a-z0-9_]{0,63}$/;
const propertyKeyPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneLike = /^\+?[0-9][0-9\s()-]{7,}$/;

export function defaultNormalizeRoute(url: URL): string {
  return url.pathname || "/";
}

export function normalizeAndValidateRoute(
  url: URL,
  normalize: ((url: URL) => string) | undefined,
): string | null {
  const route = (normalize ?? defaultNormalizeRoute)(url);
  if (!route.startsWith("/") || route.length > 512) return null;
  if (route.includes("?") || route.includes("#")) return null;
  return route;
}

export function isSafeAccountReference(value: string): boolean {
  if (!value || value.length > 256) return false;
  if (emailLike.test(value) || phoneLike.test(value)) return false;
  return findCredentialLeak({ accountRef: value }) === null;
}

export function normalizeProperties(
  input: EventProperties = {},
): EventProperties | null {
  const entries = Object.entries(input);
  if (entries.length > 20) return null;
  const output: EventProperties = {};
  for (const [key, value] of entries) {
    if (!propertyKeyPattern.test(key)) return null;
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

export function isValidCustomEventName(name: string): boolean {
  return eventNamePattern.test(name);
}

const mutableBeforeSendFields = new Set(["route", "title", "properties"]);

export function applyRestrictedBeforeSend(
  original: TrackerEvent,
  candidate: TrackerEvent | null,
): TrackerEvent | null {
  if (candidate === null) return null;
  for (const key of Object.keys(original) as Array<keyof TrackerEvent>) {
    if (mutableBeforeSendFields.has(key)) continue;
    if (
      candidate[key] !== original[key] &&
      (key !== "breadcrumbs" ||
        JSON.stringify(candidate.breadcrumbs) !== JSON.stringify(original.breadcrumbs))
    ) {
      return null;
    }
  }
  for (const key of Object.keys(candidate)) {
    if (!(key in original)) return null;
  }
  const route = candidate.route;
  if (!route.startsWith("/") || route.length > 512 || /[?#]/.test(route)) return null;
  if (candidate.title !== undefined && candidate.title.length > 256) return null;
  const properties = normalizeProperties(candidate.properties);
  if (!properties) return null;
  for (const key of Object.keys(properties)) {
    if (!(key in original.properties)) return null;
  }
  return { ...candidate, properties };
}

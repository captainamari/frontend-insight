const REQUIRED_STRING_FIELDS = [
  "eventId",
  "eventType",
  "projectKey",
  "featureKey",
  "accountRef",
  "sessionId",
  "occurredAt",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateEventBatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "body must be a JSON object";
  }

  if (!Array.isArray(value.events) || value.events.length === 0) {
    return "events must be a non-empty array";
  }

  if (value.events.length > 100) {
    return "a batch may contain at most 100 events";
  }

  for (let index = 0; index < value.events.length; index += 1) {
    const event = value.events[index];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return `events[${index}] must be an object`;
    }

    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof event[field] !== "string" || event[field].trim() === "") {
        return `events[${index}].${field} must be a non-empty string`;
      }
    }

    if (!UUID.test(event.eventId)) {
      return `events[${index}].eventId must be a UUID`;
    }

    if (Number.isNaN(Date.parse(event.occurredAt))) {
      return `events[${index}].occurredAt must be an ISO-8601 timestamp`;
    }
  }

  return null;
}

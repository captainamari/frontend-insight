export function corsHeadersFor(origin, allowedOrigin) {
  if (!origin || origin !== allowedOrigin) {
    return null;
  }

  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

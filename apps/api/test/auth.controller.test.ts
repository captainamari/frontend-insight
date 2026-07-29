import "reflect-metadata";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/auth.controller.js";
import type { CoreService } from "../src/core.service.js";

const tokens = {
  accessToken: "access-token",
  accessTokenExpiresInSeconds: 900,
  refreshToken: "refresh-token",
  refreshTokenExpiresAt: "2026-08-05T00:00:00.000Z",
  principal: {
    userId: "admin",
    globalRole: "admin" as const,
    displayName: "Admin",
    email: "admin@example.invalid",
  },
};

function request(ip = "127.0.0.1"): FastifyRequest {
  return { ip } as FastifyRequest;
}

function response(): FastifyReply {
  return { header: vi.fn() } as unknown as FastifyReply;
}

function controller(login: ReturnType<typeof vi.fn>): AuthController {
  return new AuthController({
    auth: { login },
    environment: { REFRESH_COOKIE_SECURE: false },
  } as unknown as CoreService);
}

describe("login rate limiting", () => {
  it("does not accumulate successful logins", async () => {
    const target = controller(vi.fn(async () => tokens));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(
        target.login(
          { email: "admin@example.invalid", password: "correct" },
          request(),
          response(),
        ),
      ).resolves.toMatchObject({ accessToken: "access-token" });
    }
  });

  it("limits repeated failures per IP and normalized account", async () => {
    const target = controller(vi.fn(async () => null));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        target.login(
          { email: "ADMIN@example.invalid", password: "wrong" },
          request(),
          response(),
        ),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      target.login(
        { email: "admin@example.invalid", password: "wrong" },
        request(),
        response(),
      ),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      target.login(
        { email: "viewer@example.invalid", password: "wrong" },
        request(),
        response(),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});

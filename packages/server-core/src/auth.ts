import { createHash, randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import type { MySqlStore } from "./mysql-store.js";
import type { Principal } from "./model.js";

const accessTokenLifetimeSeconds = 15 * 60;
const refreshTokenLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  principal: Principal;
}

export class AuthManager {
  private readonly key: Uint8Array;

  constructor(
    private readonly store: MySqlStore,
    secret: string,
  ) {
    if (secret.length < 32) throw new Error("AUTH_TOKEN_SECRET_TOO_SHORT");
    this.key = new TextEncoder().encode(secret);
  }

  async bootstrapAdmin(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<string> {
    if ((await this.store.countUsers()) > 0)
      throw new Error("ADMIN_ALREADY_BOOTSTRAPPED");
    if (input.password.length < 12) throw new Error("PASSWORD_TOO_SHORT");
    return this.store.createLocalUser({
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      passwordHash: await hash(input.password, 12),
      globalRole: "admin",
    });
  }

  async createUser(
    actor: Principal,
    input: {
      email: string;
      displayName: string;
      password: string;
      globalRole: "admin" | "viewer";
    },
  ): Promise<Principal> {
    if (actor.globalRole !== "admin") throw new Error("ADMIN_REQUIRED");
    if (input.password.length < 12) throw new Error("PASSWORD_TOO_SHORT");
    const userId = await this.store.createLocalUser({
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      passwordHash: await hash(input.password, 12),
      globalRole: input.globalRole,
    });
    await this.store.audit({
      projectId: null,
      actorUserId: actor.userId,
      action: "user.created",
      entityType: "user",
      entityId: userId,
      metadata: { globalRole: input.globalRole },
    });
    const principal = await this.store.findPrincipal(userId);
    if (!principal) throw new Error("USER_NOT_FOUND");
    return principal;
  }

  async login(email: string, password: string): Promise<AuthTokens | null> {
    const found = await this.store.findLocalUser(email);
    if (!found || !(await compare(password, found.passwordHash))) return null;
    return this.issue({
      userId: found.userId,
      globalRole: found.globalRole,
      displayName: found.displayName,
      email: found.email,
    });
  }

  async refresh(refreshToken: string): Promise<AuthTokens | null> {
    const principal = await this.store.consumeSession(tokenHash(refreshToken));
    if (!principal) return null;
    return this.issue(principal);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.store.revokeSession(tokenHash(refreshToken));
  }

  async verifyAccessToken(token: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        audience: "frontend-insight-api",
        issuer: "frontend-insight",
      });
      if (payload.typ !== "access" || typeof payload.sub !== "string") return null;
      return this.store.findPrincipal(payload.sub);
    } catch {
      return null;
    }
  }

  private async issue(principal: Principal): Promise<AuthTokens> {
    const refreshToken = randomBytes(32).toString("base64url");
    const refreshTokenExpiresAt = new Date(Date.now() + refreshTokenLifetimeMs);
    await this.store.createSession({
      userId: principal.userId,
      refreshTokenHash: tokenHash(refreshToken),
      expiresAt: refreshTokenExpiresAt,
    });
    const accessToken = await new SignJWT({
      typ: "access",
      role: principal.globalRole,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(principal.userId)
      .setIssuer("frontend-insight")
      .setAudience("frontend-insight-api")
      .setIssuedAt()
      .setExpirationTime(`${accessTokenLifetimeSeconds}s`)
      .sign(this.key);
    return {
      accessToken,
      accessTokenExpiresInSeconds: accessTokenLifetimeSeconds,
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      principal,
    };
  }
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; startedAt: number }>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const timestamp = this.now();
    const current = this.windows.get(key);
    if (!current || timestamp - current.startedAt >= this.windowMs) {
      this.windows.set(key, { count: 1, startedAt: timestamp });
      return true;
    }
    if (current.count >= this.maximum) return false;
    current.count += 1;
    return true;
  }
}

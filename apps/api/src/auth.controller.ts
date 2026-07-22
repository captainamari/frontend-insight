import { FixedWindowRateLimiter } from "@frontend-insight/server-core";
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PublicRoute } from "./auth.guard.js";
import type { CoreService } from "./core.service.js";
import { parseInput } from "./http.js";

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

@Controller("api/auth")
export class AuthController {
  private readonly limiter = new FixedWindowRateLimiter(5, 15 * 60 * 1000);

  constructor(private readonly core: CoreService) {}

  @PublicRoute()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    if (!this.limiter.take(request.ip)) {
      throw new HttpException("LOGIN_RATE_LIMITED", 429);
    }
    const body = parseInput(loginSchema, rawBody);
    const tokens = await this.core.auth.login(body.email, body.password);
    if (!tokens) throw new HttpException("INVALID_CREDENTIALS", 401);
    response.header("set-cookie", this.refreshCookie(tokens.refreshToken));
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.accessTokenExpiresInSeconds,
      user: tokens.principal,
    };
  }

  @PublicRoute()
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    const refreshToken = cookieValue(request.headers.cookie, "fi_refresh");
    if (!refreshToken) throw new HttpException("REFRESH_TOKEN_MISSING", 401);
    const tokens = await this.core.auth.refresh(refreshToken);
    if (!tokens) throw new HttpException("REFRESH_TOKEN_INVALID", 401);
    response.header("set-cookie", this.refreshCookie(tokens.refreshToken));
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.accessTokenExpiresInSeconds,
      user: tokens.principal,
    };
  }

  @PublicRoute()
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<void> {
    const refreshToken = cookieValue(request.headers.cookie, "fi_refresh");
    if (refreshToken) await this.core.auth.logout(refreshToken);
    response.header("set-cookie", this.clearRefreshCookie());
  }

  private refreshCookie(token: string): string {
    const secure = this.core.environment.REFRESH_COOKIE_SECURE ? "; Secure" : "";
    return `fi_refresh=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict${secure}; Path=/api/auth; Max-Age=604800`;
  }

  private clearRefreshCookie(): string {
    const secure = this.core.environment.REFRESH_COOKIE_SECURE ? "; Secure" : "";
    return `fi_refresh=; HttpOnly; SameSite=Strict${secure}; Path=/api/auth; Max-Age=0`;
  }
}

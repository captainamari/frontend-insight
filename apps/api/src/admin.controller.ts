import type { Principal } from "@frontend-insight/server-core";
import { Body, Controller, Get, HttpException, Post } from "@nestjs/common";
import { z } from "zod";
import type { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";

const createUserSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(256),
  globalRole: z.enum(["admin", "viewer"]),
});

@Controller("api/admin")
export class AdminController {
  constructor(private readonly core: CoreService) {}

  @Get("users")
  listUsers(@CurrentPrincipal() principal: Principal) {
    this.requireAdmin(principal);
    return this.core.mysql.listUsers();
  }

  @Post("users")
  createUser(@Body() rawBody: unknown, @CurrentPrincipal() principal: Principal) {
    this.requireAdmin(principal);
    return this.core.auth.createUser(principal, parseInput(createUserSchema, rawBody));
  }

  private requireAdmin(principal: Principal): void {
    if (principal.globalRole !== "admin") {
      throw new HttpException("ADMIN_REQUIRED", 403);
    }
  }
}

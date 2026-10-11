import { HttpException, Inject, Injectable, SetMetadata } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CoreService } from "./core.service.js";
import type { AuthenticatedRequest } from "./http.js";

const publicRouteKey = "frontend-insight.public-route";
export const PublicRoute = () => SetMetadata(publicRouteKey, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(CoreService)
    private readonly core: CoreService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(publicRouteKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const diagnosticPath = request.url
      .split("?")[0]
      ?.match(
        /^\/api\/projects\/([0-9a-f-]{36})\/diagnostics(?:\/instances\/(evt_[A-Za-z0-9_-]{8,64}))?(?:\/|$)/i,
      );
    const denied = async () => {
      if (diagnosticPath)
        await this.core.diagnostics.audit(
          null,
          diagnosticPath[1]!,
          diagnosticPath[2] ?? "authentication",
          "diagnostics.read",
          "unauthenticated",
        );
    };
    if (!authorization?.startsWith("Bearer ")) {
      await denied();
      throw new HttpException("UNAUTHENTICATED", 401);
    }
    const principal = await this.core.auth.verifyAccessToken(authorization.slice(7));
    if (!principal) {
      await denied();
      throw new HttpException("SESSION_INVALID", 401);
    }
    request.principal = principal;
    return true;
  }
}

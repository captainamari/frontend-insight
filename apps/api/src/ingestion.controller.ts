import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Options,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicRoute } from "./auth.guard.js";
import { CoreService } from "./core.service.js";

@Controller("v1/events")
export class IngestionController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @PublicRoute()
  @Options()
  @HttpCode(204)
  options(
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ): void {
    if (origin) response.header("access-control-allow-origin", origin);
    response.header("vary", "Origin");
    response.header("access-control-allow-methods", "POST, OPTIONS");
    response.header("access-control-allow-headers", "Content-Type");
    response.header("access-control-max-age", "600");
  }

  @PublicRoute()
  @Post()
  @HttpCode(202)
  async ingest(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Headers("content-length") contentLength: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    if (origin) response.header("access-control-allow-origin", origin);
    response.header("vary", "Origin");
    return this.core.ingestion.accept(body, {
      origin,
      ip: request.ip,
      ...(contentLength ? { contentLength: Number(contentLength) } : {}),
    });
  }
}

import { IngestionError, type Principal } from "@frontend-insight/server-core";
import {
  Catch,
  createParamDecorator,
  HttpException,
  type ExceptionFilter,
} from "@nestjs/common";
import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

export type AuthenticatedRequest = FastifyRequest & { principal?: Principal };

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.principal) throw new HttpException("UNAUTHENTICATED", 401);
    return request.principal;
  },
);

export function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpException(
      {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }
  return result.data;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(cause: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    let statusCode = 500;
    let code = "INTERNAL_ERROR";
    let message = "Internal server error";
    let details: unknown;

    if (cause instanceof IngestionError) {
      statusCode = cause.statusCode;
      code = cause.code;
      message = cause.code;
      details = cause.details;
    } else if (cause instanceof HttpException) {
      statusCode = cause.getStatus();
      const body = cause.getResponse();
      if (typeof body === "string") {
        code = body;
        message = body;
      } else {
        const object = body as Record<string, unknown>;
        code = String(object.code ?? `HTTP_${statusCode}`);
        message = String(object.message ?? code);
        details = object.details;
      }
    } else if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "FST_ERR_CTP_BODY_TOO_LARGE"
    ) {
      statusCode = 413;
      code = "BATCH_TOO_LARGE";
      message = "Request body exceeds 64 KiB";
    } else if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ER_DUP_ENTRY"
    ) {
      statusCode = 409;
      code = "RESOURCE_CONFLICT";
      message = "A resource with the same unique key already exists";
    } else if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ER_NO_REFERENCED_ROW_2"
    ) {
      statusCode = 400;
      code = "RESOURCE_REFERENCE_INVALID";
      message = "A referenced resource does not exist";
    } else if (cause instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(cause.message)) {
      code = cause.message;
      message = cause.message;
      statusCode = cause.message.endsWith("NOT_FOUND") ? 404 : 400;
    }

    void response.status(statusCode).send({
      code,
      message,
      requestId: request.id,
      ...(details === undefined ? {} : { details }),
    });
  }
}

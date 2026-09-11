import "reflect-metadata";
import { loadApiEnvironment } from "@frontend-insight/shared-config";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";

export async function bootstrap(): Promise<NestFastifyApplication> {
  const environment = loadApiEnvironment();
  const adapter = new FastifyAdapter({
    bodyLimit: 64 * 1024,
    trustProxy: false,
    requestIdHeader: "x-request-id",
  });
  const nestOptions = environment.NODE_ENV === "test" ? { logger: false as const } : {};
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    nestOptions,
  );
  const fastify = adapter.getInstance();
  fastify.addHook("onRequest", (request, response, done) => {
    response.header("x-request-id", request.id);
    done();
  });
  app.enableShutdownHooks();
  await app.listen(environment.API_PORT, "0.0.0.0");
  return app;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  bootstrap().catch((cause) => {
    Logger.error(cause instanceof Error ? cause.message : String(cause), "bootstrap");
    process.exitCode = 1;
  });
}

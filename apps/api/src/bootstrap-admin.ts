import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { AuthManager, MySqlStore } from "@frontend-insight/server-core";
import { loadApiEnvironment } from "@frontend-insight/shared-config";
import { z } from "zod";

const inputSchema = z
  .object({
    email: z.string().trim().email().max(191),
    displayName: z.string().trim().min(1).max(120),
    // bcrypt only uses the first 72 bytes; reject truncation instead of accepting it.
    password: z
      .string()
      .min(12)
      .refine((value) => Buffer.byteLength(value) <= 72),
  })
  .strict();

async function readInput(): Promise<unknown> {
  if (process.argv.includes("--stdin-json")) {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 4096) throw new Error("BOOTSTRAP_INPUT_INVALID");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("BOOTSTRAP_INPUT_INVALID");
    }
  }
  if (process.argv.includes("--interactive") && process.stdin.isTTY) {
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    try {
      const email = await prompt.question("Admin email: ");
      const displayName = await prompt.question("Display name: ");
      process.stdout.write("Password (12+ characters, hidden): ");
      muted = true;
      const password = await prompt.question("");
      process.stdout.write("\nRepeat password: ");
      const repeated = await prompt.question("");
      process.stdout.write("\n");
      if (password !== repeated) throw new Error("BOOTSTRAP_PASSWORD_MISMATCH");
      return { email, displayName, password };
    } finally {
      prompt.close();
    }
  }
  // Preserve the existing development entrypoint; production uses stdin/TTY only.
  if (process.env.NODE_ENV !== "production")
    return {
      email: process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME ?? "Frontend Insight Admin",
    };
  throw new Error("BOOTSTRAP_STDIN_OR_INTERACTIVE_REQUIRED");
}

async function main() {
  const input = inputSchema.safeParse(await readInput());
  if (!input.success) throw new Error("BOOTSTRAP_INPUT_INVALID");
  const environment = loadApiEnvironment();
  const store = new MySqlStore(environment.MYSQL_URL);
  try {
    const connection = await store.pool.getConnection();
    try {
      const [rows] = await connection.query(
        "SELECT GET_LOCK('frontend-insight.bootstrap-admin', 10) AS acquired",
      );
      if ((rows as Array<{ acquired: number }>)[0]?.acquired !== 1)
        throw new Error("BOOTSTRAP_BUSY");
      const manager = new AuthManager(store, environment.AUTH_TOKEN_SECRET);
      const userId = await manager.bootstrapAdmin(input.data);
      await store.audit({
        projectId: null,
        actorUserId: userId,
        action: "user.bootstrapped",
        entityType: "user",
        entityId: userId,
        metadata: { source: "production-cli" },
      });
      console.log(JSON.stringify({ status: "created", userId }));
    } finally {
      await connection.query("DO RELEASE_LOCK('frontend-insight.bootstrap-admin')");
      connection.release();
    }
  } finally {
    await store.close();
  }
}

try {
  await main();
} catch (error) {
  const allowed = new Set([
    "ADMIN_ALREADY_BOOTSTRAPPED",
    "BOOTSTRAP_INPUT_INVALID",
    "BOOTSTRAP_PASSWORD_MISMATCH",
    "BOOTSTRAP_STDIN_OR_INTERACTIVE_REQUIRED",
    "BOOTSTRAP_BUSY",
  ]);
  const message =
    error instanceof Error && allowed.has(error.message)
      ? error.message
      : "BOOTSTRAP_FAILED";
  console.error(message);
  process.exitCode = 1;
}

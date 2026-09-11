import { AuthManager, MySqlStore } from "@frontend-insight/server-core";
import { loadApiEnvironment } from "@frontend-insight/shared-config";

const environment = loadApiEnvironment();
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const displayName =
  process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME ?? "Frontend Insight Admin";

if (!email || !password) {
  throw new Error("BOOTSTRAP_ADMIN_EMAIL_AND_PASSWORD_REQUIRED");
}

const store = new MySqlStore(environment.MYSQL_URL);
try {
  const manager = new AuthManager(store, environment.AUTH_TOKEN_SECRET);
  const userId = await manager.bootstrapAdmin({ email, password, displayName });
  console.log(JSON.stringify({ status: "created", userId, email }));
} finally {
  await store.close();
}

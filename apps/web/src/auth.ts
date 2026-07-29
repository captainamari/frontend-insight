import { computed, reactive } from "vue";
import { api } from "./api";
import type { User } from "./types";

const state = reactive<{
  user: User | null;
  initialized: boolean;
}>({
  user: null,
  initialized: false,
});

function persistUser(user: User | null): void {
  state.user = user;
  if (user) sessionStorage.setItem("fi.user", JSON.stringify(user));
  else sessionStorage.removeItem("fi.user");
}

window.addEventListener("fi:auth-refreshed", (event) => {
  persistUser((event as CustomEvent<User>).detail);
});
window.addEventListener("fi:auth-expired", () => persistUser(null));

export const auth = {
  state,
  isAuthenticated: computed(() => Boolean(state.user)),
  async initialize(): Promise<void> {
    if (state.initialized) return;
    try {
      const restored = await api.restore();
      persistUser(restored?.user ?? null);
    } catch {
      persistUser(null);
    } finally {
      state.initialized = true;
    }
  },
  async login(email: string, password: string): Promise<void> {
    const response = await api.login(email, password);
    persistUser(response.user);
  },
  async logout(): Promise<void> {
    await api.logout();
    persistUser(null);
  },
};

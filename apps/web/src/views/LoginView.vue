<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError } from "../api";
import { auth } from "../auth";
import { safeRedirectTarget } from "../project-entry";

const route = useRoute();
const router = useRouter();
const form = reactive({ email: "", password: "" });
const loading = ref(false);
const error = ref("");
const requestId = ref<string | null>(null);

async function submit(): Promise<void> {
  loading.value = true;
  error.value = "";
  requestId.value = null;
  try {
    await auth.login(form.email, form.password);
    const redirect = safeRedirectTarget(route.query.redirect, (path) => {
      const target = router.resolve(path);
      return (
        target.matched.length > 0 &&
        target.matched.every((record) => record.path !== "/:pathMatch(.*)*")
      );
    });
    await router.replace(redirect);
  } catch (cause) {
    const apiError = cause instanceof ApiError ? cause : null;
    error.value =
      apiError?.code === "INVALID_CREDENTIALS"
        ? "用户名或密码不正确"
        : apiError?.code === "LOGIN_RATE_LIMITED"
          ? "尝试次数过多，请 15 分钟后再试"
          : "暂时无法登录，请确认服务状态";
    requestId.value = apiError?.requestId ?? null;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-intro">
      <span class="brand-mark large" aria-hidden="true">FI</span>
      <p class="eyebrow">INTERNAL PRODUCT EVIDENCE</p>
      <h1>知道功能是否真正<br />被看见、使用和复用。</h1>
      <p>Frontend Insight 区分曝光、开始、成功和持续使用，为产品决策提供可解释证据。</p>
      <ul>
        <li>账号、浏览器、会话三种口径并列</li>
        <li>数据延迟与正常无访问明确区分</li>
        <li>默认不采集 token、查询参数或表单内容</li>
      </ul>
    </section>

    <section class="login-card" aria-labelledby="login-title">
      <div>
        <span class="eyebrow">安全登录</span>
        <h2 id="login-title">进入管理后台</h2>
        <p>使用本地管理员或只读查看者账号。</p>
      </div>

      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon>
        <template v-if="requestId" #default>请求 ID：{{ requestId }}</template>
      </el-alert>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="邮箱">
          <el-input
            v-model="form.email"
            type="email"
            autocomplete="username"
            placeholder="name@example.com"
            autofocus
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            autocomplete="current-password"
            show-password
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button
          class="full-width"
          type="primary"
          native-type="submit"
          :loading="loading"
          :disabled="!form.email || !form.password"
        >
          登录
        </el-button>
      </el-form>

      <p class="privacy-note">
        访问令牌仅保存在当前标签页会话；刷新令牌由 HttpOnly Cookie 管理。
      </p>
    </section>
  </main>
</template>

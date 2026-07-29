import { computed, ref, shallowRef } from "vue";
import type { ComputedRef, Ref, ShallowRef } from "vue";
import { ApiError } from "./api";

export interface RemoteData<T> {
  data: ShallowRef<T | null>;
  loading: Ref<boolean>;
  error: Ref<ApiError | null>;
  stale: ComputedRef<boolean>;
  load(loader: () => Promise<T>): Promise<T | null>;
}

export function useRemoteData<T>(): RemoteData<T> {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref<ApiError | null>(null);
  const stale = computed(() => Boolean(data.value && error.value));

  return {
    data,
    loading,
    error,
    stale,
    async load(loader: () => Promise<T>): Promise<T | null> {
      loading.value = true;
      error.value = null;
      try {
        const value = await loader();
        data.value = value;
        return value;
      } catch (cause) {
        error.value =
          cause instanceof ApiError
            ? cause
            : new ApiError(0, "NETWORK_ERROR", null, "无法连接到服务");
        return null;
      } finally {
        loading.value = false;
      }
    },
  };
}

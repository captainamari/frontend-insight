import type { EventPayload } from "./types.js";

/** Explicit counters only: this module never receives a form, DOM node or value. */
export interface FormDefinition {
  formId: string;
  fieldKeys: readonly string[];
}
export interface FormHandle {
  change(fieldKey: string): void;
  reset(): void;
  submit(): { validationFailed(): void };
  destroy(): void;
}
export interface FormCollectorConfig {
  enabled: boolean;
  definitions: readonly FormDefinition[];
  sampleRate?: number;
}
export const noopForm = (): FormHandle => ({
  change() {},
  reset() {},
  submit: () => ({ validationFailed() {} }),
  destroy() {},
});
export class FormCollector {
  private readonly active = new Map<string, FormHandle>();
  constructor(
    private readonly config: FormCollectorConfig | undefined,
    private readonly emit: (payload: EventPayload) => void,
    private readonly uuid: () => string,
    private readonly warn: (code: string) => void,
  ) {}
  track(formId: string): FormHandle {
    if (!this.config?.enabled) return noopForm();
    const existing = this.active.get(formId);
    if (existing) return existing;
    const definition = this.config.definitions.find((d) => d.formId === formId);
    const key = /^[a-z][a-z0-9_]{0,63}$/;
    if (
      !definition ||
      !key.test(formId) ||
      definition.fieldKeys.length > 50 ||
      definition.fieldKeys.some((f) => !key.test(f)) ||
      new Set(definition.fieldKeys).size !== definition.fieldKeys.length ||
      this.config.definitions.length > 50 ||
      this.active.size >= 10
    ) {
      this.warn("FORM_CONFIG_INVALID");
      return noopForm();
    }
    const rate = this.config.sampleRate ?? 1;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      this.warn("FORM_SAMPLE_INVALID");
      return noopForm();
    }
    const instance = this.uuid();
    if (parseInt(instance.replaceAll("-", "").slice(0, 8), 16) / 0x100000000 >= rate)
      return noopForm();
    const fields = new Set(definition.fieldKeys);
    let changes = 0,
      resets = 0,
      submits = 0,
      failures = 0,
      closed = false,
      overflow = false;
    const count = (kind: "change" | "reset" | "submit") => {
      if (closed) return false;
      if (changes + resets + submits >= 10000) {
        overflow = true;
        return false;
      }
      if (kind === "change") changes++;
      else if (kind === "reset") resets++;
      else submits++;
      return true;
    };
    const handle: FormHandle = Object.freeze({
      change: (field: string) => {
        if (fields.has(field)) count("change");
        else this.warn("FORM_FIELD_NOT_REGISTERED");
      },
      reset: () => {
        count("reset");
      },
      submit: () => {
        const accepted = count("submit");
        let failed = false;
        return Object.freeze({
          validationFailed: () => {
            if (accepted && !closed && !failed) {
              failed = true;
              failures++;
            }
          },
        });
      },
      destroy: () => {
        if (closed) return;
        closed = true;
        this.active.delete(formId);
        try {
          this.emit({
            name: "form_summary",
            formId,
            formInstanceId: `frm_${instance.replaceAll("-", "")}`,
            changeCount: changes,
            resetCount: resets,
            submitCount: submits,
            validationFailureCount: failures,
            counterOverflow: overflow,
            sampleRate: rate,
          });
        } catch {
          this.warn("FORM_EMIT_FAILED");
        }
      },
    });
    this.active.set(formId, handle);
    return handle;
  }
  settle(): void {
    for (const form of this.active.values()) form.destroy();
  }
}

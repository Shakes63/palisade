import type { PasswordFieldMeta } from "@ark/shared";

export function passwordTooShort(meta: PasswordFieldMeta, value: string): boolean {
  return Boolean(meta.show && meta.required) && value.length < (meta.minLength ?? 1);
}

export function PasswordFieldHelp({ meta, invalid }: { meta: PasswordFieldMeta; invalid: boolean }) {
  const min = meta.required && (meta.minLength ?? 1) > 1 ? `At least ${meta.minLength} characters.` : "";
  const text = [meta.help, min].filter(Boolean).join(" ");
  if (!text) return null;
  return <p className={`mt-1 text-xs ${invalid ? "text-rose-400" : "text-slate-500"}`}>{text}</p>;
}

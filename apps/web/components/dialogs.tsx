"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ToastKind = "success" | "error";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let openConfirm: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;
let pushToast: ((kind: ToastKind, message: string) => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return openConfirm ? openConfirm(opts) : Promise.resolve(false);
}

export const toast = {
  success: (message: string) => pushToast?.("success", message),
  error: (e: unknown) => pushToast?.("error", e instanceof Error ? e.message : String(e)),
};

export function DialogProvider() {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    openConfirm = (opts) =>
      new Promise<boolean>((resolve) =>
        setPending((prev) => {
          prev?.resolve(false);
          return { ...opts, resolve };
        }),
      );
    pushToast = (kind, message) => {
      const id = ++nextId.current;
      setToasts((t) => [...t, { id, kind, message }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
    };
    return () => {
      openConfirm = null;
      pushToast = null;
    };
  }, []);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <>
      {pending && <ConfirmModal opts={pending} onClose={close} />}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border bg-ark-panel px-3 py-2.5 text-sm shadow-xl ${
              t.kind === "error" ? "border-rose-900/60 text-rose-200" : "border-emerald-900/60 text-emerald-200"
            }`}
          >
            {t.kind === "error" ? (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            ) : (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            )}
            <span className="flex-1 whitespace-pre-line break-words">{t.message}</span>
            <button
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              className="text-slate-400 hover:text-slate-200"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function ConfirmModal({ opts, onClose }: { opts: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => trigger?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // stopPropagation keeps a host modal's own Escape listener from also firing.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(false);
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "Tab") {
      const buttons = [...(panel.current?.querySelectorAll("button") ?? [])];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.shiftKey ? i <= 0 : i === buttons.length - 1) {
        e.preventDefault();
        buttons[e.shiftKey ? buttons.length - 1 : 0].focus();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => onClose(false)}>
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md rounded-lg border bg-ark-panel p-5 shadow-xl outline-none ${
          opts.danger ? "border-rose-900/60" : "border-ark-border"
        }`}
      >
        <div className={`mb-3 flex items-center gap-2 ${opts.danger ? "text-rose-300" : "text-slate-100"}`}>
          {opts.danger && <AlertTriangle className="h-5 w-5 shrink-0" />}
          <h2 id="confirm-dialog-title" className="text-lg font-semibold">
            {opts.title}
          </h2>
        </div>
        {opts.body && <div className="whitespace-pre-line text-sm leading-snug text-slate-300">{opts.body}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button className={opts.danger ? "btn-danger" : "btn-primary"} onClick={() => onClose(true)}>
            {opts.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

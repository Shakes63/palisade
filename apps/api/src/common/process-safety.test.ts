import { describe, it, expect } from "vitest";
import { isRecoverable } from "./process-safety";

describe("isRecoverable", () => {
  it("treats background socket/network errors as recoverable", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]) {
      expect(isRecoverable(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("treats programmer errors / unknown throws as fatal (not recoverable)", () => {
    expect(isRecoverable(new TypeError("cannot read property of undefined"))).toBe(false);
    expect(isRecoverable(Object.assign(new Error("x"), { code: "ERR_SOMETHING" }))).toBe(false);
    expect(isRecoverable("a thrown string")).toBe(false);
    expect(isRecoverable(undefined)).toBe(false);
    expect(isRecoverable(null)).toBe(false);
  });
});

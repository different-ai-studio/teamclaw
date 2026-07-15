import { describe, expect, it } from "vitest";

describe("auth otp rules", () => {
  it("requires a 6-digit email code before verification", async () => {
    const { OTP_CODE_LENGTH, getOtpValidationError } = await import(
      "../features/onboarding/auth-otp"
    );

    expect(OTP_CODE_LENGTH).toBe(6);
    expect(getOtpValidationError("12345")).toBe("Enter the 6-digit code from your email.");
    expect(getOtpValidationError("123456")).toBeNull();
  });

  it("sanitizes pasted values down to numeric 6-digit input", async () => {
    const { OTP_CODE_LENGTH, sanitizeOtpInput } = await import(
      "../features/onboarding/auth-otp"
    );

    expect(sanitizeOtpInput("12a3 45-67")).toBe("123456");
    expect(sanitizeOtpInput("1234567890")).toHaveLength(OTP_CODE_LENGTH);
  });
});

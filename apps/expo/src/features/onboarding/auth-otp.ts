export const OTP_CODE_LENGTH = 6;

export function sanitizeOtpInput(value: string): string {
  return value.replace(/\D+/g, "").slice(0, OTP_CODE_LENGTH);
}

export function getOtpValidationError(value: string): string | null {
  return value.trim().length < OTP_CODE_LENGTH
    ? `Enter the ${OTP_CODE_LENGTH}-digit code from your email.`
    : null;
}

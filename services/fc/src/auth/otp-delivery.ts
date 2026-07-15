// OTP email delivery hook for Better-Auth's emailOTP plugin.
//
// The legacy flow relied on Supabase GoTrue's built-in SMTP — there is NO
// in-repo email sender.  Under BACKEND_KIND=postgres this function is
// responsible for delivering the 6-digit OTP code to the user.
//
// Required environment variables (all must be set before using postgres auth):
//   OTP_EMAIL_SMTP_HOST    — SMTP server hostname (e.g. "smtp.aliyun.com")
//   OTP_EMAIL_SMTP_PORT    — SMTP port (default: 465)
//   OTP_EMAIL_SMTP_SECURE  — "true" for TLS (default: "true")
//   OTP_EMAIL_SMTP_USER    — SMTP username / sender address
//   OTP_EMAIL_SMTP_PASS    — SMTP password
//   OTP_EMAIL_FROM         — From address shown to recipients (defaults to SMTP_USER)
//
// If none of these are configured the function throws with a clear message so
// that a misconfigured deploy fails loudly rather than silently dropping OTP
// emails (which would render auth unusable).

export async function sendOtpEmail({
  email,
  otp,
  type,
}: {
  email: string;
  otp: string;
  type: string;
}): Promise<void> {
  const host = process.env.OTP_EMAIL_SMTP_HOST;
  const user = process.env.OTP_EMAIL_SMTP_USER;
  const pass = process.env.OTP_EMAIL_SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      "otp_delivery_unconfigured: set OTP_EMAIL_SMTP_HOST, OTP_EMAIL_SMTP_USER, OTP_EMAIL_SMTP_PASS " +
        "(and optionally OTP_EMAIL_SMTP_PORT, OTP_EMAIL_SMTP_SECURE, OTP_EMAIL_FROM) " +
        "to enable email OTP delivery under BACKEND_KIND=postgres"
    );
  }

  const port = parseInt(process.env.OTP_EMAIL_SMTP_PORT ?? "465", 10);
  const secure = (process.env.OTP_EMAIL_SMTP_SECURE ?? "true") !== "false";
  const from = process.env.OTP_EMAIL_FROM ?? user;

  // Lazy-import nodemailer so this module can be imported without the package
  // being present in environments that never call sendOtpEmail (e.g. supabase
  // backend kind where this hook is never wired).
  // Use Function() to bypass static TS module resolution — nodemailer is an
  // optional runtime dep not listed in package.json until the ops team wires it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodemailer: any = await dynamicImport("nodemailer").catch(() => {
    throw new Error(
      "otp_delivery_unconfigured: nodemailer is not installed. " +
        "Run `npm install nodemailer` in services/fc to enable email OTP delivery."
    );
  });

  const transporter = nodemailer.default.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const actionLabel =
    type === "sign-in"
      ? "sign in"
      : type === "email-verification"
        ? "verify your email"
        : "continue";

  await transporter.sendMail({
    from,
    to: email,
    subject: `Your TeamClaw verification code: ${otp}`,
    text: `Your verification code to ${actionLabel} is: ${otp}\n\nThis code expires in 10 minutes.`,
    html: `<p>Your verification code to <strong>${actionLabel}</strong> is:</p>
<h2 style="letter-spacing:4px">${otp}</h2>
<p>This code expires in 10 minutes. Do not share it with anyone.</p>`,
  });
}

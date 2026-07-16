// AUTH_BASE_URL is the Better-Auth issuer/audience AND the origin of the JWKS
// endpoint tokens are verified against.
//
// It used to default to a hosted host that has since been deleted, so a blank
// env var meant minting tokens with a bogus issuer and fetching JWKS from a
// domain nobody controls — failing in a way that looks like a token bug. There
// is no sane default for "who issued this token", so fail closed.
export function authBaseURL(explicit?: string | null): string {
  const url = (explicit ?? process.env.AUTH_BASE_URL)?.trim();
  if (!url) {
    throw new Error(
      "AUTH_BASE_URL is not set. It is the JWT issuer/audience and the JWKS origin — set it explicitly (self-host: https://api.teamclaw-dev.ucar.cc).",
    );
  }
  return url;
}

#!/bin/sh
# teamclaw-askpass — GIT_ASKPASS helper for the custom_git credential bridge.
#
# Git invokes GIT_ASKPASS with a prompt like "Username for 'https://...':" or
# "Password for 'https://user@...':" on stdin. We ignore the prompt text and
# unconditionally print the credential value stored under
# `_git_credential.{TEAMCLAW_CREDENTIAL_REF}` in the local encrypted env_blob.
#
# Env contract (set by `team_share::custom_git::build_clone_command`):
#   TEAMCLAW_WORKSPACE      — absolute path to the workspace whose env_blob
#                             holds the credential.
#   TEAMCLAW_CREDENTIAL_REF — credential ref, e.g. `managed_git:t1` or
#                             `custom_git:t1`.
#
# Resolution: defers to `teamclaw-introspect get-credential` if present
# (sibling to this script, expected in production); otherwise emits a hint
# on stderr and exits non-zero so git surfaces a clear error.

set -eu

prompt="${1:-}"
case "$prompt" in
  Username*|username*)
    # For HTTPS tokens the username is conventionally `x-access-token` or
    # the literal token itself — `x-access-token` works for GitHub PATs,
    # GitLab deploy tokens, and most managed-git providers.
    printf '%s' 'x-access-token'
    exit 0
    ;;
esac

if [ -z "${TEAMCLAW_WORKSPACE:-}" ] || [ -z "${TEAMCLAW_CREDENTIAL_REF:-}" ]; then
  echo "teamclaw-askpass: TEAMCLAW_WORKSPACE / TEAMCLAW_CREDENTIAL_REF not set" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
introspect=""
for candidate in \
  "$script_dir/teamclaw-introspect" \
  "$script_dir/teamclaw-introspect-aarch64-apple-darwin" \
  "$script_dir/teamclaw-introspect-x86_64-apple-darwin"; do
  if [ -x "$candidate" ]; then
    introspect="$candidate"
    break
  fi
done

if [ -z "$introspect" ]; then
  echo "teamclaw-askpass: teamclaw-introspect sidecar not found next to $0" >&2
  exit 3
fi

exec "$introspect" get-credential \
  --workspace "$TEAMCLAW_WORKSPACE" \
  --ref "$TEAMCLAW_CREDENTIAL_REF"

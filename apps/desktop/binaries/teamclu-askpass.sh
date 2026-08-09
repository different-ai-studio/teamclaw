#!/bin/sh
# teamclu-askpass — GIT_ASKPASS helper for the custom_git credential bridge.
#
# Git invokes GIT_ASKPASS with a prompt like "Username for 'https://...':" or
# "Password for 'https://user@...':" on stdin. We ignore the prompt text and
# unconditionally print the credential value stored under
# `_git_credential.{TEAMCLU_CREDENTIAL_REF}` in the local encrypted env_blob.
#
# Env contract (set by `team_share::custom_git::build_clone_command`):
#   TEAMCLU_WORKSPACE      — absolute path to the workspace whose env_blob
#                             holds the credential.
#   TEAMCLU_CREDENTIAL_REF — credential ref, e.g. `managed_git:t1` or
#                             `custom_git:t1`.
#
# Resolution: defers to `teamclu-introspect get-credential` if present
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

if [ -z "${TEAMCLU_WORKSPACE:-}" ] || [ -z "${TEAMCLU_CREDENTIAL_REF:-}" ]; then
  echo "teamclu-askpass: TEAMCLU_WORKSPACE / TEAMCLU_CREDENTIAL_REF not set" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
introspect=""
for candidate in \
  "$script_dir/teamclu-introspect" \
  "$script_dir/teamclu-introspect-aarch64-apple-darwin" \
  "$script_dir/teamclu-introspect-x86_64-apple-darwin"; do
  if [ -x "$candidate" ]; then
    introspect="$candidate"
    break
  fi
done

if [ -z "$introspect" ]; then
  echo "teamclu-askpass: teamclu-introspect sidecar not found next to $0" >&2
  exit 3
fi

exec "$introspect" get-credential \
  --workspace "$TEAMCLU_WORKSPACE" \
  --ref "$TEAMCLU_CREDENTIAL_REF"

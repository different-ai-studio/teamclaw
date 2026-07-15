# TeamClaw shell integration (bash).
# Sourced via --rcfile from the Rust PTY launcher. Bash doesn't have
# preexec/precmd arrays, so we install cwd + exit-code reporting via
# PROMPT_COMMAND and rely on prompt-start/end markers around PS1.
# Command-line capture (OSC 633 ; E / ; C) is intentionally skipped —
# it's brittle in bash without bash-preexec, and cwd + exit code already
# carry most of the value for agent context.

# Source the user's real bashrc first.
if [ -f ~/.bashrc ]; then
  . ~/.bashrc
fi

__teamclaw_encode() {
  local s="$1" out="" i=0 c
  while [ "$i" -lt "${#s}" ]; do
    c="${s:$i:1}"
    case "$c" in
      '\') out+='\\\\' ;;
      ';') out+='\\x3b' ;;
      $'\n') out+='\\x0a' ;;
      $'\r') out+='\\x0d' ;;
      *) out+="$c" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$out"
}

__teamclaw_precmd() {
  local exit=$?
  printf '\e]633;D;%s\a' "$exit"
  printf '\e]633;P;Cwd=%s\a' "$(__teamclaw_encode "$PWD")"
}

# Append to PROMPT_COMMAND so any existing user logic still runs.
case ";$PROMPT_COMMAND;" in
  *";__teamclaw_precmd;"*) ;;
  *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__teamclaw_precmd" ;;
esac

# Wrap PS1 with prompt-start/end markers; \[...\] tells bash they are
# zero-width so line wrapping stays correct.
PS1="\[$(printf '\e]633;A\a')\]$PS1\[$(printf '\e]633;B\a')\]"

# Initial cwd announcement.
printf '\e]633;P;Cwd=%s\a' "$(__teamclaw_encode "$PWD")"

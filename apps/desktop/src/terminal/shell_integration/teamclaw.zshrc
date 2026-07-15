# TeamClaw shell integration (zsh).
# Sourced via ZDOTDIR override from the Rust PTY launcher. Restores the
# user's real ZDOTDIR, sources their .zshenv/.zshrc, then installs OSC 633
# hooks so the host can track cwd / command boundaries / exit codes.

# Restore user ZDOTDIR for normal zsh init.
if [[ -n "${TEAMCLAW_USER_ZDOTDIR-}" ]]; then
  ZDOTDIR="$TEAMCLAW_USER_ZDOTDIR"
else
  ZDOTDIR="$HOME"
fi
unset TEAMCLAW_USER_ZDOTDIR

# Source user's real rc files in the standard order.
if [[ -f "$ZDOTDIR/.zshrc" ]]; then
  source "$ZDOTDIR/.zshrc"
fi

# ---- OSC 633 encoders ----
# Escape \, ;, and newlines so the host parser can split fields safely.
__teamclaw_encode() {
  local s="$1"
  local out=""
  local i=1 c
  while (( i <= ${#s} )); do
    c="${s[$i]}"
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

__teamclaw_preexec() {
  printf '\e]633;E;%s\a' "$(__teamclaw_encode "$1")"
  printf '\e]633;C\a'
}

__teamclaw_precmd() {
  local exit=$?
  printf '\e]633;D;%s\a' "$exit"
  printf '\e]633;P;Cwd=%s\a' "$(__teamclaw_encode "$PWD")"
  printf '\e]633;A\a'
}

# Wrap the user's PS1 with prompt-start/end markers. %{...%} hides bytes
# from zsh's prompt width accounting.
PS1="%{$(printf '\e]633;A\a')%}$PS1%{$(printf '\e]633;B\a')%}"

typeset -ag preexec_functions precmd_functions
preexec_functions=(__teamclaw_preexec $preexec_functions)
precmd_functions=(__teamclaw_precmd $precmd_functions)

# Initial cwd announcement.
printf '\e]633;P;Cwd=%s\a' "$(__teamclaw_encode "$PWD")"

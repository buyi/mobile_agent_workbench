#!/bin/bash
# Creates the dedicated macOS accounts for the Loopit Worker (main spec §5.5, M0-F07):
#   loopit-worker  runs the Supervisor, Runtime and every sandboxed command
#   loopit-signer  owns signing identities; the worker can never read them
# Both are hidden, have no login shell and no password, and own private homes.
#
# Usage: sudo script/macos/setup-worker.sh [--dry-run]
# Idempotent: existing accounts and directories are checked, not recreated.
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

GROUP=loopit
BASE=/private/var/loopit
ACCOUNTS=(loopit-worker loopit-signer)

run() {
  if (( DRY_RUN )); then printf '+ %s\n' "$*"; else "$@"; fi
}

if (( ! DRY_RUN )); then
  [[ "$(uname -s)" == "Darwin" ]] || { echo "macOS only" >&2; exit 2; }
  [[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
fi

# Hidden service accounts use IDs below 500 so they stay off the login window.
free_id() {
  local kind=$1 attr=$2 id
  if (( DRY_RUN )); then echo "<next-free-id>"; return; fi
  for id in $(seq 420 499); do
    if ! dscl . -list "/$kind" "$attr" 2>/dev/null | awk '{print $2}' | grep -qx "$id"; then
      echo "$id"; return
    fi
  done
  echo "no free $kind id in 420-499" >&2; exit 1
}

exists() { (( ! DRY_RUN )) && dscl . -read "/$1/$2" >/dev/null 2>&1; }

if exists Groups "$GROUP"; then
  GID=$(dscl . -read "/Groups/$GROUP" PrimaryGroupID | awk '{print $2}')
  echo "group $GROUP exists (gid $GID)"
else
  GID=$(free_id Groups PrimaryGroupID)
  run dscl . -create "/Groups/$GROUP"
  run dscl . -create "/Groups/$GROUP" PrimaryGroupID "$GID"
  run dscl . -create "/Groups/$GROUP" RealName "Loopit Worker"
fi

run mkdir -p "$BASE"
run chown root:wheel "$BASE"
run chmod 755 "$BASE"

for account in "${ACCOUNTS[@]}"; do
  home="$BASE/${account#loopit-}"
  if exists Users "$account"; then
    echo "account $account exists"
  else
    uid=$(free_id Users UniqueID)
    run dscl . -create "/Users/$account"
    run dscl . -create "/Users/$account" UniqueID "$uid"
    run dscl . -create "/Users/$account" PrimaryGroupID "$GID"
    run dscl . -create "/Users/$account" RealName "Loopit ${account#loopit-}"
    run dscl . -create "/Users/$account" NFSHomeDirectory "$home"
    run dscl . -create "/Users/$account" UserShell /usr/bin/false
    run dscl . -create "/Users/$account" Password '*'
    run dscl . -create "/Users/$account" IsHidden 1
  fi
  run mkdir -p "$home"
  run chown "$account:$GROUP" "$home"
  # Private to the account: the worker cannot read the signer and vice versa.
  run chmod 700 "$home"
done

run mkdir -p "$BASE/worker/attempts"
run chown loopit-worker:"$GROUP" "$BASE/worker/attempts"
run chmod 700 "$BASE/worker/attempts"

# The operator's home is the second line of defence after Seatbelt's denyRead.
# macOS homes are 755 by default, so dotfiles such as ~/.config may be world-readable.
operator="${SUDO_USER:-}"
if [[ -n "$operator" && "$operator" != root ]] && (( ! DRY_RUN )); then
  op_home=$(dscl . -read "/Users/$operator" NFSHomeDirectory | awk '{print $2}')
  mode=$(stat -f '%Lp' "$op_home")
  if [[ "$mode" != 700 && "$mode" != 750 ]]; then
    echo "warning: $op_home is mode $mode; other accounts can list it." >&2
    echo "         Seatbelt still denies it, but for account isolation run: chmod 700 '$op_home'" >&2
  fi
  echo "export LOOPIT_OPERATOR_HOME=$op_home   # for the sandbox-contract suite"
fi

cat <<NEXT
done. The worker cannot read your home, so it needs its own toolchain and checkout:
  sudo -u loopit-worker -H /bin/bash -c 'curl -fsSL https://bun.sh/install | bash -s bun-v1.3.14'
  sudo -u loopit-worker -H git clone --recurse-submodules <repo-url> $BASE/worker/workbench
  sudo -u loopit-worker -H /bin/bash -c 'cd $BASE/worker/workbench/vendor/opencode && ~/.bun/bin/bun install --frozen-lockfile && cd ../.. && ~/.bun/bin/bun script/setup.ts'
Then run the conformance suite as the worker:
  sudo -u loopit-worker -H /bin/bash -c 'cd $BASE/worker/workbench && LOOPIT_OPERATOR_HOME=<your home> ~/.bun/bin/bun script/bench.ts verify --suite sandbox-contract'
NEXT

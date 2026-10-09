#!/bin/bash
# Inspect dedicated macOS accounts without changing the host by default.
# Usage: script/macos/setup-worker.sh [--audit | --dry-run | --apply]
# --apply must be explicitly run with sudo. It creates missing service accounts;
# existing records/homes must already satisfy the policy and are never repaired.
# No mode changes are made to the operator's home. Account metadata does not prove
# cross-account isolation; see packages/sandbox/test/seatbelt.darwin.test.ts.
set -euo pipefail

MODE=${1:---audit}
case "$MODE" in --audit|--dry-run|--apply) ;; *) echo "usage: $0 [--audit | --dry-run | --apply]" >&2; exit 2 ;; esac
[[ $# -le 1 ]] || { echo "too many arguments" >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo "macOS only" >&2; exit 2; }
if [[ "$MODE" == --apply && $EUID -ne 0 ]]; then echo "--apply requires sudo" >&2; exit 2; fi

GROUP=loopit
BASE=/private/var/loopit
ACCOUNTS=(loopit-worker loopit-signer)
MISSING=0
RESERVED_UIDS=" "
# macOS has no standard timeout command. alarm survives exec and bounds each probe.
bounded() { /usr/bin/perl -e 'alarm 5; exec @ARGV or die "$!\n"' -- "$@"; }
fail() { echo "blocked: $*; no automatic repair performed" >&2; exit 2; }
read_attr() { bounded /usr/bin/dscl . -read "$1" "$2" | /usr/bin/sed -E "s/^(dsAttrTypeNative:|dsAttrTypeStandard:)?$2:[[:space:]]*//"; }
exists() {
  local records
  records=$(bounded /usr/bin/dscl . -list "/$1") || fail "cannot enumerate $1; absence cannot be established"
  /usr/bin/grep -Fxq -- "$2" <<< "$records"
}
expect_attr() {
  local actual
  actual=$(read_attr "$1" "$2") || fail "cannot inspect $1 $2"
  [[ "$actual" == "$3" ]] || fail "$1 $2 differs from required value"
}
check_dir() {
  local path=$1 uid=$2 gid=$3 mode=$4 actual
  [[ -d "$path" && ! -L "$path" ]] || fail "$path is missing or is a symlink"
  actual=$(bounded /usr/bin/stat -f '%u:%g:%Lp' "$path") || fail "cannot inspect $path"
  [[ "$actual" == "$uid:$gid:$mode" ]] || fail "$path ownership/mode is $actual; required $uid:$gid:$mode"
  # ACL grants can bypass the mode bits. Existing homes must have no ACL entries.
  [[ "$(bounded /bin/ls -lde "$path" | /usr/bin/wc -l | /usr/bin/tr -d ' ')" == 1 ]] || fail "$path has ACL entries requiring manual review"
}
free_id() {
  local kind=$1 attr=$2 id records
  records=$(bounded /usr/bin/dscl . -list "/$kind" "$attr") || fail "cannot enumerate $kind"
  for ((id=420; id<500; id++)); do
    if ! /usr/bin/awk '{print $NF}' <<< "$records" | /usr/bin/grep -qx "$id" && [[ "$RESERVED_UIDS" != *" $id "* ]]; then
      echo "$id"; return
    fi
  done
  fail "no free $kind id in 420–499"
}
mutate() {
  if [[ "$MODE" == --dry-run ]]; then printf 'plan:'; printf ' %q' "$@"; printf '\n'
  elif [[ "$MODE" == --apply ]]; then bounded "$@"
  fi
}

if exists Groups "$GROUP"; then
  GID=$(read_attr "/Groups/$GROUP" PrimaryGroupID)
  [[ "$GID" =~ ^[0-9]+$ && $GID -ge 420 && $GID -lt 500 ]] || fail "group $GROUP is not a service group in 420–499"
else
  MISSING=1
  GID=$(free_id Groups PrimaryGroupID)
  echo "missing group $GROUP (proposed gid $GID)"
fi
# Validate all existing identities before making any account or directory changes.
for account in "${ACCOUNTS[@]}"; do
  worker_home="$BASE/${account#loopit-}"
  if exists Users "$account"; then
    uid=$(read_attr "/Users/$account" UniqueID)
    [[ "$uid" =~ ^[0-9]+$ && $uid -ge 420 && $uid -lt 500 ]] || fail "$account is not a service UID in 420–499"
    expect_attr "/Users/$account" PrimaryGroupID "$GID"
    expect_attr "/Users/$account" NFSHomeDirectory "$worker_home"
    expect_attr "/Users/$account" UserShell /usr/bin/false
    expect_attr "/Users/$account" Password '*'
    expect_attr "/Users/$account" IsHidden 1
    authority=$(bounded /usr/bin/dscl . -read "/Users/$account" AuthenticationAuthority 2>&1) || true
    [[ "$authority" == *"No such key: AuthenticationAuthority"* || "$authority" == *"eDSAttributeNotFound"* ]] || fail "$account authentication authority is present or cannot be inspected"
    groups=$(bounded /usr/bin/id -Gn "$account") || fail "cannot inspect $account groups"
    [[ " $groups " != *" admin "* && " $groups " != *" wheel "* ]] || fail "$account is in an administrator group"
    check_dir "$worker_home" "$uid" "$GID" 700
    echo "checked account $account attributes and home; access isolation remains unverified"
  elif [[ -e "$worker_home" || -L "$worker_home" ]]; then
    fail "$worker_home already exists without its expected account"
  else
    MISSING=1
    echo "missing account $account and private home"
  fi
done
[[ ! -e "$BASE" && ! -L "$BASE" ]] || check_dir "$BASE" 0 0 755
if [[ -d "$BASE/worker" && ! -x "$BASE/worker" ]]; then
  fail "cannot inspect private Worker home as uid $EUID; run the audit as administrator"
elif [[ -e "$BASE/worker/attempts" || -L "$BASE/worker/attempts" ]]; then
  check_dir "$BASE/worker/attempts" "$(read_attr /Users/loopit-worker UniqueID)" "$GID" 700
elif exists Users loopit-worker; then
  MISSING=1
  echo "missing worker attempts directory"
fi
if [[ "$MODE" == --audit ]]; then
  echo "audit only: no accounts, credentials, ownership or permissions changed"
  if (( MISSING )); then exit 2; fi
  exit 0
fi

if ! exists Groups "$GROUP"; then
  mutate /usr/bin/dscl . -create "/Groups/$GROUP"
  mutate /usr/bin/dscl . -create "/Groups/$GROUP" PrimaryGroupID "$GID"
  mutate /usr/bin/dscl . -create "/Groups/$GROUP" RealName 'Loopit Worker'
fi
if [[ ! -d "$BASE" ]]; then
  mutate /bin/mkdir -p "$BASE"
  mutate /usr/sbin/chown root:wheel "$BASE"
  mutate /bin/chmod 755 "$BASE"
fi
for account in "${ACCOUNTS[@]}"; do
  worker_home="$BASE/${account#loopit-}"
  if ! exists Users "$account"; then
    uid=$(free_id Users UniqueID)
    RESERVED_UIDS+="$uid "
    mutate /usr/bin/dscl . -create "/Users/$account"
    mutate /usr/bin/dscl . -create "/Users/$account" UniqueID "$uid"
    mutate /usr/bin/dscl . -create "/Users/$account" PrimaryGroupID "$GID"
    mutate /usr/bin/dscl . -create "/Users/$account" RealName "Loopit ${account#loopit-}"
    mutate /usr/bin/dscl . -create "/Users/$account" NFSHomeDirectory "$worker_home"
    mutate /usr/bin/dscl . -create "/Users/$account" UserShell /usr/bin/false
    mutate /usr/bin/dscl . -create "/Users/$account" Password '*'
    mutate /usr/bin/dscl . -create "/Users/$account" IsHidden 1
    mutate /bin/mkdir "$worker_home"
    mutate /usr/sbin/chown "$account:$GROUP" "$worker_home"
    mutate /bin/chmod 700 "$worker_home"
  fi
done
if [[ ! -e "$BASE/worker/attempts" && ! -L "$BASE/worker/attempts" ]]; then
  mutate /bin/mkdir "$BASE/worker/attempts"
  mutate /usr/sbin/chown "loopit-worker:$GROUP" "$BASE/worker/attempts"
  mutate /bin/chmod 700 "$BASE/worker/attempts"
elif [[ "$MODE" == --apply ]]; then
  check_dir "$BASE/worker/attempts" "$(read_attr /Users/loopit-worker UniqueID)" "$GID" 700
fi

cat <<'NEXT'
The operator's home has not been changed and is not automatically protected.
Give the Worker its own toolchain/checkout. Do not make an operator checkout public.
Run sandbox-contract as the Worker after provisioning, with owner-readable,
non-secret isolation fixtures explicitly supplied via LOOPIT_OPERATOR_USER,
LOOPIT_OPERATOR_PROBE_FILE, and LOOPIT_SIGNER_PROBE_FILE. The account cases require
an independent successful owner-side read and an actual Worker refusal. Missing
fixtures or baseline permissions remain notRun; do not grant Worker general sudo
rights just to make the tests run. Provision an external privileged test harness
for those baselines or leave account isolation unverified.
Public TCP baselines and account isolation are required separate checks: passing
local Seatbelt cases does not make the complete sandbox-contract suite pass.
NEXT

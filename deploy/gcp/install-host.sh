#!/usr/bin/env bash
set -euo pipefail

release_script=${1:?Provide the path to release.py}
public_key_file=${2:?Provide the dedicated SSH public key path}
read -r public_key < "$public_key_file"
if [[ ! "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]]; then
  printf '%s\n' 'Expected an Ed25519 SSH public key' >&2
  exit 1
fi

account=yuvomi-deploy
if ! id "$account" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/sh "$account"
fi

install -o root -g root -m 0755 "$release_script" /usr/local/sbin/yuvomi-release.py
wrapper=$(mktemp)
sudoers=$(mktemp)
trap 'rm -f "$wrapper" "$sudoers"' EXIT
printf '%s\n' '#!/bin/sh' 'exec /usr/bin/python3 -I /usr/local/sbin/yuvomi-release.py' > "$wrapper"
install -o root -g root -m 0755 "$wrapper" /usr/local/sbin/yuvomi-release
printf '%s\n' 'yuvomi-deploy ALL=(root) NOPASSWD: /usr/local/sbin/yuvomi-release ""' > "$sudoers"
visudo -cf "$sudoers"
install -o root -g root -m 0440 "$sudoers" /etc/sudoers.d/yuvomi-deploy

home_dir=$(getent passwd "$account" | cut -d: -f6)
install -d -o root -g root -m 0755 "$home_dir" "$home_dir/.ssh"
printf 'restrict,from="35.235.240.0/20",command="/usr/bin/sudo -n /usr/local/sbin/yuvomi-release" %s\n' "$public_key" |
  install -o root -g root -m 0644 /dev/stdin "$home_dir/.ssh/authorized_keys"

printf 'yuvomi '
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub

#!/bin/sh
# Cinba Linux Headless acceptance probe. Runs as root inside a throwaway, network-less container
# and drives everything as an ordinary user. Archive and SHA256SUMS are mounted at /probe.
set -u
ARCHIVE=$(cd /probe && ls Cinba-*-linux-x64-gnu.tar.gz | head -1)
U=tester
step() { printf '\n===== %s\n' "$*"; }
as_user() { su - "$U" -c "$*" 2>&1; echo "[exit=$?]"; }
cinba_procs() {
  for p in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
    case "$cmd" in *cinba*|*core.mjs*|*sync.mjs*|*tui.mjs*) echo "  pid ${p#/proc/}: $cmd" ;; esac
  done
}

step "system"
. /etc/os-release; echo "$PRETTY_NAME"; ldd --version 2>&1 | head -1; uname -r
echo "network interfaces: $(ls /sys/class/net | tr '\n' ' ')"
getent hosts github.com >/dev/null 2>&1 && echo "DNS works (unexpected)" || echo "no DNS/network (expected)"
for t in node npm git pi curl; do command -v "$t" >/dev/null 2>&1 && echo "  has $t" || echo "  no $t"; done

useradd -m -s /bin/bash "$U"
snapshot() { find / -xdev \( -path /proc -o -path /sys -o -path /tmp -o -path /home -o -path /dev -o -path /run -o -path /var/log \) -prune -o -type f -printf '%p %T@ %s\n' 2>/dev/null | sort; }
snapshot > /tmp/fs-before

step "verify archive"
cd /probe && sha256sum -c SHA256SUMS --ignore-missing 2>&1 | grep linux

step "root refusal"
mkdir -p /tmp/rootx && tar -xzf "/probe/$ARCHIVE" -C /tmp/rootx && /tmp/rootx/install.sh; echo "[exit=$?]"

step "install as ordinary user (offline)"
as_user "mkdir -p ~/dl && tar -xzf /probe/$ARCHIVE -C ~/dl && ~/dl/install.sh"

step "nothing auto-started after install"
cinba_procs; echo "  (end of process list)"

step "files written outside the user home since install started"
snapshot | diff /tmp/fs-before - | head -20
echo "  (end)"

step "installed layout"
as_user 'ls -la ~/.local/bin/ 2>&1; readlink -f ~/.local/bin/cinba; ls ~/.local/share/cinba ~/.local/state/cinba 2>&1 | head; grep -n -i cinba ~/.bashrc ~/.profile ~/.zshrc 2>/dev/null'

step "new login shell resolves cinba"
as_user 'command -v cinba; cinba version'
step "doctor"
as_user 'cinba doctor'
step "help"
as_user 'cinba help | head -30'

step "default TUI starts (pty, 8s)"
su - "$U" -c 'TERM=xterm-256color COLUMNS=120 LINES=30 timeout 8 script -qec cinba /dev/null' 2>&1 | tr -d '\033' | sed 's/\[[0-9;?]*[a-zA-Z]//g' | tr -s ' ' | grep -a -E 'Cinba|Type and press|for commands|error|Error' | head -8
echo "[tui done]"; sleep 1; cinba_procs

step "on-demand core start/status/stop"
as_user 'cinba core start; cinba core status'
cinba_procs
as_user 'cinba core stop; cinba core status'

step "core/sync modes"
as_user 'cinba core mode; cinba sync mode'
step "background core without systemd --user (expect clear diagnostic, no false success)"
as_user 'cinba core mode background'
as_user 'cinba core mode'
as_user 'cinba core mode on-demand'

step "update check offline (expect clear failure)"
as_user 'timeout 60 cinba update'

step "no external infra touched"
for f in /usr/bin/tailscale /usr/sbin/tailscaled /usr/bin/caddy /etc/caddy /etc/systemd/system/cinba*; do [ -e "$f" ] && echo "  present: $f"; done; echo "  (end)"

step "normal uninstall keeps data"
as_user 'echo marker > ~/.local/share/cinba/data/probe-marker.txt 2>/dev/null || find ~/.local/share/cinba -maxdepth 2; find ~/.local/share/cinba -type f | sort | xargs sha256sum > /tmp/data-before.txt 2>/dev/null; cinba uninstall'
sleep 5
as_user 'command -v cinba; ls ~/.local/bin 2>&1; ls -d ~/.local/share/cinba ~/.local/state/cinba 2>&1; grep -n -i cinba ~/.bashrc ~/.profile 2>/dev/null; find ~/.local/share/cinba -type f | sort | xargs sha256sum | diff /tmp/data-before.txt - && echo "data unchanged"'
cinba_procs

step "reinstall restores"
as_user "~/dl/install.sh >/dev/null 2>&1; cinba version; cat ~/.local/share/cinba/data/probe-marker.txt"

step "purge: non-interactive without flag refused"
as_user 'cinba uninstall --purge </dev/null'
step "purge with explicit flag"
as_user 'cinba uninstall --purge --delete-all-cinba-data'
sleep 5
as_user 'command -v cinba; ls -la ~/.local/bin 2>&1; ls -d ~/.local/share/cinba ~/.local/state/cinba ~/.cache/cinba ~/.config/cinba 2>&1; grep -n -i cinba ~/.bashrc ~/.profile 2>/dev/null; ls -a ~'
cinba_procs
step "done"

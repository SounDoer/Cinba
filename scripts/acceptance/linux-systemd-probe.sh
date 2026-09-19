#!/bin/bash
# Cinba Headless probe on a systemd host (container with systemd as PID 1, no network).
# Usage: systemd-probe.sh <phase>   phase = before-reboot | after-reboot | teardown
set -u
ARCHIVE=$(cd /probe && ls Cinba-*-linux-x64-gnu.tar.gz | head -1)
U=tester
UID_=$(id -u "$U")
step() { printf '\n===== %s\n' "$*"; }
# Run as the user in a real PAM login session, so pam_systemd sets XDG_RUNTIME_DIR/DBus.
u() { su - "$U" -c "$*" 2>&1; echo "[exit=$?]"; }
listening() { for p in 4517 4518; do (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && echo "  port $p: listening" || echo "  port $p: closed"; done; }
units() { ls -la "/home/$U/.config/systemd/user/" 2>&1 | grep -i cinba || echo "  (no cinba user units)"; }
usermgr() { systemctl is-active "user@$UID_.service" 2>&1; loginctl show-user "$U" -p Linger -p State 2>&1; }

case "${1:-}" in
before-reboot)
  step "system"; . /etc/os-release; echo "$PRETTY_NAME"; systemctl is-system-running
  loginctl show-user "$U" -p Linger 2>&1 || echo "  (tester not logged in; linger off)"

  step "install (offline)"
  u "mkdir -p ~/dl && tar -xzf /probe/$ARCHIVE -C ~/dl && ~/dl/install.sh"
  step "doctor"; u 'cinba doctor'
  step "core mode (default)"; u 'cinba core mode'

  step "background without linger (expect understandable diagnostic, no false success)"
  u 'cinba core mode background </dev/null'
  u 'cinba core mode'
  units; listening

  step "background without linger, interactive terminal, user declines the linger request"
  su - "$U" -c 'printf "n\n" | script -qec "cinba core mode background" /dev/null' 2>&1 | tr -d '\r' | tail -8
  u 'cinba core mode'
  units; listening

  step "enable linger as admin (what the product may request), then background"
  loginctl enable-linger "$U"; usermgr
  u 'cinba core mode on-demand >/dev/null 2>&1; cinba core mode background'
  u 'cinba core mode; cinba core status; cinba doctor'
  units; listening
  u 'systemctl --user status "cinba*" --no-pager 2>&1 | head -15'

  step "logout (SSH disconnect): core keeps running"
  sleep 3; loginctl list-sessions --no-legend; usermgr; listening
  ;;
after-reboot)
  step "after reboot: core restored per mode"
  systemctl is-system-running
  sleep 5; usermgr; listening
  u 'cinba core mode; cinba core status'

  step "switch back to on-demand"
  u 'cinba core mode on-demand; cinba core mode'
  units; listening

  step "background again, then normal uninstall"
  u 'cinba core mode background >/dev/null; echo marker > ~/.local/share/cinba/data/probe-marker.txt; find ~/.local/share/cinba -type f | sort | xargs sha256sum > /tmp/data-before.txt'
  units; listening
  u 'cinba uninstall'
  sleep 8
  u 'command -v cinba; ls ~/.local/bin; ls -d ~/.local/lib/cinba ~/.local/share/cinba ~/.local/state/cinba 2>&1; grep -c "Cinba CLI" ~/.bashrc; find ~/.local/share/cinba -type f | sort | xargs sha256sum | diff /tmp/data-before.txt - && echo "data unchanged"'
  units; listening
  step "linger left as-is (account-wide, spec says do not disable)"; loginctl show-user "$U" -p Linger

  step "reinstall restores; purge removes everything"
  u "~/dl/install.sh >/dev/null 2>&1; cinba version; cat ~/.local/share/cinba/data/probe-marker.txt; cinba core mode"
  u 'cinba uninstall --purge --delete-all-cinba-data'
  sleep 8
  u 'command -v cinba; ls -la ~/.local/bin 2>&1; ls -d ~/.local/lib/cinba ~/.local/share/cinba ~/.local/state/cinba ~/.cache/cinba ~/.config/cinba 2>&1; grep -c "Cinba CLI" ~/.bashrc'
  units; listening
  ;;
esac
step "done ${1:-}"

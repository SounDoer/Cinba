FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session libpam-systemd procps \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-resolved.service systemd-networkd.service systemd-timesyncd.service getty@tty1.service console-getty.service \
 && useradd -m -s /bin/bash tester
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

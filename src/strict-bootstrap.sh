#!/usr/bin/bash
# Trusted bootstrap only. All inputs are positional argv from strict.js, never
# shell fragments. Every failure stops before executing the workload.
set -euo pipefail
rootfs=$1
cwd=$2
work=$3
count=$4
shift 4
mount=/usr/bin/mount
$mount -t tmpfs -o mode=0755,size=64m,nosuid,nodev tmpfs "$rootfs"
for ((i=0; i<count; i++)); do
  mode=$1; source=$2; destination=$3; shift 3
  /usr/bin/mkdir -p -- "$rootfs$destination"
  $mount --bind "$source" "$rootfs$destination"
  $mount -o "remount,bind,$mode,nosuid,nodev" "$rootfs$destination"
done
/usr/bin/mkdir -p -- "$rootfs/proc" "$rootfs/dev"
# No procfs is exposed. Namespace init remains PID 1 without a host-process view.
# Minimal device access, not a bind of the host's /dev or its terminal sockets.
for device in null zero random urandom; do
  /usr/bin/touch -- "$rootfs/dev/$device"
  $mount --bind "/dev/$device" "$rootfs/dev/$device"
done
/usr/bin/ln -s -- /proc/self/fd "$rootfs/dev/fd"
/usr/bin/ln -s -- /proc/self/fd/0 "$rootfs/dev/stdin"
/usr/bin/ln -s -- /proc/self/fd/1 "$rootfs/dev/stdout"
/usr/bin/ln -s -- /proc/self/fd/2 "$rootfs/dev/stderr"
/usr/bin/ln -s -- "$work/tmp" "$rootfs/tmp"
$mount -o remount,bind,ro,nosuid,nodev "$rootfs"
count=$1; shift
[[ $1 == -- && $# -gt 1 ]]
shift
# PID 1 and all in-namespace supervisors share the same chroot; /proc is empty.
# FD 3 carries environment values, not filesystem authority. It is consumed only
# after isolation and capability dropping, then closed before the workload.
# A fixed privileged-mode Bash disables BASH_ENV/functions; no argv is evaluated.
exec /usr/sbin/chroot "$rootfs" /usr/bin/setpriv --no-new-privs \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /usr/bin/env -i --default-signal -- PATH=/usr/bin:/bin LANG=C /usr/bin/tini -g -- \
  /usr/bin/bash --noprofile --norc -p -c '
    set -e
    count=$1; cwd=$2; shift 2
    for ((i=0; i<count; i++)); do
      IFS= read -r -d "" entry <&3
      export "$entry"
    done
    exec 3<&-
    cd -- "$cwd"
    printf R >&4
    exec 4>&-
    exec -- "$@"
  ' strict "$count" "$cwd" "$@"

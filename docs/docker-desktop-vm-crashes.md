# Docker Desktop VM crashes triggered by Ignite

**Status:** mitigated (2026-06-12); fallback design documented below if crashes recur.

## Symptom

Docker Desktop (macOS, Apple Silicon) dies while Ignite is in use: every
`docker` command fails with `Cannot connect to the Docker daemon`, the docker
socket (`/var/run/docker.sock` and `~/.docker/run/docker.sock`) disappears,
and `com.docker.backend` is still running but unresponsive. Only restarting
Docker Desktop recovers it.

## Root cause

It is not a Docker Desktop app crash — the **Linux kernel inside Docker
Desktop's VM panics**, and the crash detector then shuts the backend down.
Captured from `~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log.*`
on 2026-06-12 (Docker Desktop 4.46.0, kernel 6.10.14-linuxkit):

```
fatal error reported: Linux kernel v6.10.14 crash on virtualization.framework
Internal error: Oops - BUG
Modules linked in: shiftfs(O) selfowner(O) rosetta(O) grpcfuse(O) fakeowner(O)
Call trace: generic_shutdown_super → kill_anon_super → deactivate_super → cleanup_mnt
```

The oops registers contain the tail of the kernel's last log line in ASCII:
`"…of fakeowner (fakeowner) … st.sol} still in use (1)"` — i.e.
**"VFS: Busy inodes after unmount"**: a container filesystem was unmounted
while a `.sol` file was still open. `fakeowner` is the kernel module Docker
Desktop layers over VirtioFS **bind mounts of host directories** to fake file
ownership inside containers.

This is a long-standing class of Docker Desktop bugs on Apple Silicon
(docker/for-mac issues [#7380](https://github.com/docker/for-mac/issues/7380),
[#7024](https://github.com/docker/for-mac/issues/7024),
[#7825](https://github.com/docker/for-mac/issues/7825) — `fakeowner` appears
in the module list of all of them). It has not been fixed across multiple
kernel generations, so assume it stays.

## Why Ignite is a near-perfect trigger

1. Local repositories are **bind mounts of host directories**
   (`/Users/...:/workspace`) — the fakeowner/VirtioFS path
   (`PluginExecutor.createRepoContainer`).
2. Every detect/install/compile runs in an **ephemeral container** sharing
   that mount via `VolumesFrom`, runs compiler processes that hold many
   source files open (forge/solc/node), and is then stopped and auto-removed
   — unmounting the filesystem.
3. Historically the stop was `stop({ t: 0 })` = **instant SIGKILL**, so any
   process still holding files open was killed mid-I/O right before the
   unmount. The pre-2026-06-12 frontend also auto-compiled **every repo on
   every startup**, multiplying the dice rolls, and container exec had no
   timeout, so hung compiles held files open indefinitely.

## Mitigations in place (2026-06-12)

- **Graceful stop:** containers are stopped with a grace period
  (`STOP_GRACE_SECONDS`, default 2s, env `IGNITE_CONTAINER_STOP_GRACE_SECONDS`)
  instead of `t: 0`, giving compiler processes time to exit and close files
  before the unmount (`ContainerOrchestrator`). Note: the idle `sleep
  infinity` PID 1 ignores SIGTERM, so every stop waits the full grace period
  — that latency is the cost of the fix; don't "optimize" it back to 0.
- **No startup auto-compile:** compilation is user-triggered (Clean compile
  button), removing most ephemeral-container churn.
- **Exec timeout:** hung plugin operations are cut off after 15 minutes
  instead of holding files open forever (`PluginExecutionUtils`).
- Keep **Docker Desktop updated** — newer releases ship newer VM kernels.

## Recovery when it happens anyway

```sh
osascript -e 'quit app "Docker"'; sleep 15
pkill -f com.docker.backend 2>/dev/null
open -a Docker        # daemon back in ~20s
```

The crash dump is in
`~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log*`
(grep for `fatal error reported`). Logs rotate quickly; capture them soon
after a crash if filing a Docker issue.

## Fallback design if crashes keep happening: named volumes for local repos

Cloned repos already use named volumes and are not affected. Local repos are
the only bind-mount users. The fallback is to make local repos work like
cloned repos:

- On repo init, create a named volume `ignite-local-<hash>` and **sync** the
  host directory into it (e.g. `git clone`/`git fetch` from the host path via
  the repo-manager container, or rsync/`docker cp`). The existing
  "pull changes" flow for cloned repos becomes the refresh mechanism for
  local repos too.
- All compile/exec activity then happens on a native ext4 volume inside the
  VM: **no VirtioFS, no fakeowner, no crash trigger** — and as a bonus,
  significantly faster compiler I/O than VirtioFS.

Trade-offs to accept before switching:

- Host edits are no longer live inside the container; the UI needs an
  explicit "sync/refresh" action (or filesystem watching on the host that
  triggers a re-sync) before recompiling.
- Build artifacts (`out/`) land in the volume, not next to the host repo;
  anything that reads artifacts from the host path must go through the
  artifact API instead.
- Extra disk usage (one copy of each repo inside the VM) and a sync step on
  first open of large repos.

Implementation sketch: in `PluginExecutor.createRepoContainer`, drop the
`binds = [pathOrUrl:/workspace]` branch for `RepoContainerKind.LOCAL` and use
the named-volume path with a sync step in the local-repo plugin's `init`;
add a "Sync from disk" action next to "Clean compile" in the UI.

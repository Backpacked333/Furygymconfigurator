"""Owned local browser supervisor. No provider, shell, permit issuer or generic command runner.
Independent wall clock and parent-death observation; stdin EOF is fatal. Never run in verify-only.
"""
import ctypes
import hashlib
import json
import stat
import os
import selectors
import signal
import subprocess
import sys
import time

CHROME = '/opt/.devin/chrome/chrome/linux-137.0.7118.2/chrome-linux64/chrome'
ROOT = '/home/ubuntu/Documents/fury-display-handoff/'


def parent_identity(pid):
    try:
        with open('/proc/%d/stat' % pid, encoding='ascii') as handle:
            return handle.read().rsplit(')', 1)[1].split()[19]
    except OSError:
        return None


def private_json(path):
    if os.path.realpath(path) != path:
        raise ValueError('unsafe private path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077 or before.st_nlink != 1 or not 1 <= before.st_size <= 8192:
            raise ValueError('unsafe private file')
        data = os.read(fd, 8193)
        after = os.fstat(fd)
        if len(data) != before.st_size or (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('private file changed')
        return json.loads(data)
    finally:
        os.close(fd)


def admitted_lifetime(parent, allowance):
    """The supervisor cannot be a bare executable bypass of Node's provision/admission path."""
    operator = private_json(ROOT + 'private-display-operator/operator.json')
    permit = operator['permit']
    lock = private_json(ROOT + 'renderer-runs/owned.lock')
    digest = 'sha256:' + hashlib.sha256(json.dumps(permit, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    if permit.get('kind') != 'operator-local-only' or permit.get('paidExecutionAllowed') is not False or permit.get('productionAllowed') is not False or lock.get('ownerPid') != parent or lock.get('permitDigest') != digest or lock.get('runId') != permit.get('runId'):
        raise ValueError('operator/run binding denied')
    remaining = min(permit['expiresAt'], lock['started'] + 600000) - time.time() * 1000
    if remaining <= 0 or not 1 <= allowance <= 600000:
        raise ValueError('operator/run expired')
    return min(allowance, remaining)


def descendants(supervisor):
    """Includes independently-sessioned and subreaper-adopted owned descendants, not just PGID."""
    processes = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open('/proc/%s/stat' % name, encoding='ascii') as handle:
                data = handle.read().rsplit(')', 1)[1].split()
            if data[0] != 'Z':
                processes[int(name)] = (int(data[1]), data[19])
        except (OSError, ValueError, IndexError):
            pass
    owned = {supervisor}
    changed = True
    while changed:
        changed = False
        for pid, (parent, _identity) in processes.items():
            if parent in owned and pid not in owned:
                owned.add(pid)
                changed = True
    return {pid: processes[pid][1] for pid in owned if pid != supervisor}


def signal_descendants(signum):
    for pid, identity in descendants(os.getpid()).items():
        # Pin the kernel process object before rechecking identity. A numeric kill/killpg
        # after a /proc check still races PID/PGID reuse; a pidfd cannot signal a successor.
        try:
            fd = os.pidfd_open(pid, 0)
            try:
                if parent_identity(pid) == identity:
                    signal.pidfd_send_signal(fd, signum)
            finally:
                os.close(fd)
        except ProcessLookupError:
            pass


def main():
    if len(sys.argv) != 5 or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        return 70
    profile, temp, allowance, parent = sys.argv[1:]
    parent = int(parent)
    allowance = int(allowance)
    if not 1 <= allowance <= 600000 or parent != os.getppid():
        return 70
    for path in (profile, temp):
        if not path.startswith(ROOT) or os.path.realpath(path) != path or not os.path.isdir(path):
            return 70
    try:
        allowance = admitted_lifetime(parent, allowance)
    except (OSError, ValueError, TypeError, KeyError):
        return 70
    # Refuse browser launch if this kernel/security policy cannot use owned pidfds.
    try:
        self_fd = os.pidfd_open(os.getpid(), 0)
        try:
            signal.pidfd_send_signal(self_fd, 0)
        finally:
            os.close(self_fd)
    except OSError:
        return 70
    # Adopt and reap orphaned descendants; no unrelated process is signalled.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        return 70
    identity = parent_identity(parent)
    started = time.monotonic()
    total_deadline = started + allowance / 1000
    phase_deadline = min(total_deadline, started + 60)
    stopped = False
    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    args = [CHROME, '--headless=new', '--no-startup-window', '--remote-debugging-pipe',
            '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-component-update', '--disable-sync',
            '--disable-extensions', '--disable-default-apps', '--disable-breakpad',
            '--disable-crash-reporter', '--disable-domain-reliability',
            '--disable-client-side-phishing-detection', '--disable-component-extensions-with-background-pages',
            '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,Translate,ServiceWorker',
            '--metrics-recording-only', '--disable-notifications', '--no-proxy-server',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic',
            '--force-device-scale-factor=1', '--window-size=1600,1500', '--password-store=basic',
            '--use-mock-keychain']
    reader = None
    reason = 'failure'
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=sys.stderr, pass_fds=(3, 4), start_new_session=True,
                             env={'PATH': '/usr/bin:/bin', 'HOME': profile, 'TMPDIR': temp,
                                  'XDG_CACHE_HOME': profile, 'XDG_CONFIG_HOME': profile,
                                  'LANG': 'C.UTF-8', 'TZ': 'UTC'})
    try:
        print(json.dumps({'event': 'owned', 'pid': child.pid}), flush=True)
        reader = selectors.DefaultSelector()
        reader.register(sys.stdin, selectors.EVENT_READ)
        buffer = b''
        phase = 'startup'
        while not stopped:
            now = time.monotonic()
            if now >= total_deadline or now >= phase_deadline:
                reason = 'deadline'
                break
            if parent_identity(parent) != identity or os.getppid() != parent:
                reason = 'parent-exit'
                break
            if child.poll() is not None:
                reason = 'browser-exit'
                break
            if reader.select(0.05):
                data = os.read(sys.stdin.fileno(), 4096)
                if not data:
                    reason = 'parent-pipe-exit'
                    break
                buffer += data
                if len(buffer) > 4096:
                    break
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    command = json.loads(line)
                    next_phase = command.get('phase')
                    if set(command) != {'phase'}:
                        raise ValueError('invalid command')
                    if next_phase == 'shutdown':
                        reason = 'requested'
                        stopped = True
                        break
                    if (phase, next_phase) not in [('startup', 'idle'), ('idle', 'job'), ('job', 'idle')]:
                        raise ValueError('invalid phase')
                    phase = next_phase
                    phase_deadline = min(total_deadline, time.monotonic() + (180 if phase == 'job' else 30))
    finally:
        if reader is not None:
            try:
                reader.close()
            except Exception:
                reason = 'selector-close-failure'
        signal_descendants(signal.SIGTERM)
        until = time.monotonic() + 1
        while time.monotonic() < until and descendants(os.getpid()):
            time.sleep(0.02)
        signal_descendants(signal.SIGKILL)
        child.wait(timeout=2)
        until = time.monotonic() + 1
        while time.monotonic() < until:
            try:
                while os.waitpid(-1, os.WNOHANG)[0] > 0:
                    pass
            except ChildProcessError:
                pass
            signal_descendants(signal.SIGKILL)
            if not descendants(os.getpid()):
                print(json.dumps({'event': 'exit-observed', 'pid': child.pid, 'reason': reason}), flush=True)
                break
            time.sleep(0.02)
        else:
            return 71
    return 0


if __name__ == '__main__':
    sys.exit(main())

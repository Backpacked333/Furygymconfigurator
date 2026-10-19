"""Candidate remote supervisor. All execution entrypoints deny before I/O in this build.
No local permit reader, cloud client, generic command runner, or authorization issuer.
The guarded process implementation retains pidfd/parent/subreaper and frozen Chrome flags.
"""
import ctypes
import json
import os
import selectors
import signal
import subprocess
import time

DISPATCH_ALLOWED = False
CHROME = '/opt/fury/chrome/chrome'
WORK = '/run/fury-display/'
FLAGS = (
    '--headless=new', '--no-startup-window', '--remote-debugging-pipe',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-default-apps', '--disable-breakpad', '--disable-crash-reporter',
    '--disable-domain-reliability', '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,Translate,ServiceWorker',
    '--metrics-recording-only', '--disable-notifications', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic',
    '--force-device-scale-factor=1', '--window-size=1600,1500', '--password-store=basic',
    '--use-mock-keychain',
)


def parent_identity(pid):
    try:
        with open('/proc/%d/stat' % pid, encoding='ascii') as handle:
            return handle.read().rsplit(')', 1)[1].split()[19]
    except OSError:
        return None


def descendants(supervisor):
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
    while True:
        more = {pid for pid, (parent, _) in processes.items() if parent in owned} - owned
        if not more:
            return {pid: processes[pid][1] for pid in owned if pid != supervisor}
        owned.update(more)


def signal_descendants(signum):
    for pid, identity in descendants(os.getpid()).items():
        try:
            fd = os.pidfd_open(pid, 0)
            try:
                if parent_identity(pid) == identity:
                    signal.pidfd_send_signal(fd, signum)
            finally:
                os.close(fd)
        except ProcessLookupError:
            pass


def supervise(profile, temp, allowance, parent, control, observations):
    # Deliberately unconditional: changing an environment variable or module flag grants nothing.
    # Reviewed signed remote admission and exact runtime image verification are not yet installed.
    if not DISPATCH_ALLOWED:
        return 70
    # No launch authorization verifier is configured; even changing the constant is insufficient.
    raise PermissionError('External launch authorization unconfigured')
    if os.getuid() == 0 or parent != os.getppid() or not 1 <= allowance <= 600000:
        return 70
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        return 70
    for path in (profile, temp):
        if not path.startswith(WORK) or os.path.realpath(path) != path or not os.path.isdir(path):
            return 70
    fd = os.pidfd_open(os.getpid(), 0)
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        return 70
    identity = parent_identity(parent)
    if identity is None:
        return 70
    total_deadline = time.monotonic() + allowance / 1000
    phase_deadline = min(total_deadline, time.monotonic() + 60)
    reader = None
    stopped = False
    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    args = [CHROME, *FLAGS[:3], '--user-data-dir=' + profile, *FLAGS[3:]]
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, pass_fds=(3, 4), start_new_session=True,
                             env={'PATH': '/usr/bin:/bin', 'HOME': profile, 'TMPDIR': temp,
                                  'XDG_CACHE_HOME': profile, 'XDG_CONFIG_HOME': profile,
                                  'LANG': 'C.UTF-8', 'TZ': 'UTC'})
    # Establish cleanup immediately after spawn, including ownership-pipe/selector failures.
    try:
        observations.write(json.dumps({'event': 'owned', 'pid': child.pid}) + '\n')
        observations.flush()
        reader = selectors.DefaultSelector()
        reader.register(control, selectors.EVENT_READ)
        buffer = b''
        phase = 'startup'
        while not stopped:
            if time.monotonic() >= min(total_deadline, phase_deadline):
                break
            if parent_identity(parent) != identity or os.getppid() != parent or child.poll() is not None:
                break
            if reader.select(0.05):
                data = os.read(control.fileno(), 4096)
                if not data:
                    break
                buffer += data
                if len(buffer) > 4096:
                    break
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    command = json.loads(line)
                    if set(command) != {'phase'}:
                        raise ValueError('Invalid supervisor command')
                    next_phase = command['phase']
                    if next_phase == 'shutdown':
                        stopped = True
                        break
                    if (phase, next_phase) not in [('startup', 'idle'), ('idle', 'job'), ('job', 'idle')]:
                        raise ValueError('Invalid supervisor phase')
                    phase = next_phase
                    phase_deadline = min(total_deadline, time.monotonic() + (180 if phase == 'job' else 30))
    finally:
        if reader is not None:
            try:
                reader.close()
            except Exception:
                # A selector failure cannot skip pidfd-owned descendant cleanup.
                pass
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
                observations.write(json.dumps({'event': 'exit-observed', 'pid': child.pid}) + '\n')
                observations.flush()
                return 0
            time.sleep(0.02)
        return 71


if __name__ == '__main__':
    raise SystemExit(70)

"""Coordinate all cooperating processes that operate on one X display."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import json
import signal
import time


def lock_path(purpose):
    directory = Path.home() / ".local" / "state" / "dsh-wechat-mate"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = hashlib.sha256(os.environ.get("WX_DISPLAY", ":99").encode()).hexdigest()[:16]
    return directory / f"{key}-{purpose}.lock"


@contextmanager
def display_lock(purpose="ui", blocking=True):
    import fcntl

    path = lock_path(purpose)
    with path.open("a") as handle:
        flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(handle, flags)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _lock_owner(handle):
    """Ask the kernel, not a writable PID file, which process holds this lock."""
    info = os.fstat(handle.fileno())
    for line in Path('/proc/locks').read_text().splitlines():
        fields = line.split()
        if len(fields) < 8 or fields[1] != 'FLOCK':
            continue
        major, minor, inode = fields[5].split(':')
        if (int(major, 16), int(minor, 16), int(inode)) == (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino):
            return int(fields[4])
    return None


def _recover_orphan(handle, script):
    """Recover only an orphan holding this exact display/repository's lock."""
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        return False
    try:
        pid = _lock_owner(handle)
        if not pid or pid <= 1:
            return False
        # pidfd prevents PID reuse from redirecting a signal to another process.
        descriptor = os.pidfd_open(pid)
        try:
            proc = Path('/proc') / str(pid)
            status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
            if not _is_reaper(int(status['PPid'])) or int(status['Uid'].split()[0]) != os.getuid():
                return False
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            cwd = (proc / 'cwd').resolve()
            # Match the interpreter's script argument exactly, never a substring.
            if len(args) < 2 or (cwd / os.fsdecode(args[1])).resolve() != Path(script).resolve():
                return False
            environment = dict(item.split(b'=', 1) for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
            if os.fsdecode(environment.get(b'WX_DISPLAY', b':99')) != os.environ.get('WX_DISPLAY', ':99'):
                return False
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            return True
        finally:
            os.close(descriptor)
    except (OSError, ValueError, KeyError):
        return False


def _is_reaper(pid):
    if pid == 1:
        return True
    # WSL reparents orphans to its root-owned /init relay, not always PID 1.
    try:
        proc = Path('/proc') / str(pid)
        status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines() if ':' in line)
        return (int(status['Uid'].split()[0]) == 0
                and (proc / 'cmdline').read_bytes() == b'/init\0'
                and status['Name'].strip().startswith('Relay(')
                and 'microsoft' in Path('/proc/sys/kernel/osrelease').read_text().lower())
    except (OSError, ValueError, KeyError):
        return False


@contextmanager
def watcher_lock(script):
    import fcntl

    path = lock_path('watcher')
    with path.open('a+') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if not _recover_orphan(handle, script):
                raise RuntimeError(f"watcher already owns display {os.environ.get('WX_DISPLAY', ':99')}; stop its owning host before restarting") from None
            deadline = time.monotonic() + 3
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('orphan watcher did not release its display lock') from None
                    time.sleep(0.05)
        try:
            os.fchmod(handle.fileno(), 0o600)
            handle.seek(0)
            handle.truncate()
            json.dump({'pid': os.getpid(), 'parent': os.getppid(), 'script': str(Path(script).resolve()),
                       'display': os.environ.get('WX_DISPLAY', ':99')}, handle)
            handle.flush()
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)

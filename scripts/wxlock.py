"""Coordinate all cooperating processes that operate on one X display."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path


@contextmanager
def display_lock(purpose="ui", blocking=True):
    import fcntl

    directory = Path.home() / ".local" / "state" / "dsh-wechat-mate"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = hashlib.sha256(os.environ.get("WX_DISPLAY", ":99").encode()).hexdigest()[:16]
    path = directory / f"{key}-{purpose}.lock"
    with path.open("a") as handle:
        flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(handle, flags)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)

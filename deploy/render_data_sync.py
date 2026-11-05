#!/usr/bin/env python3
"""Durable snapshots for Render's ephemeral free filesystem.

Render free web services cannot attach a persistent disk and lose every file
they write when they redeploy, restart, or spin down after 15 minutes idle.
This helper keeps the runtime tree in a private Supabase Storage bucket:

- ``restore`` downloads the latest snapshot before the app starts, so a cold
  instance comes back with its sessions, practice state, settings, and KBs.
- ``sync-loop`` uploads a consistent snapshot on an interval. Because Render
  only spins down after 15 idle minutes, a 60 second interval means the last
  write is already in object storage before the instance disappears.

Only the Python standard library is used, so the wrapper image needs no extra
packages. Credentials come from the service environment and are never logged.

Environment:
    SUPABASE_URL                  Project URL, e.g. https://abc.supabase.co
    SUPABASE_SERVICE_ROLE_KEY     service_role key (server-side only)
    DEEPTUTOR_DATA_DIR            default /app/data
    DEEPTUTOR_SNAPSHOT_BUCKET     default deeptutor-backups
    DEEPTUTOR_SNAPSHOT_OBJECT     default latest.tar.gz
    DEEPTUTOR_SNAPSHOT_INTERVAL   seconds between uploads, default 60
    DEEPTUTOR_SNAPSHOT_MAX_BYTES  skip larger archives, default 900000000

Usage:
    python render_data_sync.py restore
    python render_data_sync.py sync-loop
    python render_data_sync.py sync-once
    python render_data_sync.py snapshot <file>        # local debugging
    python render_data_sync.py restore-file <file>    # local debugging
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

LOG = logging.getLogger("render_data_sync")

DATA_DIR = Path(os.environ.get("DEEPTUTOR_DATA_DIR", "/app/data"))
BUCKET = os.environ.get("DEEPTUTOR_SNAPSHOT_BUCKET", "deeptutor-backups")
OBJECT = os.environ.get("DEEPTUTOR_SNAPSHOT_OBJECT", "latest.tar.gz")
INTERVAL = max(15, int(os.environ.get("DEEPTUTOR_SNAPSHOT_INTERVAL", "60")))
MAX_BYTES = int(os.environ.get("DEEPTUTOR_SNAPSHOT_MAX_BYTES", "900000000"))

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

DB_SUFFIXES = {".db", ".sqlite", ".sqlite3"}
# Ephemeral, cache-like, or reproducible files do not belong in a snapshot.
EXCLUDED_DIRS = {
    ".cache",
    ".git",
    "__pycache__",
    "logs",
    "node_modules",
    "parse_cache",
}
EXCLUDED_SUFFIXES = (
    ".log",
    ".migrate.lock",
    ".pyc",
    ".tmp",
    "-journal",
    "-shm",
    "-wal",
)
IGNORED_NAMES = {".snapshot_restored", ".snapshot_state.json"}
RESTORED_MARKER = DATA_DIR / ".snapshot_restored"
STATE_FILE = Path(tempfile.gettempdir()) / "deeptutor-snapshot-state.json"

_STOP = False


def _configured() -> bool:
    return bool(SUPABASE_URL and SERVICE_KEY)


def _request(
    method: str,
    path: str,
    *,
    data: bytes | None = None,
    content_type: str | None = None,
    timeout: int = 120,
) -> tuple[int, bytes]:
    request = urllib.request.Request(
        f"{SUPABASE_URL}{path}", data=data, method=method
    )
    request.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    request.add_header("apikey", SERVICE_KEY)
    if content_type:
        request.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _iter_files(*, include_volatile: bool) -> list[tuple[Path, Path]]:
    found: list[tuple[Path, Path]] = []
    if not DATA_DIR.exists():
        return found
    for dirpath, dirnames, filenames in os.walk(DATA_DIR):
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIRS)
        for name in sorted(filenames):
            path = Path(dirpath) / name
            try:
                rel = path.relative_to(DATA_DIR)
            except ValueError:  # pragma: no cover - os.walk keeps this inside
                continue
            if rel.name in IGNORED_NAMES:
                continue
            if rel.name.endswith(EXCLUDED_SUFFIXES):
                if not (include_volatile and rel.name.endswith(("-wal", "-shm"))):
                    continue
            found.append((path, rel))
    return found


def _fingerprint() -> str:
    digest = hashlib.sha256()
    for path, rel in _iter_files(include_volatile=True):
        try:
            stat = path.stat()
        except OSError:
            continue
        digest.update(str(rel).encode("utf-8"))
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
    return digest.hexdigest()


def _backup_sqlite(source: Path, destination: Path) -> None:
    """Copy through SQLite's backup API so WAL transactions are included."""
    origin = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True, timeout=10)
    try:
        target = sqlite3.connect(str(destination))
        try:
            with target:
                origin.backup(target)
        finally:
            target.close()
    finally:
        origin.close()


def create_snapshot(destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="deeptutor-snapshot-") as scratch:
        with tarfile.open(destination, "w:gz", compresslevel=6) as archive:
            for path, rel in _iter_files(include_volatile=False):
                if path.suffix.lower() in DB_SUFFIXES:
                    backup = Path(scratch) / f"db-{len(archive.getmembers())}{path.suffix}"
                    try:
                        _backup_sqlite(path, backup)
                    except sqlite3.Error as exc:
                        LOG.warning("sqlite backup failed for %s (%s); copying raw", rel, exc)
                        archive.add(path, arcname=str(rel))
                    else:
                        archive.add(backup, arcname=str(rel))
                else:
                    archive.add(path, arcname=str(rel))
    return destination.stat().st_size


def _extract(archive_path: Path) -> int:
    root = DATA_DIR.resolve()
    root.mkdir(parents=True, exist_ok=True)
    extracted = 0
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            name = member.name.replace("\\", "/")
            parts = Path(name).parts
            if not parts or name.startswith("/") or ".." in parts:
                raise ValueError(f"unsafe archive member: {member.name!r}")
            target = (root / name).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"unsafe archive member: {member.name!r}")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:  # pragma: no cover - regular files always open
                continue
            with source, target.open("wb") as handle:
                shutil.copyfileobj(source, handle)
            extracted += 1
    return extracted


def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(fingerprint: str) -> None:
    try:
        STATE_FILE.write_text(
            json.dumps({"fingerprint": fingerprint, "updated_at": time.time()}),
            encoding="utf-8",
        )
    except OSError as exc:  # pragma: no cover - /tmp is writable on Render
        LOG.warning("could not persist snapshot state: %s", exc)


def _ensure_bucket() -> None:
    status, body = _request(
        "POST",
        "/storage/v1/bucket",
        data=json.dumps({"id": BUCKET, "name": BUCKET, "public": False}).encode(),
        content_type="application/json",
    )
    if status not in (200, 201, 400, 409):
        raise RuntimeError(f"could not ensure bucket {BUCKET!r}: HTTP {status} {body[:200]!r}")


def _upload(path: Path) -> None:
    size = path.stat().st_size
    request = urllib.request.Request(
        f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{OBJECT}", method="POST"
    )
    request.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    request.add_header("apikey", SERVICE_KEY)
    request.add_header("Content-Type", "application/gzip")
    request.add_header("x-upsert", "true")
    request.add_header("Content-Length", str(size))
    with path.open("rb") as body:
        request.data = body  # type: ignore[assignment]
        with urllib.request.urlopen(request, timeout=300) as response:
            response.read()
    LOG.info("uploaded snapshot: %.1f MiB", size / 1048576)


def _download(destination: Path) -> bool:
    request = urllib.request.Request(
        f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{OBJECT}", method="GET"
    )
    request.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    request.add_header("apikey", SERVICE_KEY)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            with destination.open("wb") as handle:
                shutil.copyfileobj(response, handle)
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 404):
            return False
        raise
    return True


def _with_retries(action, *, attempts: int = 3) -> None:
    for attempt in range(1, attempts + 1):
        try:
            action()
            return
        except Exception as exc:  # noqa: BLE001 - deployment helper must not crash the app
            if attempt == attempts:
                raise
            LOG.warning("attempt %s/%s failed: %s", attempt, attempts, exc)
            time.sleep(min(30, 5 * attempt))


def restore() -> None:
    if not _configured():
        LOG.info("snapshot restore skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset")
        return
    if RESTORED_MARKER.exists():
        LOG.info("snapshot already restored this instance")
        return
    with tempfile.TemporaryDirectory(prefix="deeptutor-restore-") as scratch:
        archive = Path(scratch) / "snapshot.tar.gz"
        if not _download(archive):
            LOG.info("no snapshot found in %s/%s; starting with local data", BUCKET, OBJECT)
            return
        count = _extract(archive)
    RESTORED_MARKER.write_text(f"{time.time()}\n", encoding="utf-8")
    _save_state(_fingerprint())
    LOG.info("restored %s files from %s/%s", count, BUCKET, OBJECT)


def sync_once() -> None:
    if not _configured():
        return
    fingerprint = _fingerprint()
    if _load_state().get("fingerprint") == fingerprint:
        LOG.debug("no changes since last snapshot")
        return
    with tempfile.TemporaryDirectory(prefix="deeptutor-snapshot-") as scratch:
        archive = Path(scratch) / "snapshot.tar.gz"
        size = create_snapshot(archive)
        if size > MAX_BYTES:
            LOG.error(
                "snapshot is %.1f MiB, above the %d MiB limit; skipping upload",
                size / 1048576,
                MAX_BYTES // 1048576,
            )
            return
        _with_retries(_ensure_bucket)
        _with_retries(lambda: _upload(archive))
    _save_state(fingerprint)


def _handle_signal(signum, _frame) -> None:
    global _STOP
    LOG.info("received signal %s; finishing current snapshot", signum)
    _STOP = True


def sync_loop() -> None:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    while not _STOP:
        try:
            sync_once()
        except Exception as exc:  # noqa: BLE001 - keep the loop alive on transient errors
            LOG.error("snapshot sync failed: %s", exc)
        for _ in range(INTERVAL):
            if _STOP:
                break
            time.sleep(1)
    if _configured():
        try:
            sync_once()
        except Exception as exc:  # noqa: BLE001
            LOG.error("final snapshot failed: %s", exc)


def main(argv: list[str]) -> int:
    logging.basicConfig(
        level=os.environ.get("DEEPTUTOR_SNAPSHOT_LOG_LEVEL", "INFO").upper(),
        format="[data-sync] %(levelname)s %(message)s",
    )
    command = argv[1] if len(argv) > 1 else "sync-loop"
    if command == "restore":
        restore()
    elif command == "sync-once":
        sync_once()
    elif command == "sync-loop":
        sync_loop()
    elif command == "snapshot" and len(argv) > 2:
        print(create_snapshot(Path(argv[2])))
    elif command == "restore-file" and len(argv) > 2:
        print(_extract(Path(argv[2])))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

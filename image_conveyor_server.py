import asyncio
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import stat as stat_module
import tempfile
import threading
import time
import uuid
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


LOGGER = logging.getLogger(__name__)

SUPPORTED_IMAGE_EXTENSIONS = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"}
)
LEGACY_UPLOAD_SUBFOLDER = "image_conveyor"
HASH_CHUNK_SIZE = 1024 * 1024
SNAPSHOT_TTL_SECONDS = 2.0
THUMBNAIL_BUCKETS = (160, 256, 384, 512)
THUMBNAIL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60


class InvalidInputPath(ValueError):
    pass


class InvalidUpload(ValueError):
    pass


class InvalidThumbnail(ValueError):
    pass


class InvalidPreset(ValueError):
    pass


def normalize_relative_path(value: Any, *, allow_empty: bool = False) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        if allow_empty:
            return ""
        raise InvalidInputPath("A relative input path is required.")
    if "\x00" in raw:
        raise InvalidInputPath("The path contains an invalid null byte.")

    posix = PurePosixPath(raw)
    windows = PureWindowsPath(raw)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        raise InvalidInputPath("Absolute paths are not allowed.")

    parts = raw.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise InvalidInputPath("The path contains an invalid segment.")
    return "/".join(parts)


def normalize_filename(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw or raw in {".", ".."} or "\x00" in raw:
        raise InvalidUpload("A valid filename is required.")
    if "/" in raw or "\\" in raw or PureWindowsPath(raw).drive:
        raise InvalidUpload("The filename must not contain a path.")
    if Path(raw).suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
        raise InvalidUpload(f"Unsupported image extension: {Path(raw).suffix or '(none)'}")
    return raw


def normalize_reference_slot(value: Any, input_root: str, *, must_exist: bool = True) -> Optional[Dict[str, str]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise InvalidPreset("Reference slots must be image records or null.")
    storage_type = str(value.get("type", "input")).strip().lower() or "input"
    if storage_type != "input":
        raise InvalidPreset("Reference presets may only contain ComfyUI input images.")
    annotated = str(value.get("annotated", "")).strip()
    suffix = " [input]"
    if not annotated.endswith(suffix):
        raise InvalidPreset("Reference images must use an annotated ComfyUI input path.")
    try:
        relative_path = normalize_relative_path(annotated[:-len(suffix)])
    except InvalidInputPath as exc:
        raise InvalidPreset("A reference slot contains an invalid input path.") from exc
    if Path(relative_path).suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
        raise InvalidPreset("A reference slot has an unsupported image extension.")
    try:
        resolve_under_root(input_root, relative_path, must_exist=must_exist)
    except (InvalidInputPath, FileNotFoundError) as exc:
        raise InvalidPreset(f"Reference image '{annotated}' is outside input or missing.") from exc
    relative = PurePosixPath(relative_path)
    parent = "" if str(relative.parent) == "." else str(relative.parent)
    return {
        "annotated": f"{relative_path} [input]",
        "filename": relative.name,
        "subfolder": parent,
        "type": "input",
    }


class PresetStore:
    VERSION = 1
    SLOT_COUNT = 8

    def __init__(self, path: str, input_root: str):
        self.path = path
        self.input_root = os.path.realpath(input_root)
        self._lock = threading.RLock()
        self._recovery_pending = False

    @staticmethod
    def _empty_document() -> Dict[str, Any]:
        return {"version": PresetStore.VERSION, "presets": []}

    def _normalize_name(self, value: Any) -> str:
        name = " ".join(str(value or "").strip().split())
        if not name or len(name) > 120 or any(ord(character) < 32 or ord(character) == 127 for character in name):
            raise InvalidPreset("Preset names must contain 1 to 120 printable characters.")
        return name

    def _normalize_id(self, value: Any) -> str:
        try:
            return str(uuid.UUID(str(value or "").strip()))
        except (ValueError, AttributeError) as exc:
            raise InvalidPreset("The preset ID is invalid.") from exc

    def _normalize_slots(self, value: Any, *, must_exist: bool = True) -> List[Optional[Dict[str, str]]]:
        if not isinstance(value, list) or len(value) != self.SLOT_COUNT:
            raise InvalidPreset("A reference preset must contain exactly 8 slots.")
        return [
            normalize_reference_slot(slot, self.input_root, must_exist=must_exist)
            for slot in value
        ]

    def _normalize_preset(self, value: Any, *, must_exist: bool = False) -> Dict[str, Any]:
        if not isinstance(value, dict):
            raise InvalidPreset("The preset document is malformed.")
        return {
            "id": self._normalize_id(value.get("id")),
            "name": self._normalize_name(value.get("name")),
            "slots": self._normalize_slots(value.get("slots"), must_exist=must_exist),
            "created_at": max(0, int(value.get("created_at", 0) or 0)),
            "updated_at": max(0, int(value.get("updated_at", 0) or 0)),
        }

    def _quarantine(self) -> None:
        if not os.path.exists(self.path):
            return
        quarantine = f"{self.path}.corrupt-{int(time.time() * 1000)}"
        try:
            os.replace(self.path, quarantine)
        except OSError:
            LOGGER.exception("Image Conveyor could not quarantine malformed preset storage.")

    def _load_unlocked(self) -> Dict[str, Any]:
        if not os.path.isfile(self.path):
            return self._empty_document()
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if not isinstance(raw, dict) or raw.get("version") != self.VERSION:
                raise InvalidPreset("Unsupported preset document version.")
            values = raw.get("presets")
            if not isinstance(values, list):
                raise InvalidPreset("The preset document is malformed.")
            presets = [self._normalize_preset(value, must_exist=False) for value in values]
            ids = {preset["id"] for preset in presets}
            names = {preset["name"].casefold() for preset in presets}
            if len(ids) != len(presets) or len(names) != len(presets):
                raise InvalidPreset("The preset document contains duplicate IDs or names.")
            return {"version": self.VERSION, "presets": presets}
        except (OSError, UnicodeError, json.JSONDecodeError, InvalidPreset, ValueError, TypeError):
            LOGGER.warning("Image Conveyor preset storage was malformed and has been quarantined.", exc_info=True)
            self._quarantine()
            self._recovery_pending = True
            return self._empty_document()

    def _write_unlocked(self, document: Dict[str, Any]) -> None:
        parent = os.path.dirname(self.path)
        os.makedirs(parent, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".reference-presets-", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            self._recovery_pending = False
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            try:
                os.unlink(temporary)
            except OSError:
                pass

    @staticmethod
    def _ordered(presets: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return sorted(presets, key=lambda preset: (preset["name"].casefold(), preset["name"], preset["id"]))

    def list(self) -> List[Dict[str, Any]]:
        with self._lock:
            return json.loads(json.dumps(self._ordered(self._load_unlocked()["presets"])))

    def create(self, name: Any, slots: Any) -> Dict[str, Any]:
        with self._lock:
            document = self._load_unlocked()
            normalized_name = self._normalize_name(name)
            if any(preset["name"].casefold() == normalized_name.casefold() for preset in document["presets"]):
                raise InvalidPreset("A preset with that name already exists.")
            now = int(time.time() * 1000)
            preset = {
                "id": str(uuid.uuid4()),
                "name": normalized_name,
                "slots": self._normalize_slots(slots),
                "created_at": now,
                "updated_at": now,
            }
            document["presets"].append(preset)
            document["presets"] = self._ordered(document["presets"])
            self._write_unlocked(document)
            return json.loads(json.dumps(preset))

    def update(self, preset_id: Any, *, name: Any = None, slots: Any = None) -> Dict[str, Any]:
        with self._lock:
            document = self._load_unlocked()
            normalized_id = self._normalize_id(preset_id)
            preset = next((entry for entry in document["presets"] if entry["id"] == normalized_id), None)
            if preset is None:
                raise KeyError(normalized_id)
            if name is not None:
                normalized_name = self._normalize_name(name)
                if any(
                    entry["id"] != normalized_id and entry["name"].casefold() == normalized_name.casefold()
                    for entry in document["presets"]
                ):
                    raise InvalidPreset("A preset with that name already exists.")
                preset["name"] = normalized_name
            if slots is not None:
                preset["slots"] = self._normalize_slots(slots)
            if name is None and slots is None:
                raise InvalidPreset("The preset update did not contain a name or slots.")
            preset["updated_at"] = int(time.time() * 1000)
            document["presets"] = self._ordered(document["presets"])
            self._write_unlocked(document)
            return json.loads(json.dumps(preset))

    def delete(self, preset_id: Any) -> bool:
        with self._lock:
            document = self._load_unlocked()
            normalized_id = self._normalize_id(preset_id)
            kept = [entry for entry in document["presets"] if entry["id"] != normalized_id]
            if len(kept) == len(document["presets"]):
                return False
            document["presets"] = kept
            self._write_unlocked(document)
            return True

    def relink_paths(self, replacements: Sequence[Dict[str, Any]]) -> int:
        mapping: Dict[str, str] = {}
        for replacement in replacements:
            if not isinstance(replacement, dict):
                raise InvalidPreset("A preset relink entry is malformed.")
            old_path = normalize_relative_path(replacement.get("relative_path"))
            keep_path = normalize_relative_path(replacement.get("keep_path"))
            resolve_under_root(self.input_root, keep_path, must_exist=True)
            mapping[old_path] = keep_path
        if not mapping:
            return 0
        with self._lock:
            document = self._load_unlocked()
            if self._recovery_pending:
                raise InvalidPreset(
                    "Preset storage was malformed; duplicate cleanup is blocked until presets are repaired or saved again."
                )
            changed = 0
            for preset in document["presets"]:
                for index, slot in enumerate(preset["slots"]):
                    if slot is None:
                        continue
                    relative_path = slot["annotated"][:-len(" [input]")]
                    keep_path = mapping.get(relative_path)
                    if not keep_path:
                        continue
                    preset["slots"][index] = normalize_reference_slot(
                        {"annotated": f"{keep_path} [input]", "type": "input"},
                        self.input_root,
                    )
                    preset["updated_at"] = int(time.time() * 1000)
                    changed += 1
            if changed:
                self._write_unlocked(document)
            return changed


def resolve_under_root(root: str, relative_path: str, *, must_exist: bool = False) -> str:
    relative = normalize_relative_path(relative_path)
    root_real = os.path.realpath(root)
    candidate = os.path.abspath(os.path.join(root_real, *relative.split("/")))
    candidate_real = os.path.realpath(candidate)
    try:
        contained = os.path.commonpath((root_real, candidate_real)) == root_real
    except ValueError:
        contained = False
    if not contained:
        raise InvalidInputPath("The path escapes the ComfyUI input directory.")
    if must_exist and not os.path.isfile(candidate_real):
        raise FileNotFoundError(relative)
    return candidate_real


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(HASH_CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def stable_file_digest(path: str) -> Optional[Tuple[str, int, int]]:
    for _attempt in range(2):
        try:
            with open(path, "rb") as handle:
                before = os.fstat(handle.fileno())
                digest = hashlib.sha256()
                while True:
                    chunk = handle.read(HASH_CHUNK_SIZE)
                    if not chunk:
                        break
                    digest.update(chunk)
                after = os.fstat(handle.fileno())
        except (FileNotFoundError, OSError):
            return None
        if before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns:
            return digest.hexdigest(), after.st_size, after.st_mtime_ns
    return None


@dataclass(frozen=True)
class FileRecord:
    relative_path: str
    size: int
    mtime_ns: int
    content_hash: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        relative = PurePosixPath(self.relative_path)
        parent = "" if str(relative.parent) == "." else str(relative.parent)
        return {
            "filename": relative.name,
            "subfolder": parent,
            "relative_path": self.relative_path,
            "type": "input",
            "size": self.size,
            "mtime_ns": self.mtime_ns,
            "source_version": f"{self.size}-{self.mtime_ns}",
        }


class ContentIndex:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._schema_lock = threading.Lock()
        self._schema_ready = False

    def _connect(self) -> sqlite3.Connection:
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        connection = sqlite3.connect(self.db_path, timeout=5.0)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=5000")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            self._ensure_schema(connection)
            return connection
        except Exception:
            connection.close()
            raise

    def _ensure_schema(self, connection: sqlite3.Connection) -> None:
        if self._schema_ready:
            return
        with self._schema_lock:
            if self._schema_ready:
                return
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS files (
                    relative_path TEXT PRIMARY KEY,
                    file_size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    content_hash TEXT
                );
                CREATE INDEX IF NOT EXISTS files_by_size ON files(file_size);
                CREATE INDEX IF NOT EXISTS files_by_hash ON files(content_hash);
                """
            )
            connection.commit()
            self._schema_ready = True

    def recover_if_corrupt(self) -> None:
        with self._schema_lock:
            self._schema_ready = False
            if os.path.exists(self.db_path):
                quarantine = f"{self.db_path}.corrupt-{int(time.time())}"
                try:
                    os.replace(self.db_path, quarantine)
                except OSError:
                    try:
                        os.unlink(self.db_path)
                    except OSError:
                        pass
            for suffix in ("-wal", "-shm"):
                try:
                    os.unlink(self.db_path + suffix)
                except OSError:
                    pass

    def _run(self, operation):
        def execute():
            connection = self._connect()
            try:
                with connection:
                    return operation(connection)
            finally:
                connection.close()

        try:
            return execute()
        except sqlite3.DatabaseError as exc:
            LOGGER.warning("Image Conveyor duplicate index was corrupt and will be rebuilt: %s", exc)
            self.recover_if_corrupt()
            return execute()

    def sync_metadata(self, records: Sequence[FileRecord]) -> None:
        paths = {record.relative_path for record in records}

        def operation(connection: sqlite3.Connection) -> None:
            connection.executemany(
                """
                INSERT INTO files(relative_path, file_size, mtime_ns, content_hash)
                VALUES (?, ?, ?, NULL)
                ON CONFLICT(relative_path) DO UPDATE SET
                    file_size=excluded.file_size,
                    mtime_ns=excluded.mtime_ns,
                    content_hash=CASE
                        WHEN files.file_size=excluded.file_size
                         AND files.mtime_ns=excluded.mtime_ns
                        THEN files.content_hash
                        ELSE NULL
                    END
                WHERE files.file_size != excluded.file_size
                   OR files.mtime_ns != excluded.mtime_ns
                """,
                ((record.relative_path, record.size, record.mtime_ns) for record in records),
            )
            existing = [row[0] for row in connection.execute("SELECT relative_path FROM files")]
            stale = [(path,) for path in existing if path not in paths]
            if stale:
                connection.executemany("DELETE FROM files WHERE relative_path=?", stale)
            connection.commit()

        self._run(operation)

    def records_by_size(self, file_size: int) -> List[FileRecord]:
        def operation(connection: sqlite3.Connection) -> List[FileRecord]:
            rows = connection.execute(
                """
                SELECT relative_path, file_size, mtime_ns, content_hash
                FROM files WHERE file_size=?
                """,
                (file_size,),
            ).fetchall()
            return [
                FileRecord(row["relative_path"], row["file_size"], row["mtime_ns"], row["content_hash"])
                for row in rows
            ]

        return self._run(operation)

    def update_digest(self, record: FileRecord, content_hash: str) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                INSERT INTO files(relative_path, file_size, mtime_ns, content_hash)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(relative_path) DO UPDATE SET
                    file_size=excluded.file_size,
                    mtime_ns=excluded.mtime_ns,
                    content_hash=excluded.content_hash
                """,
                (record.relative_path, record.size, record.mtime_ns, content_hash),
            )
            connection.commit()

        self._run(operation)

    def remove(self, relative_path: str) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            connection.execute("DELETE FROM files WHERE relative_path=?", (relative_path,))
            connection.commit()

        self._run(operation)


@dataclass
class _KeyLockEntry:
    lock: Any
    users: int = 0


class InputLibrary:
    def __init__(
        self,
        input_root: str,
        cache_root: str,
        snapshot_ttl: float = SNAPSHOT_TTL_SECONDS,
        preset_path: Optional[str] = None,
    ):
        self.input_root = os.path.realpath(input_root)
        self.cache_root = cache_root
        self.snapshot_ttl = snapshot_ttl
        self.index = ContentIndex(os.path.join(cache_root, "content-index.sqlite3"))
        self.thumbnail_root = os.path.join(cache_root, "thumbnails")
        self.upload_temp_root = os.path.join(cache_root, "uploads")
        self.preset_store = PresetStore(
            preset_path or os.path.join(cache_root, "reference-presets.json"),
            self.input_root,
        )
        self._snapshot: Tuple[FileRecord, ...] = ()
        self._snapshot_at = 0.0
        self._snapshot_wall_ms = 0
        self._snapshot_version = 0
        self._snapshot_lock = threading.Lock()
        self._key_locks_lock = threading.Lock()
        self._digest_locks: Dict[str, _KeyLockEntry] = {}
        self._destination_locks: Dict[str, _KeyLockEntry] = {}
        self._thumbnail_locks: Dict[str, _KeyLockEntry] = {}
        self._last_thumbnail_prune = 0.0

    @contextmanager
    def _key_lock(self, registry: Dict[str, _KeyLockEntry], key: str) -> Iterable[None]:
        with self._key_locks_lock:
            entry = registry.get(key)
            if entry is None:
                entry = _KeyLockEntry(threading.Lock())
                registry[key] = entry
            entry.users += 1
        entry.lock.acquire()
        try:
            yield
        finally:
            entry.lock.release()
            with self._key_locks_lock:
                entry.users -= 1
                if entry.users == 0 and registry.get(key) is entry:
                    del registry[key]

    def _scan(self) -> List[FileRecord]:
        records: List[FileRecord] = []
        stack: List[Tuple[str, str]] = [(self.input_root, "")]
        while stack:
            directory, relative_dir = stack.pop()
            try:
                entries = list(os.scandir(directory))
            except (FileNotFoundError, PermissionError, OSError):
                continue
            entries.sort(key=lambda entry: entry.name.casefold(), reverse=True)
            for entry in entries:
                if entry.name.startswith("."):
                    continue
                relative_path = f"{relative_dir}/{entry.name}" if relative_dir else entry.name
                relative_path = relative_path.replace("\\", "/")
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append((entry.path, relative_path))
                    elif entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
                        stat = entry.stat(follow_symlinks=False)
                        records.append(FileRecord(relative_path, stat.st_size, stat.st_mtime_ns))
                except (FileNotFoundError, PermissionError, OSError):
                    continue
        records.sort(key=lambda record: (record.relative_path.casefold(), record.relative_path))
        return records

    def list_files(self, *, force: bool = False) -> Tuple[List[FileRecord], int, int]:
        now = time.monotonic()
        with self._snapshot_lock:
            if not force and self._snapshot and now - self._snapshot_at < self.snapshot_ttl:
                return list(self._snapshot), self._snapshot_version, self._snapshot_wall_ms

            records = self._scan()
            try:
                self.index.sync_metadata(records)
            except (sqlite3.Error, OSError):
                LOGGER.warning("Image Conveyor duplicate index is unavailable; using the filesystem snapshot.", exc_info=True)
            self._snapshot = tuple(records)
            self._snapshot_at = time.monotonic()
            self._snapshot_wall_ms = int(time.time() * 1000)
            self._snapshot_version += 1
            return list(records), self._snapshot_version, self._snapshot_wall_ms

    def invalidate_snapshot(self) -> None:
        with self._snapshot_lock:
            self._snapshot_at = 0.0

    def _patch_snapshot(self, record: FileRecord) -> None:
        with self._snapshot_lock:
            by_path = {entry.relative_path: entry for entry in self._snapshot}
            by_path[record.relative_path] = record
            self._snapshot = tuple(
                sorted(by_path.values(), key=lambda entry: (entry.relative_path.casefold(), entry.relative_path))
            )
            self._snapshot_at = time.monotonic()
            self._snapshot_wall_ms = int(time.time() * 1000)
            self._snapshot_version += 1

    def _candidate_records(self, file_size: int, intended_path: str = "") -> List[FileRecord]:
        candidates = {record.relative_path: record for record in self._snapshot if record.size == file_size}
        try:
            for record in self.index.records_by_size(file_size):
                candidates[record.relative_path] = record
        except (sqlite3.Error, OSError):
            pass
        if intended_path:
            try:
                intended = resolve_under_root(self.input_root, intended_path, must_exist=True)
                stat = os.stat(intended)
                if stat.st_size == file_size:
                    cached = candidates.get(intended_path)
                    cached_hash = (
                        cached.content_hash
                        if cached is not None
                        and cached.size == stat.st_size
                        and cached.mtime_ns == stat.st_mtime_ns
                        else None
                    )
                    candidates[intended_path] = FileRecord(
                        intended_path,
                        stat.st_size,
                        stat.st_mtime_ns,
                        cached_hash,
                    )
            except (InvalidInputPath, FileNotFoundError, OSError):
                pass
        return list(candidates.values())

    @staticmethod
    def _canonical_rank(relative_path: str, intended_path: str) -> Tuple[int, str, str]:
        if relative_path == intended_path:
            rank = 0
        elif relative_path != LEGACY_UPLOAD_SUBFOLDER and not relative_path.startswith(f"{LEGACY_UPLOAD_SUBFOLDER}/"):
            rank = 1
        else:
            rank = 2
        return rank, relative_path.casefold(), relative_path

    def _find_duplicate(self, intended_path: str, size: int, digest: str) -> Optional[FileRecord]:
        candidates = sorted(
            self._candidate_records(size, intended_path),
            key=lambda record: self._canonical_rank(record.relative_path, intended_path),
        )
        for cached in candidates:
            try:
                path = resolve_under_root(self.input_root, cached.relative_path, must_exist=True)
                stat = os.stat(path)
            except (InvalidInputPath, FileNotFoundError, OSError):
                try:
                    self.index.remove(cached.relative_path)
                except (sqlite3.Error, OSError):
                    pass
                continue
            if stat.st_size != size:
                continue

            cached_hash = cached.content_hash
            if cached.mtime_ns != stat.st_mtime_ns or cached.size != stat.st_size:
                cached_hash = None
            if cached_hash is None:
                hashed = stable_file_digest(path)
                if hashed is None:
                    continue
                cached_hash, hashed_size, hashed_mtime = hashed
                current = FileRecord(cached.relative_path, hashed_size, hashed_mtime, cached_hash)
                try:
                    self.index.update_digest(current, cached_hash)
                except (sqlite3.Error, OSError):
                    pass
            else:
                current = FileRecord(cached.relative_path, stat.st_size, stat.st_mtime_ns, cached_hash)
            if cached_hash == digest:
                return current
        return None

    def _collision_safe_relative_path(self, intended_path: str) -> str:
        parent, filename = os.path.split(intended_path)
        stem, extension = os.path.splitext(filename)
        candidate = intended_path
        counter = 1
        while os.path.exists(resolve_under_root(self.input_root, candidate)):
            renamed = f"{stem} ({counter}){extension}"
            candidate = f"{parent}/{renamed}" if parent else renamed
            counter += 1
        return candidate

    def _atomic_copy(self, source: str, destination: str) -> None:
        parent = os.path.dirname(destination)
        os.makedirs(parent, exist_ok=True)
        parent_real = os.path.realpath(parent)
        try:
            contained = os.path.commonpath((self.input_root, parent_real)) == self.input_root
        except ValueError:
            contained = False
        if not contained:
            raise InvalidInputPath("The destination directory escapes the ComfyUI input directory.")
        descriptor, temporary = tempfile.mkstemp(prefix=".image-conveyor-", suffix=".part", dir=parent)
        try:
            staged_inside = os.path.commonpath((self.input_root, os.path.realpath(temporary))) == self.input_root
        except ValueError:
            staged_inside = False
        if not staged_inside:
            os.close(descriptor)
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise InvalidInputPath("The upload staging path escapes the ComfyUI input directory.")
        try:
            with os.fdopen(descriptor, "wb") as output, open(source, "rb") as incoming:
                shutil.copyfileobj(incoming, output, HASH_CHUNK_SIZE)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(temporary, destination)
            except FileExistsError:
                raise
            except OSError:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                target_fd = os.open(destination, flags, 0o666)
                try:
                    with os.fdopen(target_fd, "wb") as output, open(temporary, "rb") as staged:
                        shutil.copyfileobj(staged, output, HASH_CHUNK_SIZE)
                        output.flush()
                        os.fsync(output.fileno())
                except Exception:
                    try:
                        os.unlink(destination)
                    except OSError:
                        pass
                    raise
        finally:
            try:
                os.unlink(temporary)
            except OSError:
                pass

    def resolve_upload(
        self,
        temporary_path: str,
        filename: str,
        subfolder: str,
        size: int,
        digest: str,
        refresh_snapshot: bool = False,
    ) -> Tuple[FileRecord, bool]:
        filename = normalize_filename(filename)
        normalized_subfolder = normalize_relative_path(subfolder, allow_empty=True)
        intended = f"{normalized_subfolder}/{filename}" if normalized_subfolder else filename
        resolve_under_root(self.input_root, intended)

        # Enumeration is metadata-only and cached across a batch. It makes fresh installs
        # aware of pre-existing same-size candidates without hashing the whole input tree.
        self.list_files(force=refresh_snapshot)

        with self._key_lock(self._digest_locks, digest):
            duplicate = self._find_duplicate(intended, size, digest)
            if duplicate is not None:
                self._patch_snapshot(duplicate)
                return duplicate, True

            with self._key_lock(self._destination_locks, intended.casefold()):
                # A different digest may have written the intended filename while this
                # request was hashing candidates, so collision choice is inside the lock.
                relative_path = self._collision_safe_relative_path(intended)
                destination = resolve_under_root(self.input_root, relative_path)
                try:
                    self._atomic_copy(temporary_path, destination)
                except FileExistsError:
                    relative_path = self._collision_safe_relative_path(intended)
                    destination = resolve_under_root(self.input_root, relative_path)
                    self._atomic_copy(temporary_path, destination)

            stat = os.stat(destination)
            record = FileRecord(relative_path, stat.st_size, stat.st_mtime_ns, digest)
            try:
                self.index.update_digest(record, digest)
            except (sqlite3.Error, OSError) as exc:
                LOGGER.warning("Image Conveyor saved an upload but could not update its cache index: %s", exc)
            self._patch_snapshot(record)
            return record, False

    @staticmethod
    def _is_managed_path(relative_path: str) -> bool:
        return relative_path == LEGACY_UPLOAD_SUBFOLDER or relative_path.startswith(f"{LEGACY_UPLOAD_SUBFOLDER}/")

    def _record_with_digest(self, record: FileRecord) -> Optional[FileRecord]:
        try:
            path = resolve_under_root(self.input_root, record.relative_path, must_exist=True)
            stat = os.stat(path)
        except (InvalidInputPath, FileNotFoundError, OSError):
            return None
        content_hash = record.content_hash
        if record.size != stat.st_size or record.mtime_ns != stat.st_mtime_ns:
            content_hash = None
        if content_hash is None:
            hashed = stable_file_digest(path)
            if hashed is None:
                return None
            content_hash, size, mtime_ns = hashed
            current = FileRecord(record.relative_path, size, mtime_ns, content_hash)
            try:
                self.index.update_digest(current, content_hash)
            except (sqlite3.Error, OSError):
                pass
            return current
        return FileRecord(record.relative_path, stat.st_size, stat.st_mtime_ns, content_hash)

    def find_managed_duplicates(self) -> Dict[str, Any]:
        records, snapshot_version, _scanned_at = self.list_files(force=True)
        by_size: Dict[int, List[FileRecord]] = {}
        for record in records:
            by_size.setdefault(record.size, []).append(record)

        duplicate_groups = []
        total_reclaimable_bytes = 0
        for size_records in by_size.values():
            if len(size_records) < 2 or not any(self._is_managed_path(record.relative_path) for record in size_records):
                continue
            by_digest: Dict[str, List[FileRecord]] = {}
            for record in size_records:
                current = self._record_with_digest(record)
                if current is not None and current.content_hash:
                    by_digest.setdefault(current.content_hash, []).append(current)
            for digest, matches in by_digest.items():
                if len(matches) < 2:
                    continue
                matches.sort(key=lambda record: self._canonical_rank(record.relative_path, ""))
                keep = matches[0]
                redundant = [
                    record for record in matches[1:]
                    if self._is_managed_path(record.relative_path)
                ]
                if not redundant:
                    continue
                total_reclaimable_bytes += sum(record.size for record in redundant)
                duplicate_groups.append(
                    {
                        "digest": digest,
                        "keep_path": keep.relative_path,
                        "duplicates": [
                            {
                                "relative_path": record.relative_path,
                                "size": record.size,
                                "mtime_ns": record.mtime_ns,
                            }
                            for record in redundant
                        ],
                    }
                )

        duplicate_groups.sort(key=lambda group: (group["keep_path"].casefold(), group["keep_path"]))
        return {
            "groups": duplicate_groups,
            "duplicate_count": sum(len(group["duplicates"]) for group in duplicate_groups),
            "reclaimable_bytes": total_reclaimable_bytes,
            "snapshot_version": snapshot_version,
        }

    def _remove_snapshot_paths(self, relative_paths: Iterable[str]) -> None:
        removed = set(relative_paths)
        if not removed:
            return
        with self._snapshot_lock:
            self._snapshot = tuple(record for record in self._snapshot if record.relative_path not in removed)
            self._snapshot_at = time.monotonic()
            self._snapshot_wall_ms = int(time.time() * 1000)
            self._snapshot_version += 1

    def _prune_empty_managed_directories(self) -> None:
        managed_root = os.path.join(self.input_root, LEGACY_UPLOAD_SUBFOLDER)
        if not os.path.isdir(managed_root) or os.path.islink(managed_root):
            return
        for directory, _subdirectories, _files in os.walk(managed_root, topdown=False, followlinks=False):
            try:
                if not os.listdir(directory):
                    os.rmdir(directory)
            except (FileNotFoundError, OSError):
                pass

    def _managed_regular_file(self, relative_path: str) -> Optional[Tuple[str, FileRecord, Tuple[int, int]]]:
        relative = normalize_relative_path(relative_path)
        if not self._is_managed_path(relative):
            raise InvalidUpload("Duplicate cleanup is restricted to the image_conveyor folder.")
        lexical_path = os.path.abspath(os.path.join(self.input_root, *relative.split("/")))
        parent_real = os.path.realpath(os.path.dirname(lexical_path))
        try:
            contained = os.path.commonpath((self.input_root, lexical_path)) == self.input_root
            parent_contained = os.path.commonpath((self.input_root, parent_real)) == self.input_root
        except ValueError:
            contained = False
            parent_contained = False
        if not contained or not parent_contained:
            raise InvalidInputPath("The duplicate path escapes the ComfyUI input directory.")
        try:
            before = os.lstat(lexical_path)
        except (FileNotFoundError, OSError):
            return None
        if not stat_module.S_ISREG(before.st_mode):
            return None
        hashed = stable_file_digest(lexical_path)
        if hashed is None:
            return None
        content_hash, size, mtime_ns = hashed
        try:
            after = os.lstat(lexical_path)
        except (FileNotFoundError, OSError):
            return None
        if (
            not stat_module.S_ISREG(after.st_mode)
            or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
            or after.st_size != size
            or after.st_mtime_ns != mtime_ns
        ):
            return None
        return lexical_path, FileRecord(relative, size, mtime_ns, content_hash), (after.st_dev, after.st_ino)

    def delete_managed_duplicates(
        self,
        groups: Sequence[Dict[str, Any]],
        protected_paths: Sequence[str] = (),
    ) -> Dict[str, Any]:
        deleted = []
        skipped = []
        removed_paths = []
        if not isinstance(groups, (list, tuple)) or len(groups) > 10000:
            raise InvalidUpload("The duplicate cleanup plan is malformed or too large.")
        if not isinstance(protected_paths, (list, tuple)) or len(protected_paths) > 10000:
            raise InvalidUpload("The duplicate cleanup reservation is malformed or too large.")
        protected = set()
        for protected_path in protected_paths:
            relative_path = normalize_relative_path(protected_path)
            if not self._is_managed_path(relative_path):
                raise InvalidUpload("Duplicate cleanup reservations are restricted to the image_conveyor folder.")
            protected.add(relative_path)

        plan = []
        planned_duplicates = 0
        planned_paths = set()
        for group in groups:
            if not isinstance(group, dict):
                raise InvalidUpload("The duplicate cleanup plan is malformed.")
            digest = str(group.get("digest") or "").strip().lower()
            keep_path = normalize_relative_path(group.get("keep_path"))
            duplicates = group.get("duplicates")
            if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
                raise InvalidUpload("The duplicate cleanup plan contains an invalid digest.")
            if not isinstance(duplicates, list):
                raise InvalidUpload("The duplicate cleanup plan is malformed.")
            planned_duplicates += len(duplicates)
            if planned_duplicates > 10000:
                raise InvalidUpload("The duplicate cleanup plan is too large.")

            relative_paths = []
            for duplicate in duplicates:
                if not isinstance(duplicate, dict):
                    raise InvalidUpload("The duplicate cleanup plan is malformed.")
                relative_path = normalize_relative_path(duplicate.get("relative_path"))
                if relative_path == keep_path or not self._is_managed_path(relative_path):
                    raise InvalidUpload("Duplicate cleanup is restricted to the image_conveyor folder.")
                if relative_path in planned_paths:
                    raise InvalidUpload("The duplicate cleanup plan contains a repeated path.")
                planned_paths.add(relative_path)
                relative_paths.append(relative_path)
            plan.append((digest, keep_path, relative_paths))

        presets_relinked = 0

        for digest, keep_path, relative_paths in plan:
            with self._key_lock(self._digest_locks, digest):
                keep = self._record_with_digest(FileRecord(keep_path, -1, -1))
                if keep is None or keep.content_hash != digest:
                    for relative_path in relative_paths:
                        skipped.append(
                            {
                                "relative_path": relative_path,
                                "reason": "The retained file changed or disappeared.",
                            }
                        )
                    continue

                candidates = []
                for relative_path in relative_paths:
                    if relative_path in protected:
                        skipped.append(
                            {
                                "relative_path": relative_path,
                                "reason": "The duplicate is reserved by a queued Conveyor item.",
                            }
                        )
                        continue
                    candidates.append(relative_path)

                with ExitStack() as destination_locks:
                    lock_keys = sorted({relative_path.casefold() for relative_path in candidates})
                    for lock_key in lock_keys:
                        destination_locks.enter_context(
                            self._key_lock(self._destination_locks, lock_key)
                        )

                    validated = []
                    for relative_path in candidates:
                        managed = self._managed_regular_file(relative_path)
                        if managed is None or managed[1].content_hash != digest:
                            skipped.append(
                                {
                                    "relative_path": relative_path,
                                    "reason": "The duplicate changed or disappeared.",
                                }
                            )
                            continue
                        validated.append(managed)

                    # The preset document is durable. Its atomic update must
                    # succeed while every validated destination is locked and
                    # before the first unlink in this digest group.
                    presets_relinked += self.preset_store.relink_paths([
                        {
                            "relative_path": current.relative_path,
                            "keep_path": keep_path,
                        }
                        for _lexical_path, current, _expected_identity in validated
                    ])

                    for lexical_path, current, expected_identity in validated:
                        relative_path = current.relative_path
                        try:
                            identity = os.lstat(lexical_path)
                            if (
                                not stat_module.S_ISREG(identity.st_mode)
                                or (identity.st_dev, identity.st_ino) != expected_identity
                                or identity.st_size != current.size
                                or identity.st_mtime_ns != current.mtime_ns
                            ):
                                raise FileNotFoundError("The duplicate changed after final validation.")
                            os.unlink(lexical_path)
                        except (FileNotFoundError, OSError) as exc:
                            skipped.append({"relative_path": relative_path, "reason": str(exc)})
                            continue
                        try:
                            self.index.remove(relative_path)
                        except (sqlite3.Error, OSError):
                            pass
                        removed_paths.append(relative_path)
                        deleted.append(
                            {
                                "relative_path": relative_path,
                                "keep_path": keep_path,
                                "size": current.size,
                            }
                        )

        self._remove_snapshot_paths(removed_paths)
        self._prune_empty_managed_directories()
        return {
            "deleted": deleted,
            "skipped": skipped,
            "reclaimed_bytes": sum(entry["size"] for entry in deleted),
            "presets_relinked": presets_relinked,
        }

    def verify_image(self, path: str) -> None:
        from PIL import Image

        try:
            with Image.open(path) as image:
                image.verify()
        except Exception as exc:
            raise InvalidUpload("The uploaded file is not a readable supported image.") from exc

    def _prune_thumbnails(self) -> None:
        now = time.time()
        if now - self._last_thumbnail_prune < 24 * 60 * 60:
            return
        self._last_thumbnail_prune = now
        try:
            for entry in os.scandir(self.thumbnail_root):
                if entry.is_file(follow_symlinks=False) and now - entry.stat().st_mtime > THUMBNAIL_MAX_AGE_SECONDS:
                    try:
                        os.unlink(entry.path)
                    except OSError:
                        pass
        except (FileNotFoundError, OSError):
            pass

    def thumbnail(self, relative_path: str, requested_size: int) -> Tuple[str, str]:
        relative = normalize_relative_path(relative_path)
        if Path(relative).suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
            raise InvalidInputPath("Unsupported thumbnail source.")
        source = resolve_under_root(self.input_root, relative, must_exist=True)
        stat = os.stat(source)
        bucket = min(THUMBNAIL_BUCKETS, key=lambda value: abs(value - requested_size))
        identity = f"{relative}\0{stat.st_size}\0{stat.st_mtime_ns}\0{bucket}"
        etag = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        os.makedirs(self.thumbnail_root, exist_ok=True)
        target = os.path.join(self.thumbnail_root, f"{etag}.webp")
        with self._key_lock(self._thumbnail_locks, etag):
            if not os.path.isfile(target):
                from PIL import Image, ImageOps, UnidentifiedImageError

                descriptor, temporary = tempfile.mkstemp(prefix=".thumb-", suffix=".webp", dir=self.thumbnail_root)
                os.close(descriptor)
                try:
                    try:
                        with Image.open(source) as opened:
                            try:
                                opened.seek(0)
                            except EOFError:
                                pass
                            opened.load()
                            image = ImageOps.exif_transpose(opened)
                            resampling = getattr(Image, "Resampling", Image)
                            image.thumbnail((bucket, bucket), resampling.LANCZOS, reducing_gap=2.0)
                            has_alpha = image.mode in {"RGBA", "LA"} or "transparency" in image.info
                            image = image.convert("RGBA" if has_alpha else "RGB")
                    except UnidentifiedImageError as exc:
                        raise InvalidThumbnail("The thumbnail source is not a readable image.") from exc
                    except OSError as exc:
                        if exc.errno is not None:
                            raise
                        raise InvalidThumbnail("The thumbnail source is not a readable image.") from exc
                    image.save(temporary, "WEBP", quality=84, method=4)
                    os.replace(temporary, target)
                finally:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass
            self._prune_thumbnails()
        return target, etag


_SERVICE_LOCK = threading.Lock()
_SERVICE: Optional[InputLibrary] = None
_ROUTES_REGISTERED = False


def _cache_directory(folder_paths_module) -> str:
    try:
        root = folder_paths_module.get_system_user_directory("cache")
    except (AttributeError, ValueError):
        root = os.path.join(folder_paths_module.get_user_directory(), "__cache")
    return os.path.join(root, "image_conveyor")


def _preset_path(folder_paths_module) -> str:
    return os.path.join(
        folder_paths_module.get_user_directory(),
        "image_conveyor",
        "reference-presets.json",
    )


def get_service(folder_paths_module) -> InputLibrary:
    global _SERVICE
    input_root = os.path.realpath(folder_paths_module.get_input_directory())
    cache_root = _cache_directory(folder_paths_module)
    preset_path = _preset_path(folder_paths_module)
    with _SERVICE_LOCK:
        if (
            _SERVICE is None
            or _SERVICE.input_root != input_root
            or _SERVICE.cache_root != cache_root
            or _SERVICE.preset_store.path != preset_path
        ):
            _SERVICE = InputLibrary(
                input_root,
                cache_root,
                preset_path=preset_path,
            )
        return _SERVICE


async def _read_upload(request, service: InputLibrary) -> Tuple[str, str, str, int, str, bool]:
    content_type = request.content_type or ""
    if not content_type.startswith("multipart/"):
        raise InvalidUpload("Expected a multipart upload.")

    os.makedirs(service.upload_temp_root, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(prefix="upload-", suffix=".part", dir=service.upload_temp_root)
    image_seen = False
    filename = ""
    subfolder = ""
    upload_type = "input"
    refresh_snapshot = False
    size = 0
    digest = hashlib.sha256()
    try:
        with os.fdopen(descriptor, "wb") as output:
            reader = await request.multipart()
            async for part in reader:
                if part.name == "image":
                    if image_seen:
                        raise InvalidUpload("Only one image may be uploaded per request.")
                    image_seen = True
                    filename = normalize_filename(part.filename)
                    while True:
                        chunk = await part.read_chunk(size=HASH_CHUNK_SIZE)
                        if not chunk:
                            break
                        output.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                elif part.name == "subfolder":
                    subfolder = (await part.text()).strip()
                elif part.name == "type":
                    upload_type = (await part.text()).strip()
                elif part.name == "refresh_snapshot":
                    refresh_snapshot = (await part.text()).strip().lower() in {"1", "true", "yes"}
                else:
                    await part.release()
            output.flush()
            os.fsync(output.fileno())

        if not image_seen or not filename or size <= 0:
            raise InvalidUpload("The request did not contain an image.")
        if upload_type != "input":
            raise InvalidUpload("Image Conveyor uploads are restricted to ComfyUI input storage.")
        normalize_relative_path(subfolder, allow_empty=True)
        await asyncio.to_thread(service.verify_image, temporary_path)
        return temporary_path, filename, subfolder, size, digest.hexdigest(), refresh_snapshot
    except Exception:
        try:
            os.unlink(temporary_path)
        except OSError:
            pass
        raise


def register_routes() -> None:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return

    import folder_paths
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/image-conveyor/input-files")
    async def image_conveyor_input_files(request):
        service = get_service(folder_paths)
        force = request.rel_url.query.get("refresh", "0") in {"1", "true", "yes"}
        try:
            records, version, scanned_at = await asyncio.to_thread(service.list_files, force=force)
        except Exception:
            LOGGER.exception("Image Conveyor failed to enumerate the input folder.")
            return web.json_response({"error": "Unable to enumerate the ComfyUI input folder."}, status=500)
        return web.json_response(
            {
                "files": [record.as_json() for record in records],
                "snapshot_version": version,
                "scanned_at_ms": scanned_at,
            }
        )

    @routes.post("/image-conveyor/resolve-upload")
    async def image_conveyor_resolve_upload(request):
        service = get_service(folder_paths)
        temporary_path = None
        try:
            temporary_path, filename, subfolder, size, digest, refresh_snapshot = await _read_upload(request, service)
            record, reused = await asyncio.to_thread(
                service.resolve_upload,
                temporary_path,
                filename,
                subfolder,
                size,
                digest,
                refresh_snapshot,
            )
            relative = PurePosixPath(record.relative_path)
            parent = "" if str(relative.parent) == "." else str(relative.parent)
            return web.json_response(
                {
                    "name": relative.name,
                    "subfolder": parent,
                    "relative_path": record.relative_path,
                    "type": "input",
                    "size": record.size,
                    "mtime_ns": record.mtime_ns,
                    "source_version": f"{record.size}-{record.mtime_ns}",
                    "reused": reused,
                }
            )
        except (InvalidUpload, InvalidInputPath) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to resolve an upload.")
            return web.json_response({"error": "Unable to import the image."}, status=500)
        finally:
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    @routes.post("/image-conveyor/managed-duplicates/scan")
    async def image_conveyor_scan_managed_duplicates(_request):
        service = get_service(folder_paths)
        try:
            report = await asyncio.to_thread(service.find_managed_duplicates)
            return web.json_response(report)
        except Exception:
            LOGGER.exception("Image Conveyor failed to scan managed duplicates.")
            return web.json_response({"error": "Unable to scan for exact duplicates."}, status=500)

    @routes.post("/image-conveyor/managed-duplicates/delete")
    async def image_conveyor_delete_managed_duplicates(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            groups = payload.get("groups") if isinstance(payload, dict) else None
            protected_paths = payload.get("protected_paths", []) if isinstance(payload, dict) else None
            if not isinstance(groups, list) or len(groups) > 10000:
                raise InvalidUpload("The duplicate cleanup plan is malformed or too large.")
            if not isinstance(protected_paths, list) or len(protected_paths) > 10000:
                raise InvalidUpload("The duplicate cleanup reservation is malformed or too large.")
            result = await asyncio.to_thread(
                service.delete_managed_duplicates,
                groups,
                protected_paths,
            )
            return web.json_response(result)
        except (InvalidUpload, InvalidInputPath, InvalidPreset, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to delete managed duplicates.")
            return web.json_response({"error": "Unable to delete exact duplicates."}, status=500)

    @routes.get("/image-conveyor/reference-presets")
    async def image_conveyor_list_reference_presets(_request):
        service = get_service(folder_paths)
        try:
            presets = await asyncio.to_thread(service.preset_store.list)
            return web.json_response({"version": PresetStore.VERSION, "presets": presets})
        except Exception:
            LOGGER.exception("Image Conveyor failed to list reference presets.")
            return web.json_response({"error": "Unable to read reference presets."}, status=500)

    @routes.post("/image-conveyor/reference-presets")
    async def image_conveyor_create_reference_preset(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidPreset("The preset request is malformed.")
            preset = await asyncio.to_thread(
                service.preset_store.create,
                payload.get("name"),
                payload.get("slots"),
            )
            return web.json_response({"preset": preset}, status=201)
        except (InvalidPreset, InvalidInputPath, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to create a reference preset.")
            return web.json_response({"error": "Unable to create the reference preset."}, status=500)

    @routes.put("/image-conveyor/reference-presets/{preset_id}")
    async def image_conveyor_update_reference_preset(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidPreset("The preset request is malformed.")
            kwargs = {}
            if "name" in payload:
                kwargs["name"] = payload.get("name")
            if "slots" in payload:
                kwargs["slots"] = payload.get("slots")
            preset = await asyncio.to_thread(
                service.preset_store.update,
                request.match_info["preset_id"],
                **kwargs,
            )
            return web.json_response({"preset": preset})
        except KeyError:
            return web.json_response({"error": "Reference preset not found."}, status=404)
        except (InvalidPreset, InvalidInputPath, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to update a reference preset.")
            return web.json_response({"error": "Unable to update the reference preset."}, status=500)

    @routes.delete("/image-conveyor/reference-presets/{preset_id}")
    async def image_conveyor_delete_reference_preset(request):
        service = get_service(folder_paths)
        try:
            deleted = await asyncio.to_thread(
                service.preset_store.delete,
                request.match_info["preset_id"],
            )
            if not deleted:
                return web.json_response({"error": "Reference preset not found."}, status=404)
            return web.json_response({"deleted": True})
        except (InvalidPreset, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to delete a reference preset.")
            return web.json_response({"error": "Unable to delete the reference preset."}, status=500)

    @routes.get("/image-conveyor/thumbnail")
    async def image_conveyor_thumbnail(request):
        service = get_service(folder_paths)
        relative_path = request.rel_url.query.get("relative_path", "")
        try:
            requested_size = int(request.rel_url.query.get("size", "256"))
        except ValueError:
            requested_size = 256
        requested_size = max(64, min(512, requested_size))
        try:
            path, etag = await asyncio.to_thread(service.thumbnail, relative_path, requested_size)
        except FileNotFoundError:
            return web.Response(status=404)
        except InvalidInputPath as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except InvalidThumbnail:
            LOGGER.warning("Image Conveyor could not decode a thumbnail source.", exc_info=True)
            return web.Response(status=415)
        except Exception:
            LOGGER.exception("Image Conveyor failed to create a thumbnail.")
            return web.Response(status=500)

        quoted_etag = f'"{etag}"'
        cache_control = (
            "private, max-age=31536000, immutable"
            if request.rel_url.query.get("v")
            else "private, max-age=0, must-revalidate"
        )
        if request.headers.get("If-None-Match") == quoted_etag:
            return web.Response(status=304, headers={"ETag": quoted_etag, "Cache-Control": cache_control})
        return web.FileResponse(
            path,
            headers={
                "Content-Type": "image/webp",
                "Content-Disposition": "inline",
                "X-Content-Type-Options": "nosniff",
                "ETag": quoted_etag,
                "Cache-Control": cache_control,
            },
        )

    _ROUTES_REGISTERED = True

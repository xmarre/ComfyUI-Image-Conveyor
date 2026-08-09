import asyncio
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


LOGGER = logging.getLogger(__name__)

SUPPORTED_IMAGE_EXTENSIONS = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"}
)
UPLOAD_SUBFOLDER = "image_conveyor"
HASH_CHUNK_SIZE = 1024 * 1024
SNAPSHOT_TTL_SECONDS = 2.0
THUMBNAIL_BUCKETS = (160, 256, 384, 512)
THUMBNAIL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60


class InvalidInputPath(ValueError):
    pass


class InvalidUpload(ValueError):
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
        try:
            with self._connect() as connection:
                return operation(connection)
        except sqlite3.DatabaseError as exc:
            LOGGER.warning("Image Conveyor duplicate index was corrupt and will be rebuilt: %s", exc)
            self.recover_if_corrupt()
            with self._connect() as connection:
                return operation(connection)

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


class InputLibrary:
    def __init__(self, input_root: str, cache_root: str, snapshot_ttl: float = SNAPSHOT_TTL_SECONDS):
        self.input_root = os.path.realpath(input_root)
        self.cache_root = cache_root
        self.snapshot_ttl = snapshot_ttl
        self.index = ContentIndex(os.path.join(cache_root, "content-index.sqlite3"))
        self.thumbnail_root = os.path.join(cache_root, "thumbnails")
        self.upload_temp_root = os.path.join(cache_root, "uploads")
        self._snapshot: Tuple[FileRecord, ...] = ()
        self._snapshot_at = 0.0
        self._snapshot_wall_ms = 0
        self._snapshot_version = 0
        self._snapshot_lock = threading.Lock()
        self._key_locks_lock = threading.Lock()
        self._digest_locks: Dict[str, threading.Lock] = {}
        self._destination_locks: Dict[str, threading.Lock] = {}
        self._thumbnail_locks: Dict[str, threading.Lock] = {}
        self._last_thumbnail_prune = 0.0

    def _key_lock(self, registry: Dict[str, threading.Lock], key: str) -> threading.Lock:
        with self._key_locks_lock:
            lock = registry.get(key)
            if lock is None:
                lock = threading.Lock()
                registry[key] = lock
            return lock

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

    def _candidate_records(self, file_size: int) -> List[FileRecord]:
        candidates = {record.relative_path: record for record in self._snapshot if record.size == file_size}
        try:
            for record in self.index.records_by_size(file_size):
                candidates[record.relative_path] = record
        except (sqlite3.Error, OSError):
            pass
        return list(candidates.values())

    @staticmethod
    def _canonical_rank(relative_path: str, intended_path: str) -> Tuple[int, str, str]:
        if relative_path == intended_path:
            rank = 0
        elif relative_path == UPLOAD_SUBFOLDER or relative_path.startswith(f"{UPLOAD_SUBFOLDER}/"):
            rank = 1
        else:
            rank = 2
        return rank, relative_path.casefold(), relative_path

    def _find_duplicate(self, intended_path: str, size: int, digest: str) -> Optional[FileRecord]:
        candidates = sorted(
            self._candidate_records(size),
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
    ) -> Tuple[FileRecord, bool]:
        filename = normalize_filename(filename)
        normalized_subfolder = normalize_relative_path(subfolder, allow_empty=True)
        intended = f"{normalized_subfolder}/{filename}" if normalized_subfolder else filename
        resolve_under_root(self.input_root, intended)

        # Enumeration is metadata-only and cached across a batch. It makes fresh installs
        # aware of pre-existing same-size candidates without hashing the whole input tree.
        self.list_files(force=False)

        digest_lock = self._key_lock(self._digest_locks, digest)
        with digest_lock:
            duplicate = self._find_duplicate(intended, size, digest)
            if duplicate is not None:
                self._patch_snapshot(duplicate)
                return duplicate, True

            destination_lock = self._key_lock(self._destination_locks, intended.casefold())
            with destination_lock:
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
        lock = self._key_lock(self._thumbnail_locks, etag)
        with lock:
            if not os.path.isfile(target):
                from PIL import Image, ImageOps

                descriptor, temporary = tempfile.mkstemp(prefix=".thumb-", suffix=".webp", dir=self.thumbnail_root)
                os.close(descriptor)
                try:
                    with Image.open(source) as opened:
                        try:
                            opened.seek(0)
                        except EOFError:
                            pass
                        image = ImageOps.exif_transpose(opened)
                        image.thumbnail((bucket, bucket), Image.Resampling.LANCZOS, reducing_gap=2.0)
                        has_alpha = image.mode in {"RGBA", "LA"} or "transparency" in image.info
                        image = image.convert("RGBA" if has_alpha else "RGB")
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


def get_service(folder_paths_module) -> InputLibrary:
    global _SERVICE
    input_root = os.path.realpath(folder_paths_module.get_input_directory())
    cache_root = _cache_directory(folder_paths_module)
    with _SERVICE_LOCK:
        if _SERVICE is None or _SERVICE.input_root != input_root or _SERVICE.cache_root != cache_root:
            _SERVICE = InputLibrary(input_root, cache_root)
        return _SERVICE


async def _read_upload(request, service: InputLibrary) -> Tuple[str, str, str, int, str]:
    content_type = request.content_type or ""
    if not content_type.startswith("multipart/"):
        raise InvalidUpload("Expected a multipart upload.")

    os.makedirs(service.upload_temp_root, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(prefix="upload-", suffix=".part", dir=service.upload_temp_root)
    image_seen = False
    filename = ""
    subfolder = ""
    upload_type = "input"
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
        return temporary_path, filename, subfolder, size, digest.hexdigest()
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
            temporary_path, filename, subfolder, size, digest = await _read_upload(request, service)
            record, reused = await asyncio.to_thread(
                service.resolve_upload,
                temporary_path,
                filename,
                subfolder,
                size,
                digest,
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
        except Exception:
            LOGGER.exception("Image Conveyor failed to create a thumbnail.")
            return web.Response(status=415)

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

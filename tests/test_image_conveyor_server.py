import importlib.util
import os
import sqlite3
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "image_conveyor_server.py"
SPEC = importlib.util.spec_from_file_location("image_conveyor_server_under_test", MODULE_PATH)
server = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(server)


class MultipartPartStub:
    def __init__(self, name, *, filename=None, contents=b"", text_value=""):
        self.name = name
        self.filename = filename
        self._chunks = [contents] if contents else []
        self._text = text_value
        self.released = False

    async def read_chunk(self, size):
        del size
        return self._chunks.pop(0) if self._chunks else b""

    async def text(self):
        return self._text

    async def release(self):
        self.released = True


class MultipartReaderStub:
    def __init__(self, parts):
        self._parts = iter(parts)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._parts)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class UploadRequestStub:
    def __init__(self, content_type, parts=()):
        self.content_type = content_type
        self._parts = parts

    async def multipart(self):
        return MultipartReaderStub(self._parts)


class InputLibraryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.input_root = os.path.join(self.temporary.name, "input")
        self.cache_root = os.path.join(self.temporary.name, "cache")
        os.makedirs(self.input_root)
        self.library = server.InputLibrary(self.input_root, self.cache_root, snapshot_ttl=60)

    def tearDown(self):
        self.temporary.cleanup()

    def write_input(self, relative_path, contents):
        path = os.path.join(self.input_root, *relative_path.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(contents)
        return path

    def make_upload(self, contents):
        os.makedirs(self.cache_root, exist_ok=True)
        descriptor, path = tempfile.mkstemp(dir=self.cache_root)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(contents)
        return path, len(contents), server.hashlib.sha256(contents).hexdigest()

    def resolve(self, contents, filename="picture.png", subfolder="image_conveyor"):
        path, size, digest = self.make_upload(contents)
        try:
            return self.library.resolve_upload(path, filename, subfolder, size, digest)
        finally:
            os.unlink(path)

    def test_same_filename_same_bytes_reuses_physical_file(self):
        first, first_reused = self.resolve(b"same", "same.png")
        second, second_reused = self.resolve(b"same", "same.png")
        self.assertFalse(first_reused)
        self.assertTrue(second_reused)
        self.assertEqual(first.relative_path, second.relative_path)
        self.assertEqual(1, len(self.library.list_files(force=True)[0]))

    def test_indexed_duplicate_hashes_incoming_once_and_does_not_rehash_existing(self):
        self.write_input("existing.png", b"cached-content")
        calls = []
        original = server.stable_file_digest

        def counting_digest(path):
            calls.append(path)
            return original(path)

        server.stable_file_digest = counting_digest
        try:
            first, first_reused = self.resolve(b"cached-content", "first.png")
            second, second_reused = self.resolve(b"cached-content", "second.png")
        finally:
            server.stable_file_digest = original
        self.assertTrue(first_reused)
        self.assertTrue(second_reused)
        self.assertEqual(first.relative_path, second.relative_path)
        self.assertEqual(1, len(calls))

    def test_different_filename_and_subfolder_same_bytes_reuses_existing(self):
        self.write_input("references/original.png", b"identical")
        record, reused = self.resolve(b"identical", "renamed.png", "image_conveyor/drop")
        self.assertTrue(reused)
        self.assertEqual("references/original.png", record.relative_path)
        self.assertFalse(os.path.exists(os.path.join(self.input_root, "image_conveyor", "drop", "renamed.png")))

    def test_root_upload_reuses_same_named_file_added_after_cached_snapshot(self):
        self.write_input("already-indexed.png", b"other")
        self.library.list_files(force=True)
        self.write_input("fresh.png", b"fresh")

        record, reused = self.resolve(b"fresh", "fresh.png", "")

        self.assertTrue(reused)
        self.assertEqual("fresh.png", record.relative_path)
        self.assertFalse(os.path.exists(os.path.join(self.input_root, "image_conveyor", "fresh.png")))

    def test_batch_refresh_finds_differently_named_file_added_after_cached_snapshot(self):
        self.write_input("already-indexed.png", b"other")
        self.library.list_files(force=True)
        self.write_input("fresh-existing.png", b"fresh")
        path, size, digest = self.make_upload(b"fresh")
        try:
            record, reused = self.library.resolve_upload(
                path,
                "incoming-name.png",
                "",
                size,
                digest,
                refresh_snapshot=True,
            )
        finally:
            os.unlink(path)

        self.assertTrue(reused)
        self.assertEqual("fresh-existing.png", record.relative_path)
        self.assertFalse(os.path.exists(os.path.join(self.input_root, "incoming-name.png")))

    def test_new_root_upload_does_not_create_managed_subfolder(self):
        record, reused = self.resolve(b"new", "new.png", "")
        self.assertFalse(reused)
        self.assertEqual("new.png", record.relative_path)
        self.assertFalse(os.path.exists(os.path.join(self.input_root, "image_conveyor")))

    def test_same_filename_different_bytes_is_collision_safe(self):
        first, _ = self.resolve(b"first", "same.png")
        second, reused = self.resolve(b"other", "same.png")
        self.assertFalse(reused)
        self.assertEqual("image_conveyor/same.png", first.relative_path)
        self.assertEqual("image_conveyor/same (1).png", second.relative_path)

    def test_same_size_different_bytes_remain_separate(self):
        self.write_input("existing.png", b"abcd")
        record, reused = self.resolve(b"wxyz", "new.png")
        self.assertFalse(reused)
        self.assertNotEqual("existing.png", record.relative_path)

    def test_modified_file_invalidates_cached_digest(self):
        existing = self.write_input("existing.png", b"abcd")
        first, reused = self.resolve(b"abcd", "one.png")
        self.assertTrue(reused)
        self.assertEqual("existing.png", first.relative_path)

        with open(existing, "wb") as handle:
            handle.write(b"wxyz")
        stat = os.stat(existing)
        os.utime(existing, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        self.library.invalidate_snapshot()

        second, reused = self.resolve(b"abcd", "two.png")
        self.assertFalse(reused)
        self.assertEqual("image_conveyor/two.png", second.relative_path)

    def test_removed_index_entry_is_not_resolved(self):
        existing = self.write_input("gone.png", b"same")
        self.library.list_files(force=True)
        os.unlink(existing)
        self.library.invalidate_snapshot()
        record, reused = self.resolve(b"same", "replacement.png")
        self.assertFalse(reused)
        self.assertEqual("image_conveyor/replacement.png", record.relative_path)

    def test_canonical_selection_prefers_intended_then_regular_input_then_managed_path(self):
        self.write_input("a.png", b"same")
        self.write_input("image_conveyor/z.png", b"same")
        self.write_input("intended/exact.png", b"same")
        record, reused = self.resolve(b"same", "exact.png", "intended")
        self.assertTrue(reused)
        self.assertEqual("intended/exact.png", record.relative_path)

        os.unlink(os.path.join(self.input_root, "intended", "exact.png"))
        self.library.invalidate_snapshot()
        record, reused = self.resolve(b"same", "other.png", "somewhere")
        self.assertTrue(reused)
        self.assertEqual("a.png", record.relative_path)

    def test_managed_duplicate_report_keeps_regular_input_and_ignores_unique_files(self):
        self.write_input("original.png", b"same")
        self.write_input("also-original.png", b"same")
        self.write_input("image_conveyor/copy.png", b"same")
        self.write_input("image_conveyor/unique.png", b"unique")

        report = self.library.find_managed_duplicates()

        self.assertEqual(1, report["duplicate_count"])
        self.assertEqual(len(b"same"), report["reclaimable_bytes"])
        self.assertEqual("also-original.png", report["groups"][0]["keep_path"])
        self.assertEqual(
            ["image_conveyor/copy.png"],
            [entry["relative_path"] for entry in report["groups"][0]["duplicates"]],
        )

    def test_managed_duplicate_cleanup_revalidates_deletes_and_prunes_empty_folder(self):
        self.write_input("original.png", b"same")
        duplicate = self.write_input("image_conveyor/copy.png", b"same")
        report = self.library.find_managed_duplicates()

        result = self.library.delete_managed_duplicates(report["groups"])

        self.assertEqual(
            [{"relative_path": "image_conveyor/copy.png", "keep_path": "original.png", "size": 4}],
            result["deleted"],
        )
        self.assertEqual([], result["skipped"])
        self.assertFalse(os.path.exists(duplicate))
        self.assertFalse(os.path.exists(os.path.join(self.input_root, "image_conveyor")))
        self.assertTrue(os.path.exists(os.path.join(self.input_root, "original.png")))
        self.assertNotIn(
            "image_conveyor/copy.png",
            {record.relative_path for record in self.library.list_files(force=False)[0]},
        )

    def test_managed_duplicate_cleanup_skips_file_changed_after_preview(self):
        self.write_input("original.png", b"same")
        duplicate = self.write_input("image_conveyor/copy.png", b"same")
        report = self.library.find_managed_duplicates()
        with open(duplicate, "wb") as handle:
            handle.write(b"changed")

        result = self.library.delete_managed_duplicates(report["groups"])

        self.assertEqual([], result["deleted"])
        self.assertEqual("image_conveyor/copy.png", result["skipped"][0]["relative_path"])
        self.assertTrue(os.path.exists(duplicate))

    def test_managed_duplicate_cleanup_never_unlinks_symlink_destination(self):
        original = self.write_input("original.png", b"same")
        duplicate = self.write_input("image_conveyor/copy.png", b"same")
        report = self.library.find_managed_duplicates()
        os.unlink(duplicate)
        try:
            os.symlink(original, duplicate)
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks are unavailable on this platform")

        result = self.library.delete_managed_duplicates(report["groups"])

        self.assertEqual([], result["deleted"])
        self.assertEqual("image_conveyor/copy.png", result["skipped"][0]["relative_path"])
        self.assertTrue(os.path.exists(original))
        self.assertTrue(os.path.islink(duplicate))

    def test_managed_duplicate_cleanup_rejects_deletion_outside_legacy_folder(self):
        first = self.write_input("first.png", b"same")
        second = self.write_input("second.png", b"same")
        digest = server.hashlib.sha256(b"same").hexdigest()

        with self.assertRaises(server.InvalidUpload):
            self.library.delete_managed_duplicates(
                [{"digest": digest, "keep_path": "first.png", "duplicates": [{"relative_path": "second.png"}]}]
            )

        self.assertTrue(os.path.exists(first))
        self.assertTrue(os.path.exists(second))

    def test_concurrent_identical_uploads_create_one_file(self):
        barrier = threading.Barrier(2)

        def worker(filename):
            path, size, digest = self.make_upload(b"concurrent")
            try:
                barrier.wait()
                return self.library.resolve_upload(path, filename, "image_conveyor", size, digest)
            finally:
                os.unlink(path)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(worker, ("a.png", "b.png")))
        records = self.library.list_files(force=True)[0]
        self.assertEqual(1, len(records))
        self.assertEqual(results[0][0].relative_path, results[1][0].relative_path)
        self.assertEqual([False, True], sorted(result[1] for result in results))
        self.assertEqual({}, self.library._digest_locks)
        self.assertEqual({}, self.library._destination_locks)

    def test_concurrent_different_uploads_both_succeed(self):
        barrier = threading.Barrier(2)

        def worker(args):
            filename, contents = args
            path, size, digest = self.make_upload(contents)
            try:
                barrier.wait()
                return self.library.resolve_upload(path, filename, "image_conveyor", size, digest)
            finally:
                os.unlink(path)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(worker, (("a.png", b"a"), ("b.png", b"b"))))
        self.assertEqual(2, len(self.library.list_files(force=True)[0]))
        self.assertTrue(all(not reused for _record, reused in results))

    def test_duplicate_resolution_survives_index_update_failure(self):
        original_update = self.library.index.update_digest
        original_candidates = self.library.index.records_by_size
        self.library.index.update_digest = lambda *_args, **_kwargs: (_ for _ in ()).throw(sqlite3.OperationalError("locked"))
        self.library.index.records_by_size = lambda _size: []
        try:
            first, first_reused = self.resolve(b"fallback", "first.png")
            second, second_reused = self.resolve(b"fallback", "second.png")
        finally:
            self.library.index.update_digest = original_update
            self.library.index.records_by_size = original_candidates
        self.assertFalse(first_reused)
        self.assertTrue(second_reused)
        self.assertEqual(first.relative_path, second.relative_path)

    def test_corrupt_index_is_rebuilt(self):
        os.makedirs(self.cache_root, exist_ok=True)
        with open(self.library.index.db_path, "wb") as handle:
            handle.write(b"not sqlite")
        record, reused = self.resolve(b"data", "recovered.png")
        self.assertFalse(reused)
        self.assertEqual("image_conveyor/recovered.png", record.relative_path)
        self.assertTrue(os.path.exists(self.library.index.db_path))

    def test_index_connections_close_before_corruption_recovery(self):
        connections = []
        recoveries = []

        class ConnectionStub:
            def __init__(self):
                self.closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def close(self):
                self.closed = True

        def connect():
            connection = ConnectionStub()
            connections.append(connection)
            return connection

        attempts = 0

        def operation(_connection):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise sqlite3.DatabaseError("corrupt")
            return "recovered"

        self.library.index._connect = connect
        self.library.index.recover_if_corrupt = lambda: recoveries.append(True)
        self.assertEqual("recovered", self.library.index._run(operation))
        self.assertEqual([True], recoveries)
        self.assertEqual(2, len(connections))
        self.assertTrue(all(connection.closed for connection in connections))

    def test_listing_is_recursive_deterministic_and_filters_extensions(self):
        for index in range(1000):
            self.write_input(f"nested/{index:04d}.png", bytes([index % 251]))
        self.write_input("nested/ignore.txt", b"not an image")
        records, _version, _scanned_at = self.library.list_files(force=True)
        self.assertEqual(1000, len(records))
        self.assertEqual("nested/0000.png", records[0].relative_path)
        self.assertEqual("nested/0999.png", records[-1].relative_path)

        os.unlink(os.path.join(self.input_root, "nested", "0000.png"))
        self.write_input("external.png", b"new")
        records, _version, _scanned_at = self.library.list_files(force=True)
        paths = {record.relative_path for record in records}
        self.assertNotIn("nested/0000.png", paths)
        self.assertIn("external.png", paths)

    def test_thumbnail_is_bounded_cached_and_invalidated_by_source_identity(self):
        if importlib.util.find_spec("PIL") is None:
            self.skipTest("Pillow is not installed")
        from PIL import Image

        source = self.write_input("large.png", b"")
        Image.new("RGBA", (1200, 600), (255, 0, 0, 128)).save(source, "PNG")
        first_path, first_etag = self.library.thumbnail("large.png", 256)
        second_path, second_etag = self.library.thumbnail("large.png", 256)
        self.assertEqual(first_path, second_path)
        self.assertEqual(first_etag, second_etag)
        with Image.open(first_path) as thumbnail:
            self.assertLessEqual(max(thumbnail.size), 256)
            alpha = thumbnail.convert("RGBA").getchannel("A")
            self.assertNotEqual((255, 255), alpha.getextrema())

        Image.new("RGB", (800, 800), (0, 0, 255)).save(source, "PNG")
        stat = os.stat(source)
        os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        third_path, third_etag = self.library.thumbnail("large.png", 256)
        self.assertNotEqual(first_etag, third_etag)
        self.assertNotEqual(first_path, third_path)
        self.assertEqual({}, self.library._thumbnail_locks)

    def test_unreadable_thumbnail_source_is_classified_as_invalid_media(self):
        if importlib.util.find_spec("PIL") is None:
            self.skipTest("Pillow is not installed")
        self.write_input("broken.png", b"not an image")
        with self.assertRaises(server.InvalidThumbnail):
            self.library.thumbnail("broken.png", 256)
        self.assertEqual({}, self.library._thumbnail_locks)


class UploadValidationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.upload_root = os.path.join(self.temporary.name, "uploads")
        self.service = types.SimpleNamespace(
            upload_temp_root=self.upload_root,
            verify_image=lambda _path: None,
        )

    def tearDown(self):
        self.temporary.cleanup()

    async def assert_rejected(self, request):
        with self.assertRaises(server.InvalidUpload):
            await server._read_upload(request, self.service)
        if os.path.isdir(self.upload_root):
            self.assertEqual([], os.listdir(self.upload_root))

    async def test_rejects_non_multipart_content_type(self):
        await self.assert_rejected(UploadRequestStub("application/json"))

    async def test_rejects_requests_without_exactly_one_image_part(self):
        requests = (
            UploadRequestStub("multipart/form-data", []),
            UploadRequestStub(
                "multipart/form-data",
                [
                    MultipartPartStub("image", filename="first.png", contents=b"first"),
                    MultipartPartStub("image", filename="second.png", contents=b"second"),
                ],
            ),
        )
        for request in requests:
            with self.subTest(parts=request._parts):
                await self.assert_rejected(request)

    async def test_rejects_non_input_upload_type(self):
        await self.assert_rejected(
            UploadRequestStub(
                "multipart/form-data",
                [
                    MultipartPartStub("image", filename="image.png", contents=b"image"),
                    MultipartPartStub("type", text_value="output"),
                ],
            )
        )


class PathValidationTest(unittest.TestCase):
    def test_rejects_traversal_and_absolute_paths(self):
        for value in ("../escape.png", "folder/../escape.png", "/tmp/a.png", "C:\\tmp\\a.png", "\\\\server\\share\\a.png"):
            with self.subTest(value=value), self.assertRaises(server.InvalidInputPath):
                server.normalize_relative_path(value)

    def test_accepts_nested_unicode_path(self):
        self.assertEqual("人物/été/画像.png", server.normalize_relative_path("人物/été/画像.png"))

    def test_rejects_unsupported_extension_and_filename_path(self):
        for value in ("image.svg", "folder/image.png", "folder\\image.png"):
            with self.subTest(value=value), self.assertRaises(server.InvalidUpload):
                server.normalize_filename(value)

    def test_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = os.path.join(temporary, "input")
            outside = os.path.join(temporary, "outside")
            os.makedirs(root)
            os.makedirs(outside)
            try:
                os.symlink(outside, os.path.join(root, "escape"))
            except (OSError, NotImplementedError):
                self.skipTest("Symlinks are unavailable on this platform")
            with self.assertRaises(server.InvalidInputPath):
                server.resolve_under_root(root, "escape/file.png")


if __name__ == "__main__":
    unittest.main()

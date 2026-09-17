import hashlib
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile
from sources import ExportSources, source_digest


def e57_bytes(payload):
    header = bytearray(48)
    header[:8] = b'ASTM-E57'
    struct.pack_into('<Q', header, 16, len(header) + len(payload))
    return bytes(header) + payload


class ExportSourceTests(unittest.TestCase):
    def test_separate_scratch_keeps_original_and_processed_storage_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'external/export.zip'
            archive.parent.mkdir()
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
                out.writestr('cloud.e57', e57_bytes(b'measured original'))
            processed = root / 'external/processed'
            processed.mkdir()
            (processed / 'manifest.json').write_text('existing metadata')
            scratch = root / 'internal/scratch/capture'
            sources = ExportSources(archive, processed, discard=True, cache_directory=scratch)
            for path, _ in sources:
                self.assertEqual(path.parent, scratch)
                self.assertTrue(path.exists())
            self.assertFalse(path.exists())
            self.assertFalse((processed / 'source').exists())
            self.assertEqual((processed / 'manifest.json').read_text(), 'existing metadata')
            self.assertTrue(archive.exists())

    def test_split_archive_reads_all_parts_and_releases_only_extracted_caches(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'capture.zip'
            parts = [e57_bytes(b'first'), e57_bytes(b'second')]
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
                for index, payload in enumerate(parts):
                    out.writestr(f'cloud_{index}.e57', payload)
            sources = ExportSources(archive, root / 'processed', discard=True)
            previous = None
            for index, (path, record) in enumerate(sources):
                if previous: self.assertFalse(previous.exists())
                self.assertEqual(path.read_bytes(), parts[index])
                self.assertEqual(record['sha256'], hashlib.sha256(parts[index]).hexdigest())
                previous = path
            self.assertFalse(previous.exists())
            self.assertTrue(archive.exists())
            self.assertEqual(len(sources.records), 2)
            self.assertNotEqual(source_digest(sources.records), source_digest(list(reversed(sources.records))))

    def test_original_raw_e57_is_never_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'original.e57'
            source.write_bytes(e57_bytes(b'original'))
            sources = ExportSources(source, root / 'processed', discard=True)
            list(sources)
            self.assertTrue(source.exists())
            self.assertEqual(source_digest(sources.records), hashlib.sha256(source.read_bytes()).hexdigest())

    def test_mismatched_header_is_rejected_before_any_part_is_yielded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'bad.zip'
            with zipfile.ZipFile(source, 'w') as out:
                out.writestr('cloud_0.e57', e57_bytes(b'complete')[:-2])
            with self.assertRaisesRegex(ValueError, 'physical file length'):
                list(ExportSources(source, root / 'processed'))

    def test_archive_paths_cannot_escape_the_fixed_cache_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'capture.zip'
            with zipfile.ZipFile(source, 'w') as out:
                out.writestr('../elsewhere.e57', e57_bytes(b'points'))
            [(path, _)] = list(ExportSources(source, root / 'processed'))
            self.assertEqual(path, root / 'processed/source/cloud_0.e57')
            self.assertFalse((root / 'elsewhere.e57').exists())


if __name__ == '__main__':
    unittest.main()

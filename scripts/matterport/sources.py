"""Checked, sequential access to every E57 member, with bounded extraction disk use."""
import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys
import zipfile
import zlib


def source_digest(parts):
    if len(parts) == 1:
        return parts[0]['sha256']
    binding = [{key: part[key] for key in ('member', 'bytes', 'sha256')} for part in parts]
    return hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()


def check_header(path):
    with path.open('rb') as stream:
        header = stream.read(48)
    if len(header) != 48 or header[:8] != b'ASTM-E57' or struct.unpack_from('<Q', header, 16)[0] != path.stat().st_size:
        raise ValueError('E57 header/physical file length mismatch; source is incomplete or corrupt')


def file_checksums(path):
    digest, crc = hashlib.sha256(), 0
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
    return digest.hexdigest(), crc


class ExportSources:
    def __init__(self, source, processed, discard=False, cache_directory=None):
        self.source, self.processed, self.discard = Path(source), Path(processed), discard
        self.cache_directory = Path(cache_directory) if cache_directory is not None else self.processed / 'source'
        self.snapshot = (self.source.stat().st_size, self.source.stat().st_mtime_ns)
        self.records = []
        self.current = None
        if self.source.suffix.lower() == '.zip':
            with zipfile.ZipFile(self.source) as archive:
                self.entries = sorted((item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith('.e57')), key=lambda item: item.filename)
            if not self.entries or len({item.filename for item in self.entries}) != len(self.entries):
                raise ValueError('ZIP must contain distinct E57 members')
        else:
            self.entries = [None]

    def __iter__(self):
        for index, entry in enumerate(self.entries):
            target = self.source if entry is None else self.cache_directory / f'cloud_{index}.e57'
            if entry is None:
                digest, _ = file_checksums(target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                digest, crc = file_checksums(target) if target.exists() and target.stat().st_size == entry.file_size else ('', -1)
                if crc != entry.CRC:
                    temporary = target.with_suffix('.extracting')
                    temporary.unlink(missing_ok=True)
                    if shutil.disk_usage(target.parent).free < entry.file_size + 1024**3:
                        raise ValueError(f'Not enough extraction space for {entry.filename}: need {entry.file_size + 1024**3:,} free bytes')
                    print(f'extracting part {index + 1}/{len(self.entries)}: {entry.filename} ({entry.file_size:,} bytes)', file=sys.stderr, flush=True)
                    hasher = hashlib.sha256()
                    try:
                        with zipfile.ZipFile(self.source) as archive, archive.open(entry) as src, temporary.open('wb') as dst:
                            for chunk in iter(lambda: src.read(8 * 1024 * 1024), b''):
                                dst.write(chunk)
                                hasher.update(chunk)
                        temporary.replace(target)
                    finally:
                        temporary.unlink(missing_ok=True)
                    digest = hasher.hexdigest()
            check_header(target)
            record = {'part': index, 'member': entry.filename if entry else self.source.name, 'bytes': target.stat().st_size, 'sha256': digest}
            self.records.append(record)
            self.current = (target, entry, record)
            print(f'source part {index + 1}/{len(self.entries)}: {target} ({record["bytes"]:,} bytes)', file=sys.stderr, flush=True)
            complete = False
            try:
                yield target, record
                complete = True
            finally:
                if complete and entry is not None and self.discard:
                    target.unlink(missing_ok=True)
        if (self.source.stat().st_size, self.source.stat().st_mtime_ns) != self.snapshot:
            raise ValueError('Source download changed during import')

    def release_verified(self, path, check):
        """Release only the active derived member after its source validation."""
        target, entry, record = self.current
        if path != target or any(record[key] != check[key] for key in ('bytes', 'sha256')):
            raise ValueError('Extraction release requires the active verified source part')
        if self.discard and entry is not None:
            target.unlink(missing_ok=True)

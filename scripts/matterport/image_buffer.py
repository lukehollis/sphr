"""Optional per-part JPEG buffering when extraction and images cannot share a disk."""
from io import BytesIO
import hashlib


class ImageBuffer:
    def __init__(self, limit=12 * 1024**3):
        self.limit, self.bytes = limit, 0
        self.images = {}

    def save(self, path, image):
        output = BytesIO()
        image.save(output, format='JPEG', quality=94, subsampling=0)
        content = output.getvalue()
        size = self.bytes + len(content) - len(self.images.get(path, b''))
        if size > self.limit:
            raise ValueError('The image buffer limit was exceeded; use a larger scratch disk for this export')
        self.images[path] = content
        self.bytes = size
        return hashlib.sha256(content).hexdigest()

    def source(self, path):
        return BytesIO(self.images[path]) if path in self.images else path

    def flush(self):
        for path in list(self.images):
            path.parent.mkdir(parents=True, exist_ok=True)
            content = self.images[path]
            path.write_bytes(content)
            self.bytes -= len(content)
            del self.images[path]

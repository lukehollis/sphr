import hashlib
from pathlib import Path
import tempfile
import unittest
import numpy as np
from PIL import Image
from image_buffer import ImageBuffer


class ImageBufferTests(unittest.TestCase):
    def test_buffered_fusion_reads_and_delivered_jpegs_match_disk_encoding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            photo=Image.fromarray(np.random.default_rng(4).integers(0,256,(64,64,3),dtype=np.uint8))
            direct=root/'direct.jpg'; buffered=root/'faces/face0.jpg'
            photo.save(direct,quality=94,subsampling=0)
            store=ImageBuffer()
            checksum=store.save(buffered,photo)
            self.assertFalse(buffered.exists())
            self.assertEqual(checksum,hashlib.sha256(direct.read_bytes()).hexdigest())
            with Image.open(store.source(buffered)) as decoded, Image.open(direct) as reference:
                np.testing.assert_array_equal(np.asarray(decoded),np.asarray(reference))
            store.flush()
            self.assertEqual(buffered.read_bytes(),direct.read_bytes())
            self.assertEqual(store.bytes,0)
            self.assertEqual(store.images,{})

    def test_limit_fails_before_retaining_more_data(self):
        store=ImageBuffer(limit=10)
        with self.assertRaisesRegex(ValueError,'buffer limit'):
            store.save(Path('unused.jpg'),Image.new('RGB',(32,32)))
        self.assertEqual(store.bytes,0)
        self.assertEqual(store.images,{})


if __name__=='__main__':
    unittest.main()

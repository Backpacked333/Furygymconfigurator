import tempfile
from pathlib import Path
import struct
import unittest

from texture_pilot import MAGIC, encode_args, memory_model, mip_sizes, read_ktx_header, verify


class TexturePilotTests(unittest.TestCase):
    def test_full_mips_include_block_minimums_and_non_square_tail(self):
        self.assertEqual(mip_sizes(5, 2), [(5, 2), (2, 1), (1, 1)])
        self.assertEqual(memory_model(5, 2)["fullMipRGBA8Bytes"], 52)
        self.assertEqual(memory_model(5, 2)["fullMipBlock4x4_16ByteBytes"], 64)
        self.assertEqual(memory_model(1024, 1024)["fullMipRGBA8Bytes"], 5592404)
        self.assertEqual(memory_model(1024, 1024)["fullMipBlock4x4_16ByteBytes"], 1398128)

    def test_reject_invalid_dimensions(self):
        for dimensions in [(0, 1), (-1, 2), (1.5, 2)]:
            with self.assertRaises(ValueError):
                mip_sizes(*dimensions)

    def test_color_and_data_roles_do_not_silently_swizzle_normals(self):
        color = encode_args("toktx", "albedo", "out", "in")
        normal = encode_args("toktx", "normal", "out", "in")
        arm = encode_args("toktx", "arm", "out", "in")
        self.assertIn("srgb", color)
        self.assertIn("etc1s", color)
        self.assertIn("linear", normal)
        self.assertIn("uastc", normal)
        self.assertIn("--normalize", normal)
        self.assertNotIn("--normal_mode", normal)
        self.assertNotIn("--normalize", arm)
        self.assertIn("--lower_left_maps_to_s0t0", normal)
        self.assertEqual(normal[normal.index("--threads") + 1], "1")

    def test_truncated_ktx_and_source_drift_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.ktx2"
            path.write_bytes(b"not ktx")
            with self.assertRaises(ValueError):
                read_ktx_header(path)
            with self.assertRaises(ValueError):
                verify(path, "0" * 64)
            data = bytearray(104)
            data[:12] = MAGIC
            struct.pack_into("<9I", data, 12, 0, 1, 4, 4, 0, 0, 1, 1, 1)
            struct.pack_into("<3Q", data, 80, 104, 10, 16)
            path.write_bytes(data)
            with self.assertRaises(ValueError):
                read_ktx_header(path)
            path.write_bytes(data + b"0" * 10)
            self.assertEqual(read_ktx_header(path)["levelBytes"], [10])


if __name__ == "__main__":
    unittest.main()

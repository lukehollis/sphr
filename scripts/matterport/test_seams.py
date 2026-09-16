import unittest

from seams import assess_seams


class SourceSeamTests(unittest.TestCase):
    def test_source_native_edge_difference_is_reported(self):
        source = [0.129] + [0.02] * 11
        derived = [0.131] + [0.021] * 11
        quality = assess_seams(derived, source)
        self.assertTrue(quality["sourceLimited"])
        self.assertLess(quality["conversionDifferenceMax"], 0.003)

    def test_conversion_damage_is_rejected_even_with_source_baseline(self):
        with self.assertRaisesRegex(ValueError, "differs from original"):
            assess_seams([0.18] + [0.02] * 11, [0.129] + [0.02] * 11)

    def test_high_error_without_source_evidence_still_fails(self):
        with self.assertRaisesRegex(ValueError, "without an original"):
            assess_seams([0.13] + [0.02] * 11)

    def test_malformed_source_baseline_is_rejected(self):
        with self.assertRaises(ValueError):
            assess_seams([0.02] * 12, [0.02] * 11)
        with self.assertRaises(ValueError):
            assess_seams([0.02] * 12, [float("nan")] * 12)

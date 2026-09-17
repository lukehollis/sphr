import unittest
from converter import initial_explore_node


class EntryTests(unittest.TestCase):
    def test_starts_in_main_reachable_area_without_dropping_other_scans(self):
        nodes = [{'uuid': 'isolated', 'neighbors': []},
                 {'uuid': 'main-1', 'neighbors': ['main-2', 'main-3']},
                 {'uuid': 'main-2', 'neighbors': ['main-1']},
                 {'uuid': 'main-3', 'neighbors': ['main-1']},
                 {'uuid': 'side-1', 'neighbors': ['side-2']},
                 {'uuid': 'side-2', 'neighbors': ['side-1']}]
        self.assertEqual(initial_explore_node(nodes)['uuid'], 'main-1')
        self.assertEqual(nodes[0]['uuid'], 'isolated')
        self.assertEqual(len(nodes), 6)

    def test_preserves_first_scan_when_already_connected(self):
        nodes = [{'uuid': 'first', 'neighbors': ['second']}, {'uuid': 'second', 'neighbors': ['first']}]
        self.assertEqual(initial_explore_node(nodes)['uuid'], 'first')
        self.assertIsNone(initial_explore_node([]))


if __name__ == '__main__':
    unittest.main()

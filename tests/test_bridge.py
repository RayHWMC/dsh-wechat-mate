import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import wxwatch
import wxsend
import wxread


def chat(*texts):
    return {"chat": "Alice", "messages": [{"dir": "in", "text": t} for t in texts]}


class BridgeTests(unittest.TestCase):
    def test_mentions_ignore_empty_and_prefix_aliases(self):
        self.assertFalse(wxwatch.mentioned_me("@anyone", [""]))
        self.assertFalse(wxwatch.mentioned_me("@Alice2 hi", ["Alice"]))
        self.assertTrue(wxwatch.mentioned_me("@小王，来看看", ["Alice", "小王"]))
        self.assertTrue(wxwatch.mentioned_me("@Alice", ["Alice"]))

    def test_snapshots_do_not_replay_history_and_preserve_repeated_new_text(self):
        tracker = wxwatch.SnapshotTracker()
        self.assertEqual(tracker.update(chat("old"), baseline=True), [])
        self.assertEqual(tracker.update(chat("old", "ping")), [("in", "ping")])
        self.assertEqual(tracker.update(chat("old", "ping")), [])
        self.assertEqual(tracker.update(chat("old", "ping", "ping")), [("in", "ping")])
        self.assertEqual(tracker.update(chat("scrolled history")), [])

    def test_destination_mismatch_or_empty_ocr_refuses_send(self):
        for title in ["Bob", ""]:
            with patch.object(wxread, "read_chat", return_value={"chat": title}):
                with self.assertRaisesRegex(RuntimeError, "destination mismatch"):
                    wxsend.verify_chat("0x1", "Alice")
        with patch.object(wxread, "read_chat", return_value={"chat": "Alice"}):
            wxsend.verify_chat("0x1", "Alice")


if __name__ == "__main__":
    unittest.main()

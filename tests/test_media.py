import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import wxmedia
import wxread
import wxwatch


def photo():
    image = Image.new('RGB', (200, 140))
    image.putdata([((x*3+y)%256, (x+y*2)%256, (x*2+y*3)%256)
                   for y in range(140) for x in range(200)])
    return image


def scene(with_photo=True):
    image = Image.new('RGB', (880, 640), (245,245,245))
    draw = ImageDraw.Draw(image)
    draw.rectangle((310,320,342,352), fill=(30,130,160))  # Avatar, never a photo.
    draw.text((356,140), 'plain text message', fill=(0,0,0))
    if with_photo:
        image.paste(photo(), (356,320))
    return image


class MediaTests(unittest.TestCase):
    def test_detects_incoming_photo_and_rejects_text_avatars_and_outgoing(self):
        bubbles = wxmedia.find_bubbles(scene())
        self.assertEqual(len(bubbles), 1)
        self.assertLess(abs(bubbles[0]['box'][0]-356), 8)
        self.assertEqual(wxmedia.find_bubbles(scene(False)), [])
        outgoing = scene(False)
        outgoing.paste(photo().resize((160,140)), (650,320))
        self.assertEqual(wxmedia.find_bubbles(outgoing), [])

    def test_baseline_deduplication_replacement_and_newer_text(self):
        tracker = wxmedia.MediaTracker()
        item = wxmedia.find_bubbles(scene())[0]
        chat = {'chat':'Alice', 'media':[item], 'last_text_y':140}
        self.assertEqual(tracker.update(chat, baseline=True), [])
        self.assertEqual(tracker.update(chat), [])
        new = {**item, 'signature':'new-photo'}
        self.assertEqual(tracker.update({**chat, 'media':[new]}), [new])
        self.assertEqual(tracker.update(chat), [])  # No history replay after returning.
        latest = {**item, 'signature':'third-photo'}
        self.assertEqual(tracker.update({**chat, 'media':[latest], 'last_text_y':550}), [])

    def test_text_only_read_keeps_one_ocr_call_and_the_existing_event_shape(self):
        records = [([[350,25],[420,25],[420,50],[350,50]], 'Alice', .99),
                   ([[356,140],[440,140],[440,160],[356,160]], 'hello', .99)]
        def shot(_window, path):
            scene(False).save(path)
        with patch.object(wxread, 'shot', side_effect=shot), patch.object(wxread, '_ocr', return_value=(records, None)) as ocr:
            result = wxread.read_chat('0x1', media=True)
            self.assertEqual(ocr.call_count, 1)
        self.assertEqual(result['messages'], [{'dir':'in', 'text':'hello'}])
        self.assertEqual(result['media'], [])
        events = wxwatch.events_for(result, [('in','hello')], [], [], timestamp=1)
        self.assertEqual(events, [{'ts':1,'kind':'dm','chat':'Alice','text':'hello','wake':True}])

    def test_image_wakes_dm_once_and_group_still_requires_a_mention(self):
        dm = {'chat':'Alice'}
        images = wxwatch.events_for(dm, [('in','caption')], ['/tmp/image.png'], [], timestamp=1)
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]['kind'], 'image')
        self.assertEqual(images[0]['chatType'], 'dm')
        group = {'chat':'Team(3)', 'is_group':True}
        self.assertEqual(wxwatch.events_for(group, [], ['/tmp/image.png'], ['me']), [])
        self.assertTrue(wxwatch.events_for(group, [('in','@me look')], ['/tmp/image.png'], ['me'])[0]['wake'])

    def test_preview_must_be_new_and_match_before_emitting_a_readable_png(self):
        bubble = wxmedia.find_bubbles(scene())[0]
        for behavior in ('missing', 'wrong', 'matching'):
            with self.subTest(behavior=behavior), tempfile.TemporaryDirectory() as directory:
                commands = []
                ticks = [0.0]
                opened = [False]
                def run(*args):
                    commands.append(args)
                    if args[0] == 'click':
                        opened[0] = True
                    if args[0] == 'find':
                        extra = '\n0x2 800x600 preview' if opened[0] and behavior != 'missing' else ''
                        return '0x1 880x640 main'+extra
                    return ''
                def pause(seconds):
                    ticks[0] += seconds
                def shot(_window, path):
                    preview = Image.new('RGB', (800,600), (30,30,30))
                    if behavior == 'matching':
                        preview.paste(photo().resize((800,560)), (0,20))
                    preview.save(path)
                with patch.object(wxread, 'shot', side_effect=shot):
                    if behavior != 'matching':
                        with self.assertRaisesRegex(RuntimeError, 'preview did not open|did not match'):
                            wxmedia.capture_preview('0x1', bubble, directory, run, pause, lambda:ticks[0])
                        self.assertEqual(list(Path(directory).glob('*.png')), [])
                    else:
                        path = wxmedia.capture_preview('0x1', bubble, directory, run, pause, lambda:ticks[0])
                        with Image.open(path) as image:
                            image.verify()
                            self.assertEqual(image.format, 'PNG')
                        if sys.platform == 'linux':
                            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
                    if behavior != 'missing':
                        self.assertIn(('key','Escape'), commands)
                        self.assertEqual(commands[-1], ('activate','0x1'))


if __name__ == '__main__':
    unittest.main()

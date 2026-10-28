"""Conservative screen-only image capture; never reads WeChat's attachment store."""
from collections import Counter, OrderedDict
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

from PIL import Image, ImageChops, ImageFilter, ImageStat

WXCTL = os.environ.get('WXCTL', str(Path(__file__).resolve().parents[1] / 'wxctl'))
SAMPLE = (32, 32)


def _pixels(image):
    values = iter(image.tobytes())
    return zip(values, values, values)


def find_bubbles(image):
    """Find large, textured incoming rectangles in the supported 880x640 layout."""
    image = image.convert('RGB')
    left, top, right, bottom = 348, 90, image.width - 35, min(600, image.height - 40)
    if right <= left or bottom <= top:
        return []
    background = Counter(image.getpixel((330, y)) for y in range(top, bottom, 8)).most_common(1)[0][0]
    scale = 4
    small = image.crop((left, top, right, bottom)).resize(((right-left)//scale, (bottom-top)//scale))
    width, height = small.size
    ink = Image.new('L', small.size)
    ink.putdata([255 if max(abs(c-b) for c, b in zip(pixel, background)) > 24 else 0
                 for pixel in _pixels(small)])
    # Close tiny gaps inside photos, then reject text by its sparse original mask.
    connected = ink.filter(ImageFilter.MaxFilter(3))
    pixels = connected.load()
    remaining = {(x, y) for y in range(height) for x in range(width) if pixels[x, y]}
    found = []
    while remaining:
        seed = remaining.pop()
        stack = [seed]
        xs, ys = [], []
        while stack:
            x, y = stack.pop()
            xs.append(x); ys.append(y)
            for point in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
                if point in remaining:
                    remaining.remove(point); stack.append(point)
        x0, y0, x1, y1 = min(xs), min(ys), max(xs)+1, max(ys)+1
        # Incoming photos start near the left content edge; outgoing ones end at
        # the right avatar. Avoid avatars, controls, short text, and the input box.
        box = (left+x0*scale, top+y0*scale, min(right, left+x1*scale), min(bottom, top+y1*scale))
        if not 80 <= box[2]-box[0] <= 340 or box[3]-box[1] < 64 or box[0] > 420 or box[2] > image.width-65:
            continue
        coverage = ImageStat.Stat(ink.crop((x0, y0, x1, y1))).mean[0] / 255
        sample = image.crop(box).resize(SAMPLE)
        colors = {tuple(c//8 for c in pixel) for pixel in _pixels(sample)}
        green = sum(g > 190 and 110 < r < 190 and b < 160 for r, g, b in _pixels(sample))/(SAMPLE[0]*SAMPLE[1])
        if green > 0.35:
            continue
        if coverage < 0.55 or len(colors) < 16 or sum(ImageStat.Stat(sample).stddev) < 45:
            continue
        raw = sample.tobytes()
        # Stable across bubble movement and independent of visible-screen position.
        signature = hashlib.sha256(bytes(c//8 for c in raw)).hexdigest()
        found.append({'box': list(box), 'signature': signature, 'sample': raw.hex()})
    return sorted(found, key=lambda item: item['box'][1])


class MediaTracker:
    def __init__(self):
        self.chats = OrderedDict()

    def update(self, chat, baseline=False):
        key = (bool(chat.get('is_group')), chat.get('chat'))
        bubbles = chat.get('media', [])
        signatures = [item['signature'] for item in bubbles]
        state = self.chats.pop(key, None)
        previous = state['visible'] if state else None
        seen = state['seen'] if state else []
        fresh_signatures = [value for value in signatures if value not in seen]
        self.chats[key] = {'visible': signatures, 'seen': (seen+fresh_signatures)[-64:]}
        if len(self.chats) > 128:
            self.chats.popitem(last=False)
        if baseline or not bubbles:
            return []
        if previous is None:
            fresh = bubbles[-1:]
        else:
            overlap = next((n for n in range(min(len(previous), len(signatures)), 0, -1)
                            if previous[-n:] == signatures[:n]), 0)
            if overlap:
                fresh = bubbles[overlap:]
            elif not previous or signatures[-1] not in seen:
                fresh = bubbles[-1:]
            else:
                # A changed thumbnail can be an OCR/UI update or scrolling.
                fresh = []
        # Never open an older photo when a newer text row caused the list change.
        return [item for item in fresh if item['box'][3] >= chat.get('last_text_y', 0)][-1:]


def _run(*args):
    return subprocess.run([WXCTL, *map(str, args)], env=dict(os.environ, DISPLAY=os.environ.get('WX_DISPLAY', ':99')),
                          capture_output=True, text=True, check=True, timeout=10).stdout


def _windows(run):
    windows = {}
    for line in run('find', 'Weixin').splitlines():
        match = re.match(r'(0x[0-9a-fA-F]+)\s+(\d+)x(\d+)', line)
        if match:
            windows[match[1]] = (int(match[2]), int(match[3]))
    return windows


def preview_region(source, preview):
    """Find the source thumbnail in a centered preview, excluding letterboxing."""
    best = (float('inf'), None)
    aspect = source.width / source.height
    expected = source.resize(SAMPLE).convert('RGB')
    for top in (0, 24, 40, 64, 80):
        for bottom in (0, 24, 40):
            height = preview.height-top-bottom
            if height < 64:
                continue
            width = min(preview.width, round(height*aspect))
            height = min(height, round(width/aspect))
            x = (preview.width-width)//2
            y = top+(preview.height-top-bottom-height)//2
            box = (x, y, x+width, y+height)
            candidate = preview.crop(box).convert('RGB').resize(SAMPLE)
            error = sum(ImageStat.Stat(ImageChops.difference(expected, candidate)).mean)/3
            if error < best[0]:
                best = (error, box)
    return best[1] if best[0] <= 32 else None


def capture_preview(main, bubble, directory=None, run=_run, pause=time.sleep, clock=time.monotonic):
    """Caller holds the UI lock. A failed/new unrelated window produces no file."""
    import wxread

    before = _windows(run)
    x0, y0, x1, y1 = bubble['box']
    source = Image.frombytes('RGB', SAMPLE, bytes.fromhex(bubble['sample']))
    # Keep the original aspect ratio; SAMPLE only holds the appearance.
    source = source.resize((x1-x0, y1-y0))
    opened = None
    try:
        run('click', main, (x0+x1)//2, (y0+y1)//2)
        pause(0.12)
        run('click', main, (x0+x1)//2, (y0+y1)//2)
        deadline = clock()+2
        while clock() < deadline:
            candidates = [(wid, size) for wid, size in _windows(run).items()
                          if wid not in before and wid != main and size[0] >= 160 and size[1] >= 120]
            if candidates:
                opened = max(candidates, key=lambda item: item[1][0]*item[1][1])[0]
                break
            pause(0.1)
        if opened is None:
            raise RuntimeError('image preview did not open a new visible window')
        pause(0.25)
        with tempfile.TemporaryDirectory(prefix='wx-preview-') as temporary:
            path = str(Path(temporary)/'preview.ppm')
            wxread.shot(opened, path)
            with Image.open(path) as image:
                preview = image.convert('RGB')
            region = preview_region(source, preview)
            if region is None:
                raise RuntimeError('new window did not match the image bubble')
            return save_capture(preview.crop(region), directory)
    finally:
        if opened is not None:
            run('activate', opened)
            run('key', 'Escape')
            run('activate', main)


def save_capture(image, directory=None):
    directory = Path(directory or os.environ.get('WX_MEDIA_DIR', Path.home()/'.local/state/dsh-wechat-mate/incoming'))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    cutoff = time.time()-7*24*60*60
    for old in directory.glob('wx-incoming-*.png'):
        if old.is_file() and old.stat().st_mtime < cutoff:
            old.unlink()
    descriptor, path = tempfile.mkstemp(prefix='wx-incoming-', suffix='.png', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            image.save(output, format='PNG')
        return str(Path(path).resolve())
    except Exception:
        Path(path).unlink(missing_ok=True)
        raise

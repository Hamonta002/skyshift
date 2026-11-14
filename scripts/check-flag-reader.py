import importlib.util
import re
from pathlib import Path

spec = importlib.util.spec_from_file_location('read_flags', Path(__file__).parent / 'read-flags.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
content = bytes(range(256)) * 800
class Response:
    status = 206
    def __init__(self, start, end):
        self.data = content[start:end+1]
        self.headers = {'Content-Range': f'bytes {start}-{end}/{len(content)}'}
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, n): return self.data[:n]
    def geturl(self): return mod.BUCKET + 'dr1/level2/example.fits'
def opener(request, timeout):
    match = re.fullmatch(r'bytes=(\d+)-(\d+)', request.headers['Range'])
    return Response(*map(int, match.groups()))
remote = mod.RangeFile(mod.BUCKET + 'dr1/level2/example.fits', opener)
assert remote.read(12) == content[:12]
assert remote.read(32) == content[12:44]
assert remote.requests == 2
remote.seek(mod.BLOCK - 3)
assert remote.read(10) == content[mod.BLOCK - 3:mod.BLOCK + 7]
remote.seek(-4, 2)
assert remote.read() == content[-4:]
assert remote.seek(0) == 0
assert remote.readinto(bytearray(4)) == 4
try: remote.read(mod.MAX_BYTES + 1)
except ValueError: pass
print('Bounded FITS range file checks passed (mock archive).')

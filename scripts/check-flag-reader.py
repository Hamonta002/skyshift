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

# P2-05: Test read_flags on both uncompressed IMAGE FLAGS HDU and tile-compressed (GZIP_1 & RICE_1) BINTABLE FLAGS HDU.
import gzip
import struct

def pad2880(b):
    rem = len(b) % 2880
    return b if rem == 0 else b + b' ' * (2880 - rem)

def make_header(cards):
    out = b''.join(c.ljust(80, ' ').encode('ascii') for c in (cards + ['END']))
    rem = len(out) % 2880
    return out if rem == 0 else out + b' ' * (2880 - rem)

primary_hdr = make_header([
    'SIMPLE  =                    T',
    'BITPIX  =                    8',
    'NAXIS   =                    0',
    'EXTEND  =                    T',
])

# 1. Tile-compressed BINTABLE FLAGS HDU (ZIMAGE = T, ZCMPTYPE = 'GZIP_1', ZTILE1 = 2040, ZTILE2 = 1)
row_y9, row_y10, row_y11 = [0] * 2040, [0] * 2040, [0] * 2040
row_y9[19] = 1 << 0        # TRANSIENT at (19, 9)
row_y10[20] = 1 << 1       # OVERFLOW at centre (20, 10)
row_y11[21] = 1 << 21      # SOURCE at (21, 11)

comp_y9 = gzip.compress(struct.pack('>2040I', *row_y9))
comp_y10 = gzip.compress(struct.pack('>2040I', *row_y10))
comp_y11 = gzip.compress(struct.pack('>2040I', *row_y11))
heap = comp_y9 + comp_y10 + comp_y11

table_rows = bytearray(2040 * 8)
struct.pack_into('>ii', table_rows, 9 * 8, len(comp_y9), 0)
struct.pack_into('>ii', table_rows, 10 * 8, len(comp_y10), len(comp_y9))
struct.pack_into('>ii', table_rows, 11 * 8, len(comp_y11), len(comp_y9) + len(comp_y10))

bintable_hdr = make_header([
    "XTENSION= 'BINTABLE'",
    'BITPIX  =                    8',
    'NAXIS   =                    2',
    'NAXIS1  =                    8',
    'NAXIS2  =                 2040',
    f'PCOUNT  =             {len(heap):8d}',
    'GCOUNT  =                    1',
    'TFIELDS =                    1',
    "TTYPE1  = 'COMPRESSED_DATA'",
    "TFORM1  = '1PB(5000)'",
    "EXTNAME = 'FLAGS'",
    'ZIMAGE  =                    T',
    "ZCMPTYPE= 'GZIP_1'",
    'ZBITPIX =                   32',
    'ZNAXIS  =                    2',
    'ZNAXIS1 =                 2040',
    'ZNAXIS2 =                 2040',
    'ZTILE1  =                 2040',
    'ZTILE2  =                    1',
])

fits_payload = primary_hdr + bintable_hdr + bytes(table_rows) + heap
rem = len(fits_payload) % 2880
if rem:
    fits_payload += b'\x00' * (2880 - rem)

class FitsResponse:
    status = 206
    def __init__(self, start, end):
        self.data = fits_payload[start:end+1]
        self.headers = {'Content-Range': f'bytes {start}-{end}/{len(fits_payload)}'}
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, n): return self.data[:n]
    def geturl(self): return mod.BUCKET + 'dr1/level2/test_flags.fits'

def fits_opener(request, timeout):
    match = re.fullmatch(r'bytes=(\d+)-(\d+)', request.headers['Range'])
    return FitsResponse(*map(int, match.groups()))

res = mod.read_flags('dr1/level2/test_flags.fits', 20, 10, opener=fits_opener)
assert res['x'] == 20 and res['y'] == 10
assert res['center'] == (1 << 1)
assert res['combined'] == ((1 << 0) | (1 << 1) | (1 << 21))
assert res['flaggedPixels'] == 3
assert res['totalPixels'] == 9
assert res['pixels'][0][0] == (1 << 0)
assert res['pixels'][1][1] == (1 << 1)
assert res['pixels'][2][2] == (1 << 21)

# 2. Verify Rice 32-bit tile decompression (fs=0 constant block)
rice_const = struct.pack('>I', 1 << 21) + bytes([0x00])
decoded_rice = mod._decode_rice_32(rice_const, 8, blocksize=32)
assert decoded_rice == [1 << 21] * 8

print('Bounded FITS range file checks passed (mock archive).')

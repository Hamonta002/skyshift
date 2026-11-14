#!/usr/bin/env python3
"""Read a small FLAGS cutout using Astropy and bounded ranges from the public SPHEREx bucket."""
import io
import json
import re
import sys
import urllib.request

BUCKET = 'https://nasa-irsa-spherex.s3.amazonaws.com/'
MAX_BYTES = 24 * 1024 * 1024
MAX_REQUESTS = 192
BLOCK = 65536

class RangeFile(io.RawIOBase):
    def __init__(self, url, opener=urllib.request.urlopen):
        self.url, self.opener = url, opener
        self.position = self.transferred = self.requests = 0
        self.blocks = {}
        self.length = None
        self._get(0, 0)
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.position
    def seek(self, offset, whence=0):
        p = offset if whence == 0 else self.position + offset if whence == 1 else self.length + offset
        if p < 0: raise ValueError('negative file offset')
        self.position = p
        return p
    def _get(self, start, end):
        if self.requests >= MAX_REQUESTS or self.transferred + end - start + 1 > MAX_BYTES:
            raise ValueError('FLAGS read exceeded the download limit')
        request = urllib.request.Request(self.url, headers={'Range': f'bytes={start}-{end}'})
        with self.opener(request, timeout=15) as response:
            if response.status != 206: raise ValueError('Archive did not honour byte range')
            if not response.geturl().startswith(BUCKET): raise ValueError('Unexpected archive redirect')
            content_range = response.headers.get('Content-Range', '')
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', content_range)
            if not match or int(match[1]) != start or int(match[2]) != end:
                raise ValueError('Invalid archive Content-Range')
            self.length = int(match[3])
            data = response.read(end - start + 2)
        self.requests += 1
        self.transferred += len(data)
        if len(data) != end - start + 1: raise ValueError('Incomplete archive byte range')
        return data
    def read(self, size=-1):
        if self.position >= self.length: return b''
        if size is None or size < 0: size = self.length - self.position
        size = min(size, self.length - self.position)
        if size > MAX_BYTES: raise ValueError('FLAGS read request exceeds limit')
        end = self.position + size
        chunks = []
        while self.position < end:
            number = self.position // BLOCK
            start = number * BLOCK
            if number not in self.blocks:
                self.blocks[number] = self._get(start, min(start + BLOCK, self.length) - 1)
            within = self.position - start
            count = min(end - self.position, len(self.blocks[number]) - within)
            if count <= 0: raise ValueError('Invalid archive range')
            chunks.append(self.blocks[number][within:within + count]); self.position += count
        return b''.join(chunks)
    def readinto(self, buffer):
        data = self.read(len(buffer)); buffer[:len(data)] = data
        return len(data)

def read_flags(key, x, y):
    if not re.fullmatch(r'[a-z0-9_]+/level2/[A-Za-z0-9_./-]+\.fits', key) or '..' in key:
        raise ValueError('Invalid product key')
    if not (0 <= x < 2040 and 0 <= y < 2040): raise ValueError('Pixel is outside detector')
    try:
        from astropy.io import fits
    except ImportError:
        raise ValueError('Install astropy to inspect FLAGS: python -m pip install -r reference/requirements.txt')
    remote = RangeFile(BUCKET + key)
    with fits.open(remote, memmap=False, lazy_load_hdus=True) as hdus:
        hdu = hdus['FLAGS']
        if tuple(hdu.shape) != (2040, 2040): raise ValueError('Unsupported FLAGS image dimensions')
        x0, x1 = max(x - 1, 0), min(x + 2, 2040)
        y0, y1 = max(y - 1, 0), min(y + 2, 2040)
        arr = hdu.section[y0:y1, x0:x1]
        raw = [[int(v) & 0xffffffff for v in row] for row in arr]
        combined = 0
        for row in raw:
            for value in row: combined |= value
        return {'productKey': key, 'x': x, 'y': y, 'x0': x0, 'y0': y0,
                'pixels': raw, 'combined': combined, 'bytesRead': remote.transferred,
                'requests': remote.requests, 'scope': 'one exposure, 3-by-3 native pixels'}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 4: raise ValueError('Expected product key and detector coordinates')
        print(json.dumps(read_flags(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)

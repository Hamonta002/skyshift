#!/usr/bin/env python3
"""Read a small FLAGS cutout using bounded byte ranges from the public SPHEREx bucket."""
import io
import json
import math
import re
import struct
import sys
import urllib.request
import zlib

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
        request = urllib.request.Request(self.url, headers={'Range': f'bytes={start}-{end}', 'User-Agent': 'SkyShift/1.0'})
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


def _parse_header_block(remote, offset):
    remote.seek(offset)
    cards = {}
    while True:
        block = remote.read(2880)
        if len(block) < 2880:
            raise ValueError('Truncated FITS header')
        for i in range(0, 2880, 80):
            card = block[i:i + 80].decode('ascii', errors='replace')
            key = card[:8].strip()
            if key == 'END':
                return cards, remote.tell()
            if card[8:10] != '= ':
                continue
            raw = card[10:].strip()
            if raw.startswith("'"):
                m = re.match(r"^'((?:[^']|'')*)'", raw)
                if m:
                    cards[key] = m.group(1).replace("''", "'").strip()
            else:
                val_str = raw.split('/')[0].strip()
                if val_str == 'T':
                    cards[key] = True
                elif val_str == 'F':
                    cards[key] = False
                else:
                    try:
                        cards[key] = int(val_str)
                    except ValueError:
                        try:
                            cards[key] = float(val_str.replace('D', 'E'))
                        except ValueError:
                            cards[key] = val_str


def _hdu_data_size(cards):
    naxis = int(cards.get('NAXIS', 0))
    if naxis == 0:
        return 0
    bitpix = abs(int(cards.get('BITPIX', 8)))
    count = 1
    for axis in range(1, naxis + 1):
        count *= int(cards.get(f'NAXIS{axis}', 0))
    pcount = int(cards.get('PCOUNT', 0))
    gcount = int(cards.get('GCOUNT', 1))
    return gcount * (count + pcount) * (bitpix // 8)


def _decode_rice_32(buf, npix, blocksize=32):
    """Decode CFITSIO 32-bit Rice-compressed tile bytes into unsigned 32-bit integers."""
    if len(buf) < 4:
        raise ValueError('Truncated Rice compressed tile')
    lastpix = struct.unpack('>I', buf[:4])[0]
    bit_pos = 32
    total_bits = len(buf) * 8

    def read_bits(n):
        nonlocal bit_pos
        if n == 0:
            return 0
        if bit_pos + n > total_bits:
            raise ValueError('Truncated Rice bitstream')
        val = 0
        for _ in range(n):
            byte_idx = bit_pos >> 3
            bit_offset = 7 - (bit_pos & 7)
            val = (val << 1) | ((buf[byte_idx] >> bit_offset) & 1)
            bit_pos += 1
        return val

    out = []
    i = 0
    while i < npix:
        thisblock = min(blocksize, npix - i)
        fs = read_bits(5)
        if fs == 0:
            for _ in range(thisblock):
                out.append(lastpix)
        # CFITSIO stores FS + 1 in the block header. FS=25 is direct
        # 32-bit coding, while larger values are invalid for Rice_1.
        elif fs == 26:
            for _ in range(thisblock):
                diff = read_bits(32)
                mapped = (diff >> 1) ^ (-(diff & 1))
                lastpix = (lastpix + mapped) & 0xffffffff
                out.append(lastpix)
        elif fs < 26:
            fs_bits = fs - 1
            for _ in range(thisblock):
                top = 0
                while read_bits(1) == 0:
                    top += 1
                diff = (top << fs_bits) | read_bits(fs_bits)
                mapped = (diff >> 1) ^ (-(diff & 1))
                lastpix = (lastpix + mapped) & 0xffffffff
                out.append(lastpix)
        else:
            raise ValueError('Invalid Rice block code')
        i += thisblock
    return out


def _decompress_tile_32(raw_bytes, npix, cmptype, blocksize=32):
    cmptype = cmptype.upper()
    if cmptype.startswith('GZIP'):
        decomp = zlib.decompress(raw_bytes, 15 + 32)
        if len(decomp) != npix * 4:
            raise ValueError('Unexpected decompressed GZIP tile length')
        if cmptype == 'GZIP_2':
            unshuffled = bytearray(npix * 4)
            for b in range(4):
                unshuffled[b::4] = decomp[b * npix:(b + 1) * npix]
            decomp = bytes(unshuffled)
        return list(struct.unpack(f'>{npix}I', decomp))
    if cmptype.startswith('RICE'):
        return _decode_rice_32(raw_bytes, npix, blocksize)
    if cmptype == 'NOCOMPRESS':
        return list(struct.unpack(f'>{npix}I', raw_bytes))
    raise ValueError(f'Unsupported FITS tile compression: {cmptype}')


def _read_flags_stdlib(remote, x, y):
    offset = 0
    flags_hdr = None
    data_start = 0
    while offset < remote.length:
        cards, hdr_end = _parse_header_block(remote, offset)
        if cards.get('EXTNAME') == 'FLAGS':
            flags_hdr = cards
            data_start = hdr_end
            break
        data_bytes = _hdu_data_size(cards)
        offset = hdr_end + math.ceil(data_bytes / 2880) * 2880
    if not flags_hdr:
        raise ValueError('FLAGS extension not found in FITS file')

    x0, x1 = max(x - 1, 0), min(x + 2, 2040)
    y0, y1 = max(y - 1, 0), min(y + 2, 2040)
    bzero = int(flags_hdr.get('BZERO', 0))

    if not flags_hdr.get('ZIMAGE'):
        if int(flags_hdr.get('NAXIS1', 0)) != 2040 or int(flags_hdr.get('NAXIS2', 0)) != 2040:
            raise ValueError('Unsupported FLAGS image dimensions')
        if int(flags_hdr.get('BITPIX', 0)) != 32:
            raise ValueError('Unsupported FLAGS BITPIX')
        raw = []
        for py in range(y0, y1):
            remote.seek(data_start + 4 * (py * 2040 + x0))
            row_bytes = remote.read(4 * (x1 - x0))
            vals = struct.unpack(f'>{x1 - x0}i', row_bytes)
            raw.append([(int(v) + bzero) & 0xffffffff for v in vals])
        return x0, y0, raw

    # Tile-compressed BINTABLE (ZIMAGE = T)
    if int(flags_hdr.get('ZNAXIS1', 0)) != 2040 or int(flags_hdr.get('ZNAXIS2', 0)) != 2040:
        raise ValueError('Unsupported compressed FLAGS image dimensions')
    if int(flags_hdr.get('ZBITPIX', 0)) != 32:
        raise ValueError('Unsupported compressed FLAGS ZBITPIX')
    ztile1 = int(flags_hdr.get('ZTILE1', 2040))
    ztile2 = int(flags_hdr.get('ZTILE2', 1))
    cmptype = str(flags_hdr.get('ZCMPTYPE', 'GZIP_1')).strip()
    row_len = int(flags_hdr.get('NAXIS1', 0))
    nrows = int(flags_hdr.get('NAXIS2', 0))
    theap = int(flags_hdr.get('THEAP', row_len * nrows))
    tfields = int(flags_hdr.get('TFIELDS', 1))

    blocksize = 32
    for idx in range(1, 10):
        if str(flags_hdr.get(f'ZNAME{idx}', '')).strip() == 'BLOCKSIZE':
            blocksize = int(flags_hdr.get(f'ZVAL{idx}', 32))

    # Locate COMPRESSED_DATA column offset and descriptor format (P=32-bit, Q=64-bit)
    col_offset = 0
    is_q = False
    found_col = False
    for f in range(1, tfields + 1):
        ttype = str(flags_hdr.get(f'TTYPE{f}', '')).strip().upper()
        tform = str(flags_hdr.get(f'TFORM{f}', '')).strip().upper()
        if ttype == 'COMPRESSED_DATA':
            is_q = 'Q' in tform
            found_col = True
            break
        if 'Q' in tform:
            col_offset += 16
        elif 'P' in tform:
            col_offset += 8
        else:
            m = re.match(r'^(\d*)([BIJED])', tform)
            mult = int(m.group(1) or '1') if m else 1
            kind = m.group(2) if m else 'B'
            col_offset += mult * {'B': 1, 'I': 2, 'J': 4, 'E': 4, 'D': 8}[kind]
    if not found_col:
        raise ValueError('COMPRESSED_DATA column not found in FLAGS table')

    tiles_x = (2040 + ztile1 - 1) // ztile1
    tile_cache = {}
    raw = []
    for py in range(y0, y1):
        row = []
        ty = py // ztile2
        for px in range(x0, x1):
            tx = px // ztile1
            tile_idx = ty * tiles_x + tx
            if tile_idx not in tile_cache:
                tw = min(ztile1, 2040 - tx * ztile1)
                th = min(ztile2, 2040 - ty * ztile2)
                remote.seek(data_start + tile_idx * row_len + col_offset)
                if is_q:
                    count, heap_off = struct.unpack('>qq', remote.read(16))
                else:
                    count, heap_off = struct.unpack('>ii', remote.read(8))
                if count <= 0:
                    tile_cache[tile_idx] = (tw, [0] * (tw * th))
                else:
                    remote.seek(data_start + theap + heap_off)
                    comp_bytes = remote.read(count)
                    pixels = _decompress_tile_32(comp_bytes, tw * th, cmptype, blocksize)
                    tile_cache[tile_idx] = (tw, [(int(v) + bzero) & 0xffffffff for v in pixels])
            tw, tile_pixels = tile_cache[tile_idx]
            local_x = px - tx * ztile1
            local_y = py - ty * ztile2
            row.append(tile_pixels[local_y * tw + local_x])
        raw.append(row)
    return x0, y0, raw


def read_flags(key, x, y, opener=urllib.request.urlopen):
    if not re.fullmatch(r'[a-z0-9_]+/level2/[A-Za-z0-9_./-]+\.fits', key) or '..' in key:
        raise ValueError('Invalid product key')
    if not (0 <= x < 2040 and 0 <= y < 2040):
        raise ValueError('Pixel is outside detector')
    remote = RangeFile(BUCKET + key, opener)
    try:
        from astropy.io import fits
        with fits.open(remote, memmap=False, lazy_load_hdus=True) as hdus:
            hdu = hdus['FLAGS']
            if tuple(hdu.shape) != (2040, 2040):
                raise ValueError('Unsupported FLAGS image dimensions')
            x0, x1 = max(x - 1, 0), min(x + 2, 2040)
            y0, y1 = max(y - 1, 0), min(y + 2, 2040)
            arr = hdu.section[y0:y1, x0:x1]
            raw = [[int(v) & 0xffffffff for v in row] for row in arr]
    except ImportError:
        x0, y0, raw = _read_flags_stdlib(remote, x, y)
    combined = 0
    center_x = min(max(x - x0, 0), len(raw[0]) - 1)
    center_y = min(max(y - y0, 0), len(raw) - 1)
    center_val = raw[center_y][center_x]
    flagged_pixels = 0
    total_pixels = 0
    for row in raw:
        for value in row:
            combined |= value
            total_pixels += 1
            if value != 0:
                flagged_pixels += 1
    return {
        'productKey': key,
        'x': x,
        'y': y,
        'x0': x0,
        'y0': y0,
        'pixels': raw,
        'center': center_val,
        'combined': combined,
        'flaggedPixels': flagged_pixels,
        'totalPixels': total_pixels,
        'bytesRead': remote.transferred,
        'requests': remote.requests,
        'scope': 'one exposure, 3-by-3 native pixels',
    }


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('Expected product key and detector coordinates')
        print(json.dumps(read_flags(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)

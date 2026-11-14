"""List the HDUs of a remote FITS file using HTTP Range requests only (standard library).

Shows where each extension starts, so you can see what a browser must read and what it can skip.
   python fits_layout.py https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/.../file.fits [--cards REGEX]
"""
import re, sys, urllib.request


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    url = sys.argv[1]
    pattern = re.compile(sys.argv[sys.argv.index("--cards") + 1]) if "--cards" in sys.argv else None
    state = {"requests": 0, "bytes": 0, "total": None}

    def get(a, b):
        req = urllib.request.Request(url, headers={"Range": f"bytes={a}-{b}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
            state["total"] = int(r.headers["Content-Range"].split("/")[1])
        state["requests"] += 1
        state["bytes"] += len(data)
        return data

    off, i = 0, 0
    while state["total"] is None or off < state["total"]:
        cards, start, done = [], off, False
        while not done:
            block = get(off, off + 2880 * 8 - 1)
            used = len(block) // 2880
            for k in range(0, len(block), 80):
                card = block[k:k + 80].decode("ascii", "replace")
                cards.append(card)
                if card.startswith("END" + " " * 77):
                    done, used = True, k // 2880 + 1
                    break
            off += used * 2880
        hdr = {c[:8].strip(): c[10:].split(" /")[0].strip().strip("'").strip() for c in cards if c[8:10] == "= "}
        naxis = int(hdr.get("NAXIS", 0))
        dims = [int(hdr[f"NAXIS{k}"]) for k in range(1, naxis + 1)]
        npix = 1
        for d in dims:
            npix *= d
        nbytes = abs(int(hdr.get("BITPIX", 8))) // 8 * int(hdr.get("GCOUNT", 1)) * (int(hdr.get("PCOUNT", 0)) + (npix if naxis else 0))
        print(f"HDU{i} {hdr.get('EXTNAME', 'PRIMARY'):<9} {hdr.get('XTENSION', '-'):<8} BITPIX={hdr.get('BITPIX', '-'):>3} dims={dims} "
              f"header@{start} ({off - start} B) data@{off} ({nbytes} B) compression={hdr.get('ZCMPTYPE', 'none')}")
        if pattern:
            for c in cards:
                if pattern.search(c):
                    print("     " + c.rstrip())
        off += (nbytes + 2879) // 2880 * 2880
        i += 1
    print(f"file size {state['total']} B; read {state['bytes']} B in {state['requests']} range requests")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Build the independent reading samples.

These samples are produced by an implementation that shares no code with the parsers under test:
CPython's `zipfile`/`zlib` write the EPUB container, the MOBI record layout and the PDF object model
are written from the specification here. They are committed under `tests/fixtures/external-samples/` with
a SHA-256 manifest so a reader can tell the fixtures apart from the in-repo builders.

Usage:  python scripts/samples/build-reading-samples.py [output-dir]
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import zlib
import zipfile
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures" / "external-samples"


def png_bytes() -> bytes:
    """A 2x2 greyscale PNG, written with zlib so the magic bytes are a real image."""
    width = height = 2
    raw = b"".join(b"\x00" + bytes([(row * 60 + col * 90) & 0xFF for col in range(width)]) for row in range(height))
    chunks = [b"\x89PNG\r\n\x1a\n"]

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    chunks.append(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)))
    chunks.append(chunk(b"IDAT", zlib.compress(raw, 9)))
    chunks.append(chunk(b"IEND", b""))
    return b"".join(chunks)


def build_epub() -> bytes:
    """An EPUB whose chapters, illustration and fixed-layout page come from a foreign zip writer."""
    opf = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:external-sample-0001</dc:identifier>
    <dc:title>外部样本书</dc:title>
    <dc:language>zh</dc:language>
    <meta property="rendition:layout">pre-paginated</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
    <item id="plate" href="plate.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/plate.png" media-type="image/png"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="plate"/>
  </spine>
</package>
"""
    nav = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="chapter-1.xhtml">外源第一章</a></li>
<li><a href="chapter-2.xhtml">外源第二章</a></li>
</ol></nav></body>
</html>
"""
    chapter1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>外源第一章</title>
<link rel="stylesheet" href="style.css"/><script>window.secret = "must not leak";</script></head>
<body><h1>外源第一章</h1>
<p>第一段正文：合成样本由外部写入器生成。</p>
<p>第二段正文：保留中日文与 emoji 😀 与组合字符 é。</p>
<figure><img src="images/plate.png" alt="插图"/></figure>
<p><a href="https://example.invalid/outside">外部链接</a></p>
</body></html>
"""
    chapter2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>外源第二章</title></head>
<body><h1>外源第二章</h1><p>第二章正文，用于确认每一章都能独立定位。</p></body></html>
"""
    # A pre-paginated page that carries no text, only an illustration.
    plate = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>插图页</title></head>
<body><div class="page"><img src="images/plate.png" alt="整页插图"/></div></body></html>
"""
    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""
    css = "/* external sample stylesheet: must never leak into the text */\nbody { margin: 0; }\n"
    entries = [
        ("mimetype", b"application/epub+zip", zipfile.ZIP_STORED),
        ("META-INF/container.xml", container.encode("utf-8"), zipfile.ZIP_DEFLATED),
        ("OEBPS/content.opf", opf.encode("utf-8"), zipfile.ZIP_DEFLATED),
        ("OEBPS/nav.xhtml", nav.encode("utf-8"), zipfile.ZIP_DEFLATED),
        ("OEBPS/chapter-1.xhtml", chapter1.encode("utf-8"), zipfile.ZIP_DEFLATED),
        ("OEBPS/chapter-2.xhtml", chapter2.encode("utf-8"), zipfile.ZIP_DEFLATED),
        ("OEBPS/plate.xhtml", plate.encode("utf-8"), zipfile.ZIP_DEFLATED),
        ("OEBPS/images/plate.png", png_bytes(), zipfile.ZIP_DEFLATED),
        ("OEBPS/style.css", css.encode("utf-8"), zipfile.ZIP_DEFLATED),
    ]
    sink = bytearray()

    class Sink:
        def write(self, data: bytes) -> int:
            sink.extend(data)
            return len(data)

        def flush(self) -> None:
            return None

    with zipfile.ZipFile(Sink(), "w") as archive:  # type: ignore[arg-type]
        for name, data, method in entries:
            archive.writestr(zipfile.ZipInfo(name), data, compress_type=method)
    return bytes(sink)


def palmdoc_compress(data: bytes) -> bytes:
    """PalmDOC LZ77, written against the record format the reader has to decode."""
    out = bytearray()
    literals = bytearray()
    index = 0

    def flush_literals() -> None:
        while literals:
            take = literals[:8]
            del literals[:8]
            out.append(len(take))
            out.extend(take)

    while index < len(data):
        best_length = 0
        best_distance = 0
        window_start = max(0, index - 2047)
        for candidate in range(index - 1, window_start - 1, -1):
            length = 0
            while length < 10 and index + length < len(data) and data[candidate + length] == data[index + length]:
                length += 1
            if length > best_length:
                best_length = length
                best_distance = index - candidate
                if length == 10:
                    break
        byte = data[index]
        pair_usable = best_length >= 3 and 1 <= best_distance <= 2047
        if pair_usable:
            flush_literals()
            pair = ((best_distance >> 5) & 0x3F) << 8 | ((best_distance & 0x1F) << 3) | (best_length - 3)
            out.append(0x80 | (pair >> 8))
            out.append(pair & 0xFF)
            index += best_length
            continue
        if 1 <= byte <= 8:
            flush_literals()
            out.append(1)
            out.append(byte)
            index += 1
            continue
        if byte == 0x20 and index + 1 < len(data) and 0x40 <= data[index + 1] <= 0x7F:
            flush_literals()
            out.append(0xC0 | data[index + 1])
            index += 2
            continue
        literals.append(byte)
        if len(literals) >= 8:
            flush_literals()
        index += 1
    flush_literals()
    return bytes(out)


def build_mobi() -> bytes:
    """A MOBI whose text records are PalmDOC compressed and whose image is a `recindex` record."""
    image = png_bytes()
    html = (
        "<html><body>"
        "<h1>外源样本章</h1>"
        "<p>第一页正文，由外部写入器压缩成 PalmDOC 记录。</p>"
        "<mbp:pagebreak/>"
        "<p>第二页正文，图片通过 recindex 引用。</p>"
        '<img recindex="1" alt="插图"/>'
        '<img src="kindle:embed:0002" alt="第二张"/>'
        "</body></html>"
    ).encode("utf-8")
    compressed = palmdoc_compress(html)
    record_size = 4096
    text_records = max(1, -(-len(compressed) // record_size))
    name = "外部样本".encode("utf-8")
    header_length = 232
    record0 = bytearray(16 + header_length + len(name))
    struct.pack_into(">H", record0, 0, 2)                      # PalmDOC compression
    struct.pack_into(">I", record0, 4, len(html))              # uncompressed text length
    struct.pack_into(">H", record0, 8, text_records)
    struct.pack_into(">H", record0, 10, record_size)
    struct.pack_into(">H", record0, 12, 0)                     # no encryption
    record0[16:20] = b"MOBI"
    struct.pack_into(">I", record0, 20, header_length)
    struct.pack_into(">I", record0, 24, 2)
    struct.pack_into(">I", record0, 28, 65001)                 # UTF-8
    struct.pack_into(">I", record0, 16 + 84, 16 + header_length)
    struct.pack_into(">I", record0, 16 + 88, len(name))
    struct.pack_into(">I", record0, 16 + 0x6C, text_records + 1)
    record0[16 + header_length:16 + header_length + len(name)] = name

    chunks = [bytes(record0)]
    for start in range(0, len(compressed), record_size):
        chunks.append(compressed[start:start + record_size])
    # Two image records so `kindle:embed:0002` resolves to the second one.
    chunks.append(image)
    chunks.append(image)

    count = len(chunks)
    header = bytearray(78 + count * 8)
    header[0:4] = b"BOOK"
    header[60:68] = b"BOOKMOBI"
    struct.pack_into(">H", header, 76, count)
    offset = len(header)
    for position, chunk in enumerate(chunks):
        struct.pack_into(">I", header, 78 + position * 8, offset)
        offset += len(chunk)
    return bytes(header) + b"".join(chunks)


def build_pdf() -> bytes:
    """A PDF 1.5 whose page tree lives in an object stream and whose image is inherited."""
    image = bytes([0, 90, 180, 255])
    page_count = 3
    content_ids = [10 + index for index in range(page_count)]
    image_id = 10 + page_count
    object_stream_id = 100
    xref_id = 101
    size = 102

    packed = [(1, b"<< /Type /Catalog /Pages 2 0 R >>")]
    kids = " ".join(f"{index + 3} 0 R" for index in range(page_count))
    # `/Resources` sits on the page tree node, so each page has to inherit the image it draws.
    packed.append((2, f"<< /Type /Pages /Count {page_count} /Kids [{kids}] /Resources << /Font << /F1 14 0 R >> /XObject << /Im0 {image_id} 0 R >> >> >>".encode("utf-8")))
    page_bodies = [
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents {content_ids[0]} 0 R >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents {content_ids[1]} 0 R >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents {content_ids[2]} 0 R >>",
    ]
    for index, body in enumerate(page_bodies):
        packed.append((index + 3, body.encode("utf-8")))

    header_text = " ".join(
        f"{number} {0 if position == 0 else sum(len(item[1]) + 1 for item in packed[:position])}"
        for position, (number, _) in enumerate(packed)
    )
    object_stream_body = header_text.encode("utf-8") + b" " + b" ".join(body for _, body in packed)
    stream_first = len(header_text) + 1

    top_level: list[tuple[int, bytes]] = []
    contents = [
        b"BT /F1 12 Tf 72 100 Td (external page one) Tj ET",
        b"BT /F1 12 Tf 72 100 Td (external page two) Tj ET",
        b"/Im0 Do",
    ]
    for index, body in enumerate(contents):
        top_level.append((content_ids[index], f"{content_ids[index]} 0 obj << /Length {len(body) + 1} >> stream\n".encode("utf-8") + body + b"\nendstream\nendobj\n"))
    top_level.append((image_id, f"{image_id} 0 obj << /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length {len(image)} >> stream\n".encode("utf-8") + image + b"\nendstream\nendobj\n"))
    top_level.append((14, b"14 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"))
    top_level.append((object_stream_id, f"{object_stream_id} 0 obj << /Type /ObjStm /N {len(packed)} /First {stream_first} /Length {len(object_stream_body)} >> stream\n".encode("utf-8") + object_stream_body + b"\nendstream\nendobj\n"))

    offsets: dict[int, int] = {}
    cursor = len(b"%PDF-1.5\n")
    for number, buffer in top_level:
        offsets[number] = cursor
        cursor += len(buffer)

    entries = bytearray()
    packed_positions = {number: position for position, (number, _) in enumerate(packed)}
    for number in range(size):
        if number == 0:
            entries += bytes([0, 0, 0, 255, 255])
            continue
        if number in packed_positions:
            position = packed_positions[number]
            entries += bytes([2, (object_stream_id >> 8) & 0xFF, object_stream_id & 0xFF, (position >> 8) & 0xFF, position & 0xFF])
            continue
        if number == xref_id:
            entries += bytes([1, (cursor >> 8) & 0xFF, cursor & 0xFF, 0, 0])
            continue
        offset = offsets.get(number)
        entries += bytes([1, (offset >> 8) & 0xFF, offset & 0xFF, 0, 0]) if offset is not None else bytes([0, 0, 0, 0, 0])
    xref = f"{xref_id} 0 obj << /Type /XRef /Size {size} /W [1 2 2] /Index [0 {size}] /Root 1 0 R /Length {len(entries)} >> stream\n".encode("utf-8") + bytes(entries) + b"\nendstream\nendobj\n"
    body = b"%PDF-1.5\n" + b"".join(buffer for _, buffer in top_level)
    startxref = len(body)
    return body + xref + f"startxref\n{startxref}\n%%EOF\n".encode("utf-8")


def main() -> int:
    out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)
    samples = {
        "reading-sample.epub": build_epub(),
        "external-pages.pdf": build_pdf(),
        "palmdoc-sample.mobi": build_mobi(),
    }
    manifest = {
        "generator": "scripts/samples/build-reading-samples.py",
        "toolchain": f"CPython {sys.version.split()[0]} stdlib (zipfile/zlib/struct), no project code",
        "samples": [],
    }
    for name, data in samples.items():
        (out / name).write_bytes(data)
        manifest["samples"].append({
            "name": name,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
        print(f"wrote {name} ({len(data)} bytes)")
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote manifest.json in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

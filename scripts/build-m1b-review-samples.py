"""Independent standards-based samples for the A review; synthetic content only."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile
import PIL
import reportlab

from PIL import Image, ImageDraw
from reportlab import rl_config
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
image = Image.new("RGB", (600, 800), "#fffdf5")
draw = ImageDraw.Draw(image)
draw.rectangle((40, 40, 560, 760), outline="#aa3366", width=6)
draw.text((80, 100), "MANGA synthetic scan - page 1", fill="black", font_size=27)
draw.rectangle((80, 200, 270, 400), fill="#adceef")
draw.rectangle((320, 200, 510, 400), fill="#eeaacc")
draw.text((80, 470), "Image-only page; no OCR expected.", fill="black", font_size=23)
png = out / "scan-source.png"
image.save(png)
rl_config.useA85 = False
pdf = out / "standard-scan.pdf"
c = canvas.Canvas(str(pdf), pagesize=(300, 400), pageCompression=1, invariant=1)
c.setTitle("MANGA synthetic scan")
c.setAuthor("MANGA synthetic test")
c.drawImage(ImageReader(image), 0, 0, 300, 400)
c.showPage()
c.save()
epub = out / "relative-image.epub"
with zipfile.ZipFile(epub, "w") as z:
    z.writestr("mimetype", "application/epub+zip")
    z.writestr("META-INF/container.xml", '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    z.writestr("OPS/package.opf", '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:manga:synthetic:relative-image</dc:identifier><dc:title>Relative image</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-09-23T00:00:00Z</meta></metadata><manifest><item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="Images/scan.png" media-type="image/png"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="ch1"/></spine></package>')
    z.writestr("OPS/nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="Text/ch1.xhtml">Chapter 1</a></li></ol></nav></body></html>')
    z.writestr("OPS/Text/ch1.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head><body><p>Text before the illustration.</p><img src="../Images/scan.png" alt="Synthetic scan"/><p>Text after the illustration.</p></body></html>')
    z.write(png, "OPS/Images/scan.png")
manifest = {"generator": "scripts/build-m1b-review-samples.py", "toolchain": {"python": sys.version.split()[0], "reportlab": reportlab.Version, "pillow": PIL.__version__}, "synthetic": True, "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [pdf, png, epub]}}
(out / "sample-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

import io
import unittest
import zipfile
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from test_client import APP, wait_for
from flyleaf_desktop.document_backend import DocumentBackend
from flyleaf_desktop.epub_positions import EpubPositions


def sample_epub():
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as book:
        book.writestr("mimetype", "application/epub+zip")
        book.writestr("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
        book.writestr("OPS/book.opf", '''<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">native-test</dc:identifier><dc:title>Native sample</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>''')
        for chapter, filename in enumerate(("one.xhtml", "two.xhtml")):
            paragraphs = "\n".join(f'<p id="p{i}">Chapter {chapter + 1} paragraph {i} contains a quiet garden, a winding path, and a unique native reading memory number {i}. Unicode café and 😀 remain in their original source text.</p>' for i in range(35))
            book.writestr("OPS/" + filename, '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Native sample</title></head><body>\n' + paragraphs + '\n</body></html>')
    return archive.getvalue()


def sample_pdf():
    import pymupdf
    document = pymupdf.open()
    for number in range(3):
        page = document.new_page()
        page.insert_text((50, 80), f"Native PDF page {number + 1}. Searchable garden text.")
    document.set_toc([[1, "Start", 1], [1, "Next chapter", 2]])
    raw = document.tobytes()
    document.close()
    return raw


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.backend = DocumentBackend()

    def tearDown(self):
        self.backend.close()

    def test_pdf_native_render_search_rotation_and_contents(self):
        metadata = self.backend.open(sample_pdf(), "pdf")
        self.assertEqual(metadata["count"], 3)
        self.assertEqual(len(metadata["toc"]), 2)
        normal = self.backend.render(1, width=600)
        rotated = self.backend.render(1, width=600, rotation=90)
        self.assertTrue(normal["image"].startswith(b"\x89PNG"))
        self.assertIn("page 2", normal["text"])
        self.assertNotEqual(normal["image"], rotated["image"])
        self.assertEqual([hit["page"] for hit in self.backend.search("garden")], [0, 1, 2])

    def test_epub_verified_cfi_roundtrip_survives_typography_reflow(self):
        payload = sample_epub()
        metadata = self.backend.open(payload, "epub")
        self.assertTrue(metadata["reflowable"])
        self.assertGreater(metadata["count"], 2)
        page = self.backend.render(2, width=600)
        self.assertIsNotNone(page["position"])
        self.assertEqual(self.backend.resolve(page["position"]), 2)
        larger = self.backend.layout(font_size=26, position=page["position"])
        self.assertGreater(larger["count"], metadata["count"])
        self.assertIsInstance(larger["page"], int)
        self.assertIsNotNone(self.backend.render(larger["page"], width=600)["position"])

    def test_cfi_invalid_and_ambiguous_positions_fail_closed(self):
        positions = EpubPositions(sample_epub())
        self.assertIsNone(positions.cfi_for_text(0, "no matching text that exists in this chapter"))
        for value in ("0.42", "epubcfi(/6/999!/4/2/1:0)", "epubcfi(/6/2!/999/1:0)"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                positions.resolve(value)

    def test_adjacent_comment_cdata_chunks_text_assertions_and_surrogate_boundaries(self):
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(sample_epub())) as source, zipfile.ZipFile(output, "w") as target:
            for member in source.infolist():
                raw = source.read(member.filename)
                if member.filename == "OPS/one.xhtml":
                    raw = b'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Mixed</title></head><body><p id="mixed">Alpha<!-- marker --> beta ' + '😀'.encode() + b'<![CDATA[ gamma]]> delta.</p></body></html>'
                target.writestr(member.filename, raw)
        positions = EpubPositions(output.getvalue())
        point = positions.cfi_for_text(0, "Alpha beta 😀 gamma delta.")
        self.assertIsNotNone(point)
        anchor = "epubcfi(/6/2!/4/2/1:13[beta 😀, gamma])"
        self.assertIsInstance(positions.resolve(anchor)[1], int)
        with self.assertRaises(ValueError):
            positions.resolve(anchor.replace("beta", "wrong"))
        with self.assertRaises(ValueError):
            positions.resolve("epubcfi(/6/2!/4/2/1:12)")
        selected = positions.selection_cfi(0, "beta 😀 gamma")
        self.assertIsInstance(positions.resolve(selected)[1], int)

    def test_native_word_geometry_and_highlights_are_page_scoped_after_rotation(self):
        self.backend.open(sample_pdf(), "pdf")
        annotation = {"id": 7, "page": 1, "kind": "highlight", "text": "garden"}
        other = self.backend.render(0, width=600, annotations=[annotation])
        selected = self.backend.render(1, width=600, rotation=90, annotations=[annotation])
        self.assertEqual(other["activeAnnotations"], [])
        self.assertEqual(selected["activeAnnotations"], [7])
        self.assertTrue(selected["highlights"])
        self.assertTrue(selected["words"])
        width, height = selected["imageSize"]
        for word in selected["words"]:
            x, y, w, h = word["rect"]
            self.assertTrue(0 <= x < width and 0 <= y < height and w > 0 and h > 0)

    def test_native_document_process_roundtrip(self):
        from flyleaf_desktop.document_process import DocumentProcess
        engine = DocumentProcess(None)
        results, errors = [], []
        try:
            engine.request("open", results.append, errors.append, payload=sample_pdf(), format="pdf")
            wait_for(lambda: bool(results) or bool(errors), timeout=10000)
            self.assertEqual(errors, [])
            self.assertEqual(results[0]["count"], 3)
            engine.request("render", results.append, errors.append, page=0, width=600)
            wait_for(lambda: len(results) == 2 or bool(errors), timeout=10000)
            self.assertTrue(results[1]["image"].startswith(b"\x89PNG"))
        finally:
            engine.close()
            engine.deleteLater()
            APP.processEvents()

    def test_system_voice_worker_initializes_without_starting_playback(self):
        from flyleaf_desktop.speech import SpeechProcess
        engine = SpeechProcess(None)
        voices, errors = [], []
        engine.voices.connect(voices.append)
        engine.failed.connect(errors.append)
        try:
            wait_for(lambda: bool(voices) or bool(errors), timeout=10000)
            if errors:
                self.assertIn("speech", errors[0].lower())
            else:
                self.assertTrue(engine.ready)
                self.assertTrue(voices[0])
                self.assertTrue(all(voice.get("id") for voice in voices[0]))
                self.assertIsNone(engine.pending_speech)
        finally:
            engine.close(); engine.deleteLater(); APP.processEvents()
        self.assertFalse(engine.process.is_alive())

    def test_source_ranges_element_anchors_and_server_foliate_interoperability(self):
        if not shutil.which("node"):
            self.skipTest("Node is required for the pinned server/Foliate interoperability check")
        root = Path(__file__).resolve().parents[2]
        if not (root / "node_modules/foliate-js").exists():
            self.skipTest("Install server dependencies to run the pinned Foliate corpus check")
        payload = sample_epub()
        positions = EpubPositions(payload)
        self.backend.open(payload, "epub")
        point = self.backend.render(2, width=600)["position"]
        selection = positions.selection_cfi(0, "Chapter 1 paragraph 7 contains a quiet garden")
        locators = [point, selection, "epubcfi(/6/2!/4/2)"]
        with tempfile.TemporaryDirectory(dir=root / "desktop/build") as directory:
            source = Path(directory) / "sample.epub"
            source.write_bytes(payload)
            script = """
const {epubXPointer, epubFromXPointer} = require('./server/kosync-position');
const CFI = require('foliate-js/epubcfi.js');
(async () => {
  const book = {path: process.argv[1], format: 'epub'};
  const output = [];
  for (const locator of JSON.parse(process.argv[2])) {
    CFI.parse(locator);
    const pointer = await epubXPointer(book, locator);
    output.push({pointer, cfi: pointer && await epubFromXPointer(book, pointer)});
  }
  console.log(JSON.stringify(output));
})().catch(error => {console.error(error); process.exitCode = 1;});
"""
            result = subprocess.run(["node", "-e", script, str(source), json.dumps(locators)], cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            for locator, item in zip(locators, output):
                self.assertIsNotNone(item["pointer"], locator)
                self.assertIsNotNone(item["cfi"], locator)
                self.assertEqual(positions.resolve(locator), positions.resolve(item["cfi"]), locator)


if __name__ == "__main__":
    unittest.main()

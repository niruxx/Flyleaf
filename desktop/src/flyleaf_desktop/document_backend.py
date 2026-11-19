"""Native MuPDF document engine. Used exclusively in a disposable worker process."""
from .epub_positions import EpubPositions, normalized
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from xml.dom import minidom
from collections import OrderedDict


class DocumentBackend:
    def __init__(self):
        self.document = None
        self.positions = None
        self.payload = None
        self._verified_pages = OrderedDict()
        self._annotation_pages = {}

    def open(self, payload, format="pdf", position=None, font_size=18):
        import pymupdf
        self.close()
        if len(payload) > 128 * 1024 * 1024:
            raise ValueError("This document exceeds the 128 MiB in-memory limit.")
        if format == "epub":
            with ZipFile(BytesIO(payload)) as archive:
                entries = archive.infolist()
                if len(entries) > 20000 or sum(item.file_size for item in entries) > 256 * 1024 * 1024:
                    raise ValueError("The EPUB exceeds the archive expansion limit.")
        self.payload = payload
        self.document = pymupdf.open(stream=payload, filetype=format)
        if self.document.needs_pass:
            raise ValueError("This PDF is password-protected. An unlocked rendition is required.")
        if self.document.is_reflowable:
            self.document.layout(width=650, height=900, fontsize=font_size)
        if not 0 < self.document.page_count <= 20000:
            raise ValueError("This document has an invalid or excessive page count.")
        warning = ""
        if format == "epub":
            try:
                self.positions = EpubPositions(payload)
            except Exception:
                self.positions = None
                warning = "The source DOM could not be verified. Ebook position writes are disabled for this rendition."
        metadata = {"count": self.document.page_count, "toc": self.document.get_toc(),
                    "reflowable": self.document.is_reflowable, "warning": warning, "page": 0}
        if position and self.positions:
            try:
                metadata["page"] = self.resolve(position)
            except ValueError:
                metadata["warning"] = "The saved EPUB position could not be verified in this rendition. It has been retained; choose where to resume."
                metadata["unresolved"] = True
        return metadata

    def render(self, page, width=1800, rotation=0, highlights=None, annotations=None):
        import pymupdf
        native = self.document.load_page(page)
        rotation = int(rotation) % 360
        rect = native.rect
        scale = min(max(1, width) / max(1, rect.width if rotation % 180 == 0 else rect.height), 4)
        if rect.width * rect.height * scale * scale > 24_000_000:
            scale = (24_000_000 / (rect.width * rect.height)) ** .5
        matrix = pymupdf.Matrix(scale, scale).prerotate(rotation)
        bitmap = native.get_pixmap(matrix=matrix, alpha=False)
        text = native.get_text("text")
        locator = None
        if self.positions:
            chapter, _local_page = self.document.location_from_page_number(page)
            locator = self.positions.cfi_for_text(chapter, text)
        links = []
        for link in native.get_links():
            if link.get("page", -1) >= 0:
                links.append({"page": link["page"], "title": "Go to linked page"})
            elif link.get("uri", "").startswith(("http://", "https://")):
                links.append({"url": link["uri"], "title": link["uri"]})
        rectangles = []
        bounds = native.rect * matrix
        words = []
        for word in native.get_text("words")[:20000]:
            rectangle = pymupdf.Rect(word[:4]) * matrix
            words.append({"rect": [rectangle.x0 - bounds.x0, rectangle.y0 - bounds.y0, rectangle.width, rectangle.height], "text": word[4]})
        active = []
        passages = list(highlights or [])
        for annotation in (annotations or [])[:1000]:
            if self.positions:
                anchor = annotation.get("locator")
                if anchor not in self._annotation_pages:
                    try:
                        self._annotation_pages[anchor] = self.resolve(anchor)
                    except ValueError:
                        self._annotation_pages[anchor] = None
                matches = self._annotation_pages[anchor] == page
            else:
                matches = annotation.get("page") == page
            if matches:
                active.append(annotation.get("id"))
                if annotation.get("kind") == "highlight":
                    passages.append(annotation.get("text", ""))
        for passage in passages[:200]:
            if not isinstance(passage, str) or not passage:
                continue
            for rectangle in native.search_for(passage[:5000])[:100]:
                rectangle = rectangle * matrix
                rectangles.append([rectangle.x0 - bounds.x0, rectangle.y0 - bounds.y0, rectangle.width, rectangle.height])
        return {"image": bitmap.tobytes("png"), "text": text[:500_000], "position": locator, "highlights": rectangles,
                "links": links, "page": page, "rotation": rotation, "words": words, "imageSize": [bitmap.width, bitmap.height], "activeAnnotations": active}

    def search(self, query):
        query = str(query).strip()[:200]
        if not query:
            return []
        results = []
        for number in range(self.document.page_count):
            page = self.document.load_page(number)
            if page.search_for(query):
                results.append({"page": number, "text": page.get_text("text")[:600]})
                if len(results) >= 100:
                    break
        return results

    def resolve(self, cfi):
        if not self.positions:
            raise ValueError("No verified EPUB source positions are available.")
        chapter, target = self.positions.resolve(cfi)
        source = self.positions.chapters[chapter]["text"]
        for index in range(self.document.chapter_page_count(chapter)):
            number = self.document.page_number_from_location((chapter, index))
            if number not in self._verified_pages:
                text = self.document.load_page(number).get_text("text")
                locator = self.positions.cfi_for_text(chapter, text)
                self._verified_pages[number] = (normalized(text), self.positions.resolve(locator)[1] if locator else None)
                while len(self._verified_pages) > 256:
                    self._verified_pages.popitem(last=False)
            probe, start = self._verified_pages[number]
            if start == target:
                return number
            # Prove that the actual anchor's unique source context is rendered on
            # this page. A nearby page start / distant repeated tail is insufficient.
            for left, right in ((0, 64), (64, 0), (32, 32)):
                begin, end = max(0, target - left), min(len(source), target + right)
                context = source[begin:end]
                if len(context) >= 12 and source.find(context) == begin and source.find(context, begin + 1) < 0 and context in probe:
                    return number
        raise ValueError("The saved text anchor cannot be located in this layout.")

    def selection_locator(self, page, selected):
        native = self.document.load_page(page)
        if not normalized(selected) or normalized(selected) not in normalized(native.get_text("text")):
            raise ValueError("Select text from the displayed page before saving a highlight.")
        if not self.document.is_reflowable:
            return str(page)
        if not self.positions:
            raise ValueError("No verified source DOM is available for this highlight.")
        chapter, _local = self.document.location_from_page_number(page)
        return self.positions.selection_cfi(chapter, selected)

    def layout(self, font_size=18, position=None, font_family="publisher", line_height=1.5, margin="normal"):
        if not self.document.is_reflowable:
            return {"count": self.document.page_count, "page": 0, "toc": self.document.get_toc()}
        if self.positions and font_family in ("publisher", "serif", "sans-serif", "monospace"):
            import pymupdf
            style = f"body{{line-height:{max(1.0, min(2.5, float(line_height)))} !important; margin:{'4%' if margin == 'wide' else '1%' if margin == 'narrow' else '2%'} !important;}}"
            if font_family != "publisher":
                style += f"body,p,span,div,li,td{{font-family:{font_family} !important;}}"
            result = BytesIO()
            paths = {chapter["path"] for chapter in self.positions.chapters}
            with ZipFile(BytesIO(self.payload)) as source, ZipFile(result, "w", ZIP_DEFLATED) as target:
                for entry in source.infolist():
                    raw = source.read(entry.filename)
                    if entry.filename in paths:
                        xml = minidom.parseString(raw)
                        heads = xml.getElementsByTagNameNS("*", "head")
                        if heads:
                            css = xml.createElementNS("http://www.w3.org/1999/xhtml", "style")
                            css.appendChild(xml.createTextNode(style)); heads[0].appendChild(css)
                            raw = xml.toxml(encoding="utf-8")
                    target.writestr(entry.filename, raw)
            self.document.close()
            self.document = pymupdf.open(stream=result.getvalue(), filetype="epub")
        self.document.layout(width=650, height=900, fontsize=max(10, min(40, font_size)))
        self._verified_pages.clear(); self._annotation_pages.clear()
        return {"count": self.document.page_count, "page": self.resolve(position) if position else 0,
                "toc": self.document.get_toc()}

    def close(self):
        if self.document is not None:
            self.document.close()
        self.document = self.positions = self.payload = None
        self._verified_pages.clear(); self._annotation_pages.clear()


def serve(connection):
    """No network or session credentials cross this process boundary."""
    backend = DocumentBackend()
    try:
        while True:
            identity, operation, arguments = connection.recv()
            if operation == "close":
                break
            try:
                result = getattr(backend, operation)(**arguments)
                connection.send((identity, result, ""))
            except Exception as error:
                connection.send((identity, None, str(error)[:500]))
    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        backend.close()
        connection.close()

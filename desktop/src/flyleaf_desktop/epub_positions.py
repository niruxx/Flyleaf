"""Source-DOM EPUB CFI anchors. Never substitute a page fraction for a CFI.

Only uniquely verified source text can produce an outgoing locator. Unsupported
CFI forms and ambiguous text fail closed, leaving the server's position intact.
"""
from io import BytesIO
import posixpath
import re
import unicodedata
from urllib.parse import unquote
from xml.dom import minidom, Node
from zipfile import ZipFile


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).replace("\u00ad", "").split())


def elements(node):
    return [child for child in node.childNodes if child.nodeType == Node.ELEMENT_NODE]


def local(node):
    return node.localName or node.nodeName.split(":")[-1]


class EpubPositions:
    def __init__(self, payload):
        self.chapters = []
        with ZipFile(BytesIO(payload)) as archive:
            infos = archive.infolist()
            if len(infos) > 20000 or sum(i.file_size for i in infos) > 256 * 1024 * 1024:
                raise ValueError("The ebook exceeds the expanded resource limit.")
            def read(path):
                path = unquote(path)
                if path.startswith("/") or ".." in path.split("/") or archive.getinfo(path).file_size > 16 * 1024 * 1024:
                    raise ValueError("Unsafe or oversized ebook resource.")
                raw = archive.read(path)
                if b"<!ENTITY" in raw.upper():
                    raise ValueError("Ebook entity declarations are unsupported.")
                return raw
            container = minidom.parseString(read("META-INF/container.xml"))
            rootfiles = [n for n in container.getElementsByTagNameNS("*", "rootfile")]
            if not rootfiles:
                raise ValueError("The ebook has no package document.")
            package_path = rootfiles[0].getAttribute("full-path")
            package = minidom.parseString(read(package_path)).documentElement
            spine = next(n for n in elements(package) if local(n) == "spine")
            manifest = next(n for n in elements(package) if local(n) == "manifest")
            items = {n.getAttribute("id"): n for n in elements(manifest)}
            self.spine_step = (elements(package).index(spine) + 1) * 2
            self.spine_id = spine.getAttribute("id")
            for index, ref in enumerate(elements(spine)):
                item = items.get(ref.getAttribute("idref"))
                if item is None:
                    raise ValueError("The ebook spine references a missing resource.")
                path = posixpath.normpath(posixpath.join(posixpath.dirname(package_path), item.getAttribute("href")))
                root = minidom.parseString(read(path)).documentElement
                entries, chars, offsets, ids = [], [], [], {}
                def visit(node, steps, depth=0):
                    if depth > 120:
                        raise ValueError("The ebook DOM is nested too deeply.")
                    if node.nodeType == Node.ELEMENT_NODE and local(node) in ("script", "style", "head"):
                        return
                    if node.nodeType == Node.ELEMENT_NODE and node.getAttribute("id"):
                        ids[tuple(steps)] = node.getAttribute("id")
                    count = 0
                    for child in node.childNodes:
                        if child.nodeType == Node.ELEMENT_NODE:
                            count += 1
                            visit(child, steps + [count * 2], depth + 1)
                        elif child.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE):
                            entry = {"steps": steps + [count * 2 + 1], "text": child.data}
                            if entries and entries[-1]["steps"] == entry["steps"]:
                                number = len(entries) - 1
                                utf16 = len(entries[-1]["text"].encode("utf-16-le")) // 2
                                entries[-1]["text"] += child.data
                            else:
                                number = len(entries); entries.append(entry)
                                utf16 = 0
                            for char in child.data:
                                value = unicodedata.normalize("NFKC", char)
                                for expanded in value:
                                    if expanded == "\u00ad":
                                        continue
                                    expanded = " " if expanded.isspace() else expanded
                                    if expanded == " " and (not chars or chars[-1] == " "):
                                        continue
                                    chars.append(expanded); offsets.append((number, utf16))
                                utf16 += len(char.encode("utf-16-le")) // 2
                            # Element boundaries can render as whitespace; matching
                            # spans across them is deliberately avoided below.
                visit(root, [])
                self.chapters.append({"path": path, "entries": entries, "text": "".join(chars), "offsets": offsets,
                                      "ids": ids, "idref": ref.getAttribute("idref"), "refId": ref.getAttribute("id")})

    def cfi_for_text(self, chapter, rendered_text):
        if not 0 <= chapter < len(self.chapters):
            return None
        source = self.chapters[chapter]
        words = normalized(rendered_text).split()
        for skip in range(min(12, len(words))):
            probe = " ".join(words[skip:skip + 10])
            if len(probe) < 12:
                continue
            start = source["text"].find(probe)
            if start < 0 or source["text"].find(probe, start + 1) >= 0:
                continue
            node, offset = source["offsets"][start]
            chosen = source["entries"][node]["steps"]
            if sum(entry["steps"] == chosen for entry in source["entries"]) != 1:
                continue
            steps = "/".join(str(step) for step in source["entries"][node]["steps"])
            return f"epubcfi(/{self.spine_step}/{2 * (chapter + 1)}!/{steps}:{offset})"
        return None

    def selection_cfi(self, chapter, selected):
        source = self.chapters[chapter]
        selected = normalized(selected)
        start = source["text"].find(selected)
        if not selected or start < 0 or source["text"].find(selected, start + 1) >= 0:
            raise ValueError("The selected text is not a unique source passage. No approximate highlight was saved.")
        start_node, start_offset = source["offsets"][start]
        end_node, end_offset = source["offsets"][start + len(selected) - 1]
        first, last = source["entries"][start_node], source["entries"][end_node]
        for target in (first, last):
            if sum(entry["steps"] == target["steps"] for entry in source["entries"]) != 1:
                raise ValueError("This mixed text node cannot be represented safely as a CFI range.")
        offset = 0
        for char in last["text"]:
            units = len(char.encode("utf-16-le")) // 2
            if offset == end_offset:
                end_offset += units; break
            offset += units
        common = []
        for a, b in zip(first["steps"][:-1], last["steps"][:-1]):
            if a != b:
                break
            common.append(a)
        prefix = "/" + "/".join(map(str, common)) if common else ""
        suffix_start = "/" + "/".join(map(str, first["steps"][len(common):])) + f":{start_offset}"
        suffix_end = "/" + "/".join(map(str, last["steps"][len(common):])) + f":{end_offset}"
        return f"epubcfi(/{self.spine_step}/{2 * (chapter + 1)}!{prefix},{suffix_start},{suffix_end})"

    def resolve(self, cfi):
        if not isinstance(cfi, str) or len(cfi) > 2000 or not cfi.startswith("epubcfi(") or not cfi.endswith(")"):
            raise ValueError("This ebook position is not a supported EPUB CFI.")
        # Assertions do not change numeric paths. Escapes inside assertions are
        # consumed rather than accidentally interpreting their commas as ranges.
        body, depth, escaped = [], 0, False
        assertions, assertion, assertion_prefix = [], [], ""
        for char in cfi[8:-1]:
            if escaped:
                if depth:
                    assertion.append(char)
                escaped = False
                continue
            if char == "^":
                escaped = True; continue
            if char == "[":
                if depth:
                    raise ValueError("Nested EPUB CFI assertions are unsupported.")
                assertion, assertion_prefix = [], "".join(body)
                depth += 1; continue
            if char == "]":
                assertions.append((assertion_prefix, "".join(assertion)))
                depth -= 1; continue
            if depth == 0:
                body.append(char)
            else:
                assertion.append(char)
        if depth != 0:
            raise ValueError("Unbalanced EPUB CFI assertions.")
        value = "".join(body)
        parts = value.split(",")
        if len(parts) == 3:
            value = parts[0] + parts[1]  # range start, not a guessed fraction
        elif len(parts) != 1:
            raise ValueError("Unsupported EPUB CFI range.")
        value = value.split(";", 1)[0]
        match = re.fullmatch(r"/(\d+)/(\d+)!((?:/\d+)+)(?::(\d+))?", value)
        if not match or int(match[1]) != self.spine_step or int(match[2]) % 2:
            raise ValueError("This EPUB CFI does not match the book's spine.")
        chapter = int(match[2]) // 2 - 1
        if not 0 <= chapter < len(self.chapters):
            raise ValueError("This EPUB CFI points outside the book.")
        steps, offset = [int(v) for v in match[3].split("/") if v], int(match[4] or 0)
        source = self.chapters[chapter]
        for prefix, expected in assertions:
            if ":" in prefix:
                path_text = prefix.split("!", 1)[-1]
                assertion_path, assertion_offset = path_text.rsplit(":", 1)
                try:
                    assertion_steps = [int(v) for v in assertion_path.split("/") if v]
                    entry = next(entry for entry in source["entries"] if entry["steps"] == assertion_steps)
                    encoded = entry["text"].encode("utf-16-le")
                    split = int(assertion_offset) * 2
                    before, after = expected.split(",")
                    if not encoded[:split].decode("utf-16-le").endswith(before) or not encoded[split:].decode("utf-16-le").startswith(after):
                        raise ValueError("Text assertion mismatch")
                except (ValueError, StopIteration, UnicodeError):
                    raise ValueError("The EPUB CFI text assertion does not match the source.") from None
                continue
            if "!" not in prefix:
                valid = expected == self.spine_id if prefix == f"/{self.spine_step}" else expected in (source["idref"], source["refId"])
                if not valid:
                    raise ValueError("The EPUB CFI spine assertion does not match this rendition.")
            else:
                content_path = prefix.split("!", 1)[1].split(",", 1)[0]
                if not re.fullmatch(r"(?:/\d+)+", content_path):
                    raise ValueError("Unsupported EPUB CFI assertion path.")
                path = tuple(int(v) for v in content_path.split("/") if v)
                if source["ids"].get(path) != expected:
                    raise ValueError("The EPUB CFI element assertion does not match the source.")
        element_anchor = steps[-1] % 2 == 0 and match[4] is None
        for number, entry in enumerate(source["entries"]):
            if entry["steps"] == steps or element_anchor and entry["steps"][:len(steps)] == steps:
                if sum(other["steps"] == entry["steps"] for other in source["entries"]) != 1:
                    break
                if offset > len(entry["text"].encode("utf-16-le")) // 2:
                    break
                try:
                    entry["text"].encode("utf-16-le")[:offset * 2].decode("utf-16-le")
                except UnicodeError:
                    break  # A CFI cannot bisect a surrogate pair.
                for index, (node, position) in enumerate(source["offsets"]):
                    if node == number and position >= offset:
                        return chapter, index
                if offset == len(entry["text"].encode("utf-16-le")) // 2:
                    indices = [i for i, pair in enumerate(source["offsets"]) if pair[0] == number]
                    if indices:
                        return chapter, indices[-1] + 1
                break
        raise ValueError("This EPUB CFI text node cannot be verified.")

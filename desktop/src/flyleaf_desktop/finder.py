"""Native, permission-aware Content Finder; all plugin work stays on the server."""
from urllib.parse import quote
from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QComboBox, QHBoxLayout, QLineEdit, QListWidget,
    QListWidgetItem, QPlainTextEdit, QPushButton, QSplitter, QVBoxLayout, QWidget,
    QTabWidget, QCheckBox, QScrollArea)
from .widgets import decode_image, label, text
from .material import symbol
from .finder_activity import FinderActivity

ROLE = Qt.ItemDataRole.UserRole


class FinderPage(QWidget):
    def __init__(self, api):
        super().__init__()
        self.api = api
        self.user = None
        self.session = 0
        self.generation = 0
        self.detail_generation = 0
        self.source_generation = 0
        self.source = None
        self.details = None
        self.page = 1
        self.has_more = False
        self._sources = []
        self.folders = []
        self._queue_pending = False
        self._follow_pending = False
        self.recommending = False
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 20, 20, 20)
        outer.addWidget(label("Content Finder", heading=True))
        outer.addWidget(label("Explore your server's sources and add your next read to a library.", wrap=True))
        toolbar = QHBoxLayout()
        self.query = QLineEdit()
        self.query.setAccessibleName("Search Content Finder")
        self.query.setPlaceholderText("Search the selected source")
        self.query.setMaxLength(200)
        self.query.returnPressed.connect(self.search)
        toolbar.addWidget(self.query, 1)
        self.kind = QComboBox()
        self.kind.setAccessibleName("Source kind")
        for caption, value in [("All sources", ""), ("Books", "books"), ("Comics", "comics"), ("Manga", "manga")]:
            self.kind.addItem(caption, value)
        self.kind.currentIndexChanged.connect(self._filter_sources)
        toolbar.addWidget(self.kind)
        self.search_button = QPushButton("Search")
        self.search_button.setProperty("primary", True)
        self.search_button.setIcon(symbol("search", "onPrimary"))
        self.search_button.clicked.connect(lambda: self.search())
        toolbar.addWidget(self.search_button)
        refresh = QPushButton("Refresh sources")
        refresh.clicked.connect(self.refresh_sources)
        toolbar.addWidget(refresh)
        recommend = QPushButton("Recommendations")
        recommend.clicked.connect(self.recommendations)
        toolbar.addWidget(recommend)
        self.search_toolbar = QWidget()
        self.search_toolbar.setLayout(toolbar)
        toolbar.setContentsMargins(0, 0, 0, 0)
        self.notice = label("", wrap=True)
        self.search_section = QWidget()
        search_layout = QVBoxLayout(self.search_section)
        search_layout.setContentsMargins(0, 0, 0, 0)
        search_layout.addWidget(self.search_toolbar)
        search_layout.addWidget(self.notice)
        outer.addWidget(self.search_section)
        self.tabs = QTabWidget()
        outer.addWidget(self.tabs, 1)
        browse = QWidget()
        browse_layout = QVBoxLayout(browse)
        browse_layout.setContentsMargins(0, 0, 0, 0)
        self.tabs.addTab(browse, "Browse sources")
        self.activity = FinderActivity(api)
        self.tabs.addTab(self.activity, "Downloads and following")
        self.tabs.currentChanged.connect(self._tab_changed)
        splitter = QSplitter()
        self.sources = QListWidget()
        self.sources.setAccessibleName("Content Finder sources")
        self.sources.setMaximumWidth(220)
        self.sources.currentItemChanged.connect(self._source_selected)
        splitter.addWidget(self.sources)
        center = QWidget()
        content = QVBoxLayout(center)
        content.setContentsMargins(0, 0, 0, 0)
        self.folder_back = QPushButton("Back to parent folder")
        self.folder_back.clicked.connect(self.parent_folder)
        self.folder_back.hide()
        content.addWidget(self.folder_back)
        self.genres = QComboBox()
        self.genres.setAccessibleName("Source genre")
        self.genres.addItem("All genres", "")
        self.genres.currentIndexChanged.connect(self.search)
        content.addWidget(self.genres)
        self.results = QListWidget()
        self.results.setAccessibleName("Source search results")
        self.results.currentItemChanged.connect(self._result_selected)
        self.results.itemActivated.connect(self._activate_result)
        content.addWidget(self.results, 1)
        self.more = QPushButton("Load more results")
        self.more.clicked.connect(lambda: self.search(False))
        self.more.hide()
        content.addWidget(self.more)
        splitter.addWidget(center)
        detail = QWidget()
        body = QVBoxLayout(detail)
        self.title = label("Choose a source", heading=True, wrap=True)
        body.addWidget(self.title)
        self.artwork = label("")
        self.artwork.setAccessibleName("Source title cover")
        self.artwork.setAlignment(Qt.AlignmentFlag.AlignHCenter)
        self.artwork.hide()
        body.addWidget(self.artwork)
        self.summary = QPlainTextEdit()
        self.summary.setReadOnly(True)
        self.summary.setAccessibleName("Finder book details")
        self.summary.setMinimumHeight(60)
        self.summary.setMaximumHeight(100)
        body.addWidget(self.summary, 1)
        self.files = QListWidget()
        self.files.setAccessibleName("Files available to download")
        self.files.setMinimumHeight(80)
        self.files.setMaximumHeight(120)
        body.addWidget(self.files, 1)
        selection = QHBoxLayout()
        for caption, state in (("Select all files", Qt.CheckState.Checked), ("Clear selection", Qt.CheckState.Unchecked)):
            button = QPushButton(caption)
            button.clicked.connect(lambda _checked=False, value=state: self.select_files(value))
            selection.addWidget(button)
        body.addLayout(selection)
        self.target = QComboBox()
        self.target.setAccessibleName("Download destination library")
        body.addWidget(self.target)
        self.download = QPushButton("Add selected files to library")
        self.download.setProperty("primary", True)
        self.download.setEnabled(False)
        self.download.clicked.connect(self.queue_download)
        body.addWidget(self.download)
        self.auto_follow = QCheckBox("Automatically download future chapters")
        self.auto_follow.setChecked(False)
        body.addWidget(self.auto_follow)
        self.follow = QPushButton("Follow this title")
        self.follow.setEnabled(False)
        self.follow.clicked.connect(self.follow_title)
        body.addWidget(self.follow)
        detail_scroll = QScrollArea()
        detail_scroll.setWidgetResizable(True)
        detail_scroll.setWidget(detail)
        splitter.addWidget(detail_scroll)
        splitter.setSizes([180, 300, 320])
        browse_layout.addWidget(splitter, 1)

    def _tab_changed(self, index):
        self.search_section.setVisible(index == 0)

    def clear_session(self):
        self.session += 1
        self.generation += 1
        self.detail_generation += 1
        self.source_generation += 1
        self.user = None
        self.artwork.clear()
        self.artwork.hide()
        self.activity.clear_session()
        self.folders = []
        self.folder_back.hide()
        self._queue_pending = self._follow_pending = False
        self.source = self.details = None
        self._sources = []
        self.recommending = False
        for widget in (self.sources, self.results, self.files):
            widget.clear()
        self.target.clear()
        self.query.clear()
        self.genres.blockSignals(True)
        self.genres.clear(); self.genres.addItem("All genres", "")
        self.genres.blockSignals(False)
        self.summary.clear()
        self.title.setText("Choose a source")
        self.notice.clear()
        self.download.setEnabled(False)
        self.follow.setEnabled(False)
        self.auto_follow.setChecked(False)
        self.more.hide()

    def start_session(self, user):
        self.clear_session()
        self.user = user
        self.activity.start_session(user)
        self.refresh_sources()
        token = self.session
        def libraries(data):
            if token != self.session or not isinstance(data, list):
                return
            for item in data:
                if not isinstance(item, dict):
                    continue
                # The server validates write access again when enqueueing.
                self.target.addItem(text(item.get("name"), "Library"), item.get("id"))
            self.activity.set_libraries([item for item in data if isinstance(item, dict)])
            self._actions()
        self.api.json("GET", "/api/libraries", libraries, lambda error: self.notice.setText(error.message) if token == self.session else None)

    def refresh_sources(self):
        if not self.user:
            return
        self.generation += 1
        self.detail_generation += 1
        token = self.generation
        self.notice.setText("Loading sources…")
        self.source = self.details = None
        self.folders = []; self.folder_back.hide()
        self.results.clear()
        self.files.clear()
        self.summary.clear(); self.title.setText("Choose a source")
        self.download.setEnabled(False)
        self.follow.setEnabled(False)
        def loaded(data):
            if token != self.generation:
                return
            if not isinstance(data, list):
                self.notice.setText("The server returned an invalid source list.")
                return
            self._sources = [s for s in data if isinstance(s, dict)]
            self._filter_sources()
            self.notice.setText("Choose a source to browse or search." if self.sources.count() else "No sources available. Ask an administrator to configure Content Finder plugins on the server.")
        self.api.json("GET", "/api/finder/sources", loaded, lambda error: self.notice.setText(error.message) if token == self.generation else None)

    def _filter_sources(self):
        self.sources.clear()
        kind = self.kind.currentData()
        for source in self._sources:
            if kind and kind not in (source.get("kinds") or []):
                continue
            item = QListWidgetItem(text(source.get("name"), "Source"))
            item.setData(ROLE, source)
            item.setToolTip(text(source.get("description")))
            self.sources.addItem(item)

    def _path(self, suffix):
        return "/api/finder/" + quote(str(self.source["id"]), safe="") + "/" + suffix

    def _source_selected(self, item, _previous=None):
        self.recommending = False
        self.generation += 1
        self.source_generation += 1
        self.detail_generation += 1
        self.source = item.data(ROLE) if item else None
        self.details = None
        self.artwork.clear()
        self.artwork.hide()
        self.folders = []; self.folder_back.hide()
        self.results.clear(); self.files.clear(); self.summary.clear()
        self.download.setEnabled(False)
        self.follow.setEnabled(False)
        self.more.hide()
        self.genres.blockSignals(True)
        self.genres.clear(); self.genres.addItem("All genres", "")
        self.genres.blockSignals(False)
        if not self.source:
            self.title.setText("Choose a source")
            return
        self.title.setText(text(self.source.get("name"), "Source"))
        if self.source.get("error") or self.source.get("needsSetup"):
            self.notice.setText(text(self.source.get("error"), "This source needs configuration on your Flyleaf server."))
            return
        source_id, session, source_generation = self.source.get("id"), self.session, self.source_generation
        if self.source.get("hasGenres"):
            def genres(data):
                if session != self.session or source_generation != self.source_generation or not self.source or source_id != self.source.get("id") or not isinstance(data, list):
                    return
                self.genres.blockSignals(True)
                for genre in data:
                    if isinstance(genre, dict):
                        self.genres.addItem(text(genre.get("name")), genre.get("id"))
                self.genres.blockSignals(False)
            self.api.json("GET", self._path("genres"), genres, lambda _error: None)
        self.search()

    def search(self, reset=True):
        if not self.source or not self.user:
            return
        if self.source.get("error") or self.source.get("needsSetup"):
            self.notice.setText(text(self.source.get("error"), "Configure this source on your Flyleaf server before searching."))
            return
        reset = reset is not False
        self.recommending = False
        self.generation += 1
        token = self.generation
        self.detail_generation += 1
        if reset:
            self.artwork.clear()
            self.artwork.hide()
            self.page = 1
            self.results.clear(); self.files.clear()
            self.details = None; self.download.setEnabled(False)
            self.follow.setEnabled(False)
            self.summary.clear()
        next_page = 1 if reset else self.page + 1
        params = {"page": next_page, "q": self.query.text().strip()}
        genre = self.genres.currentData()
        if self.folders:
            suffix, params["id"] = "browse", self.folders[-1][0]
        elif genre:
            suffix, params["id"] = "genre", genre
        elif params["q"]:
            suffix = "search"
        elif self.source.get("canBrowse"):
            suffix = "latest"
        else:
            self.notice.setText("Enter a search term for this source.")
            return
        self.notice.setText("Searching this source…")
        self.more.setEnabled(False)
        def loaded(data):
            if token != self.generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                self.notice.setText("The source returned invalid results.")
                self.more.setEnabled(True)
                return
            self.page = next_page
            for book in data["items"]:
                if not isinstance(book, dict) or book.get("id") is None:
                    continue
                item = QListWidgetItem(("Folder · " if book.get("folder") else "") + text(book.get("title"), "Untitled") + "\n" + text(book.get("author")))
                item.setData(ROLE, book); self.results.addItem(item)
            self.has_more = bool(data.get("hasMore")) and bool(data["items"])
            self.more.setVisible(self.has_more); self.more.setEnabled(True)
            self.notice.setText(f"{self.results.count()} results. Select a title to see available files.")
        def failed(error):
            if token == self.generation:
                self.more.setEnabled(True)
                self.notice.setText(error.message)
        self.api.json("GET", self._path(suffix), loaded, failed, params=params)

    def _result_selected(self, item, _previous=None):
        if not item:
            return
        record = item.data(ROLE)
        if self.recommending:
            self.source = record.get("_finder_source")
        if not self.source:
            return
        self.detail_generation += 1
        token, generation = self.detail_generation, self.generation
        self.details = None; self.files.clear(); self.download.setEnabled(False)
        self.follow.setEnabled(False)
        self.title.setText(text(record.get("title"), "Untitled"))
        self.artwork.clear()
        self.artwork.hide()
        if record.get("folder"):
            self.summary.setPlainText("Open this folder with Enter or a double-click to browse its contents.")
            return
        self.summary.setPlainText("Loading details…")
        def loaded(data):
            if token != self.detail_generation or generation != self.generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("files"), list):
                self.summary.setPlainText("The source returned invalid details.")
                return
            self.details = data
            metadata = [text(data.get(key)) for key in ("author", "status", "language", "summary")]
            self.summary.setPlainText("\n\n".join(part for part in metadata if part))
            cover = data.get("cover") or record.get("cover")
            mature = (data.get("ageRating") in (2, 3) or self.source.get("nsfw"))
            if isinstance(cover, str) and cover.startswith("/api/finder/") and not mature:
                def artwork_loaded(raw):
                    if token != self.detail_generation or generation != self.generation:
                        return
                    try:
                        image = decode_image(raw)
                    except ValueError:
                        return
                    self.artwork.setPixmap(QPixmap.fromImage(image.scaledToHeight(95, Qt.TransformationMode.SmoothTransformation)))
                    self.artwork.show()
                self.api.image(cover, artwork_loaded, lambda _error: None)
            for file in data["files"]:
                if not isinstance(file, dict) or file.get("id") is None:
                    continue
                entry = QListWidgetItem(text(file.get("title"), "File") + " · " + text(file.get("format")).upper())
                entry.setData(ROLE, file)
                entry.setFlags(entry.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                entry.setCheckState(Qt.CheckState.Unchecked)
                self.files.addItem(entry)
            self._actions()
        self.api.json("GET", self._path("details"), loaded, lambda error: self.summary.setPlainText(error.message) if token == self.detail_generation and generation == self.generation else None, params={"id": record["id"]})

    def recommendations(self):
        if not self.user:
            return
        self.sources.setCurrentRow(-1)
        self._source_selected(None)
        token = self.generation
        self.notice.setText("Loading recommendations from your sources…")
        def loaded(data):
            if token != self.generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                self.notice.setText("The server returned invalid recommendations.")
                return
            self.recommending = True
            for row in data["items"]:
                if not isinstance(row, dict):
                    continue
                item, source = row.get("item"), row.get("source")
                if not isinstance(item, dict) or item.get("id") is None or not isinstance(source, dict) or not source.get("id"):
                    continue
                result = QListWidgetItem(text(item.get("title"), "Untitled") + "\n" + text(row.get("reason"), text(source.get("name"))))
                result.setData(ROLE, {**item, "_finder_source": source})
                self.results.addItem(result)
            self.notice.setText(f"{self.results.count()} recommendations. Select a title for available files." if self.results.count() else "No source recommendations are available.")
        self.api.json("GET", "/api/finder/recommendations", loaded,
                      lambda error: self.notice.setText(error.message) if token == self.generation else None)

    def queue_download(self):
        if not self.details or not self.source or self._queue_pending or self.target.currentData() is None:
            return
        files = [self.files.item(i).data(ROLE) for i in range(self.files.count()) if self.files.item(i).checkState() == Qt.CheckState.Checked]
        if not files:
            self.notice.setText("Select the files you want to add.")
            return
        token, session = self.detail_generation, self.session
        self._queue_pending = True
        self.download.setEnabled(False)
        body = {"libraryId": self.target.currentData(), "book": {key: self.details.get(key) for key in ("title", "author", "series", "cover", "ageRating", "layout")}, "files": files}
        body["book"]["sourceId"] = self.details.get("id")
        def done(data):
            if session == self.session:
                self._queue_pending = False
                self._actions()
                if not isinstance(data, dict) or not isinstance(data.get("ids"), list):
                    self.notice.setText("The server returned an invalid download acknowledgement. Check the server queue before retrying.")
                    return
                self.notice.setText(f"Queued {len(data.get('ids', []))} files. See Downloads and following for progress on your server.")
                if token == self.detail_generation: self.select_files(Qt.CheckState.Unchecked)
        def failed(error):
            if session != self.session: return
            self._queue_pending = False; self._actions()
            self.notice.setText(error.message + " Check Downloads and following before retrying if the request was interrupted.")
        self.api.json("POST", self._path("download"), done, failed, body)

    def _actions(self):
        ready = bool(self.user and self.details and self.source and self.target.currentData() is not None)
        self.download.setEnabled(ready and self.files.count() > 0 and not self._queue_pending)
        self.follow.setEnabled(ready and not self._follow_pending)

    def select_files(self, state):
        for index in range(self.files.count()): self.files.item(index).setCheckState(state)

    def _activate_result(self, item):
        if not self.source or not item: return
        record = item.data(ROLE)
        if not record.get("folder"): return
        self.folders.append((str(record["id"]), text(record.get("title"), "Folder")))
        self.query.clear()
        self.folder_back.show()
        self.search()

    def parent_folder(self):
        if not self.folders: return
        self.folders.pop()
        self.folder_back.setVisible(bool(self.folders))
        self.search()

    def follow_title(self):
        if not self.details or not self.source or self._follow_pending or self.target.currentData() is None: return
        session = self.session
        body = {"plugin": self.source["id"], "sourceId": self.details["id"],
                "libraryId": self.target.currentData(), "autoDownload": self.auto_follow.isChecked(),
                "book": {key: self.details.get(key) for key in ("title", "author", "series", "cover", "ageRating", "layout")},
                "files": [self.files.item(index).data(ROLE)["id"] for index in range(self.files.count())]}
        self._follow_pending = True; self._actions()
        def done(_data):
            if session != self.session: return
            self._follow_pending = False; self._actions()
            self.notice.setText("Following this title. Manage chapter checks and future downloads in Downloads and following.")
        def failed(error):
            if session != self.session: return
            self._follow_pending = False; self._actions(); self.notice.setText(error.message)
        self.api.json("POST", "/api/finder/follows", done, failed, body)

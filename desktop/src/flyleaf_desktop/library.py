from collections import deque

from PySide6.QtCore import QSize, Qt, QTimer, Signal
from PySide6.QtGui import QIcon, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView, QComboBox, QHBoxLayout, QInputDialog, QLineEdit, QListView, QListWidget,
    QListWidgetItem, QPlainTextEdit, QPushButton, QSplitter, QStyle, QVBoxLayout, QWidget,
)

from .api import ApiError, FlyleafApi
from .catalog import PAGES, SORTS, catalog_prefs
from .widgets import CoverDelegate, decode_image, label, text

ROLE = Qt.ItemDataRole.UserRole
GRID_SIZES = {"compact": ((126, 188), (84, 120)), "standard": ((160, 240), (112, 160)), "large": ((208, 294), (144, 204))}


class LibraryPage(QWidget):
    book_requested = Signal(dict)

    def __init__(self, api: FlyleafApi):
        super().__init__()
        self.api = api
        self.user: dict = {}
        self._mode = "home"
        self._library: int | None = None
        self._generation = 0
        self._detail_generation = 0
        self._session = 0
        self._has_more = False
        self._series: dict = {}
        self._libraries: dict = {}
        self._records: list[dict] = []
        self._covers: deque = deque()
        self._cover_active = 0
        self._show_covers = True
        self._catalog_sort = "default"
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        self.sidebar = QListWidget()
        self.sidebar.setObjectName("libraryNavigation")
        self.sidebar.setAccessibleName("Library navigation")
        self.sidebar.setMaximumWidth(215)
        self.sidebar.setMinimumWidth(160)
        self.sidebar.currentItemChanged.connect(self._navigation_changed)
        layout.addWidget(self.sidebar)
        body = QVBoxLayout()
        layout.addLayout(body, 1)
        self.heading = label("Home", heading=True)
        body.addWidget(self.heading)
        toolbar = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setObjectName("librarySearch")
        self.search.setPlaceholderText("Search your library")
        self.search.setAccessibleName("Search your library")
        self.search.setClearButtonEnabled(True)
        body.addWidget(self.search)
        self.sort = QComboBox()
        self.sort.setAccessibleName("Sort series")
        for title, value in SORTS:
            self.sort.addItem(title, value)
        toolbar.addWidget(self.sort)
        self.read_filter = QComboBox()
        self.read_filter.setAccessibleName("Reading status")
        for title, value in [("All reading states", ""), ("Unread", "unread"), ("In progress", "reading"), ("Finished", "completed")]:
            self.read_filter.addItem(title, value)
        toolbar.addWidget(self.read_filter)
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.clicked.connect(self.refresh)
        toolbar.addWidget(self.refresh_button)
        body.addLayout(toolbar)
        storage = QHBoxLayout()
        self.storage_notice = label("", wrap=True)
        storage.addWidget(self.storage_notice, 1)
        self.check_storage = QPushButton("Check storage again")
        self.check_storage.clicked.connect(self._check_storage)
        storage.addWidget(self.check_storage)
        self.check_storage.hide()
        self.rescan_links = QPushButton("Rescan Content Finder links")
        self.rescan_links.clicked.connect(self._rescan_links)
        storage.addWidget(self.rescan_links)
        self.rescan_links.hide()
        body.addLayout(storage)
        self.notice = label("", wrap=True)
        self.notice.setObjectName("libraryNotice")
        body.addWidget(self.notice)
        self.search_timer = QTimer(self)
        self.search_timer.setSingleShot(True)
        self.search_timer.setInterval(350)
        self.search_timer.timeout.connect(self.search_now)
        self.search.textChanged.connect(lambda _value: self.search_timer.start())
        self.search.returnPressed.connect(self.search_now)
        self.sort.currentIndexChanged.connect(self.search_now)
        self.read_filter.currentIndexChanged.connect(self.search_now)
        splitter = QSplitter()
        self.grid = QListWidget()
        self.grid.setObjectName("seriesGrid")
        self.grid.setAccessibleName("Books and series")
        self.grid.setViewMode(QListView.ViewMode.IconMode)
        self.grid.setResizeMode(QListView.ResizeMode.Adjust)
        self.grid.setMovement(QListView.Movement.Static)
        self.grid.setIconSize(QSize(112, 160))
        self.grid.setGridSize(QSize(160, 240))
        self.grid.setItemDelegate(CoverDelegate(self.grid))
        self.grid.setSpacing(8)
        self.grid.setWordWrap(True)
        self.grid.setUniformItemSizes(True)
        self.grid.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.grid.currentItemChanged.connect(self._selection_changed)
        self.grid.itemActivated.connect(self._activate_item)
        splitter.addWidget(self.grid)
        detail = QWidget()
        detail.setMinimumWidth(280)
        details = QVBoxLayout(detail)
        self.detail_title = label("Choose a book or series", heading=True, wrap=True)
        details.addWidget(self.detail_title)
        self.detail_meta = label("", wrap=True)
        details.addWidget(self.detail_meta)
        self.summary = QPlainTextEdit()
        self.summary.setReadOnly(True)
        self.summary.setAccessibleName("Series summary")
        self.summary.setMaximumHeight(165)
        details.addWidget(self.summary)
        self.books = QListWidget()
        self.books.setObjectName("volumeList")
        self.books.setAccessibleName("Books and volumes in this series")
        self.books.currentItemChanged.connect(self._book_selection_changed)
        self.books.itemActivated.connect(lambda _item: self._read_selected())
        details.addWidget(self.books, 1)
        self.read_button = QPushButton("Read / resume")
        self.read_button.setProperty("primary", True)
        self.read_button.setObjectName("readBookButton")
        self.read_button.setEnabled(False)
        self.read_button.clicked.connect(self._read_selected)
        details.addWidget(self.read_button)
        self.finished_button = QPushButton("Mark as read")
        self.finished_button.setEnabled(False)
        self.finished_button.clicked.connect(self._toggle_finished)
        details.addWidget(self.finished_button)
        self.find_source = QPushButton("Find Content Finder source…")
        self.find_source.clicked.connect(self._find_source)
        self.find_source.hide()
        details.addWidget(self.find_source)
        self.detail_notice = label("", wrap=True)
        details.addWidget(self.detail_notice)
        splitter.addWidget(detail)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([650, 380])
        body.addWidget(splitter, 1)
        bottom = QHBoxLayout()
        self.count = label("")
        bottom.addWidget(self.count)
        bottom.addStretch()
        self.more_button = QPushButton("Load more")
        self.more_button.clicked.connect(lambda: self._load_series(False))
        self.more_button.hide()
        bottom.addWidget(self.more_button)
        body.addLayout(bottom)

    def start_session(self, user: dict) -> None:
        self.clear_session()
        self.user = user
        start = catalog_prefs(user)["startPage"]
        start_index = next((index for index, (_, mode) in enumerate(PAGES) if mode == start), 0)
        title, self._mode = PAGES[start_index]
        self._library = None
        self.apply_catalog(initial=True)
        session = self._session
        self.sidebar.blockSignals(True)
        for name, mode in PAGES:
            item = QListWidgetItem(name)
            item.setData(ROLE, (mode, None))
            self.sidebar.addItem(item)
        self.sidebar.setCurrentRow(start_index)
        self.sidebar.blockSignals(False)
        self.heading.setText(title)
        self.api.json("GET", "/api/libraries", lambda data: self._libraries_loaded(data, session),
                      lambda error: self.notice.setText(error.message) if session == self._session else None)
        self.refresh()

    def apply_catalog(self, *, initial=False):
        prefs = catalog_prefs(self.user)
        grid, icon = GRID_SIZES.get(prefs["cardSize"], GRID_SIZES["standard"])
        self.grid.setGridSize(QSize(*grid))
        self.grid.setIconSize(QSize(*icon))
        index = max(0, self.sort.findData(prefs["sort"]))
        sort_changed = prefs["sort"] != self._catalog_sort
        self._catalog_sort = prefs["sort"]
        if initial or sort_changed:
            self.sort.blockSignals(True)
            self.sort.setCurrentIndex(index)
            self.sort.blockSignals(False)
        if initial:
            self.read_filter.blockSignals(True)
            self.read_filter.setCurrentIndex(0)
            self.read_filter.blockSignals(False)
        covers = prefs["showCovers"] is not False
        if covers != self._show_covers:
            self._show_covers = covers
            self._covers.clear()
            placeholder = self.style().standardIcon(QStyle.StandardPixmap.SP_FileIcon)
            for row, record in enumerate(self._records):
                item = self.grid.item(row)
                item.setIcon(placeholder)
                data = record["data"]
                if covers and data.get("coverUrl") and not data.get("blur"):
                    self._covers.append((self._generation, item, data["coverUrl"]))
            self._pump_covers()
        if not initial and sort_changed and self._mode == "library":
            self._load_series(True)

    def clear_session(self) -> None:
        self._session += 1
        self._generation += 1
        self._detail_generation += 1
        self.search_timer.stop()
        self._covers.clear()
        self._cover_active = 0
        self._records.clear()
        self.grid.clear()
        self.books.clear()
        self.sidebar.clear()
        self._series = {}
        self._libraries.clear()
        self._library = None
        self._library_controls()
        self.user = {}
        self.search.blockSignals(True)
        self.search.clear()
        self.search.blockSignals(False)
        self.summary.clear()
        self.detail_title.setText("Choose a book or series")
        self.detail_meta.clear()
        self.notice.clear()
        self.detail_notice.clear()
        self.count.clear()
        self.more_button.hide()

    def _libraries_loaded(self, data: object, session: int) -> None:
        if session != self._session:
            return
        if not isinstance(data, list):
            self.notice.setText("The server returned an invalid library list.")
            return
        self.sidebar.blockSignals(True)
        for library in data:
            if not isinstance(library, dict) or not isinstance(library.get("id"), int):
                continue
            item = QListWidgetItem(text(library.get("name"), "Library"))
            self._libraries[library["id"]] = library
            item.setData(ROLE, ("library", library["id"]))
            self.sidebar.addItem(item)
        self.sidebar.blockSignals(False)
        self._library_controls()

    def _library_controls(self):
        library = self._libraries.get(self._library, {})
        absent = bool(library.get("storageUnavailable"))
        self.check_storage.setVisible(absent)
        self.storage_notice.setText("Storage unavailable. Reconnect the drive or check folder permissions." if absent else "")
        enabled = (self.user.get("permissions") or {}).get("contentFinder") or self.user.get("role") == "admin"
        self.rescan_links.setVisible(bool(library.get("writable") and enabled))
        self.find_source.setVisible(bool(self._series.get("id") and enabled))

    def _check_storage(self):
        library_id = self._library
        if library_id is None:
            return
        self.check_storage.setEnabled(False)

        def loaded(data):
            self.check_storage.setEnabled(True)
            if library_id != self._library:
                return
            if data.get("needsScan"):
                self.storage_notice.setText("Drive reachable. Flyleaf is checking the library.")
                QTimer.singleShot(1000, lambda: self._refresh_library_health(library_id, attempts=8))
            elif data.get("available"):
                self._libraries[library_id]["storageUnavailable"] = False
                self._library_controls()
            else:
                self.storage_notice.setText("The server still cannot reach this library’s storage.")

        def failed(error):
            self.check_storage.setEnabled(True)
            if library_id == self._library:
                self.storage_notice.setText(error.message)

        self.api.json("POST", f"/api/libraries/{library_id}/storage", loaded, failed, {})

    def _refresh_library_health(self, library_id, attempts=1):
        if self._library != library_id:
            return

        def loaded(data):
            if self._library != library_id or not isinstance(data, list):
                return
            match = next((entry for entry in data if entry.get("id") == library_id), None)
            if match and (not match.get("storageUnavailable") or attempts == 1):
                self._libraries[library_id] = match
                self._library_controls()
            elif attempts > 1:
                QTimer.singleShot(1000, lambda: self._refresh_library_health(library_id, attempts - 1))

        self.api.json("GET", "/api/libraries", loaded, lambda _error: None)

    def _rescan_links(self):
        library_id = self._library
        self.api.json("POST", f"/api/finder/libraries/{library_id}/relink",
                      lambda _data: self.storage_notice.setText("Content Finder source scan started. Results are in the web Activity center.") if self._library == library_id else None,
                      lambda error: self.storage_notice.setText(error.message) if self._library == library_id else None, {})

    def _find_source(self):
        series = self._series

        def warning(error):
            if self._series is series:
                self.detail_notice.setText(error.message)

        def sources_loaded(data):
            if self._series is not series or not isinstance(data, list):
                return
            sources = {f"{source['name']} ({source['id']})": source['id'] for source in data
                       if source.get('id') and source.get('name') and not source.get('error') and not source.get('needsSetup')}
            if not sources:
                self.detail_notice.setText("No Content Finder sources are ready to search.")
                return
            source, accepted = QInputDialog.getItem(self, "Content Finder", "Source", list(sources), 0, False)
            if not accepted or self._series is not series:
                return
            title, accepted = QInputDialog.getText(self, "Content Finder", "Search title", text=text(series.get("name")))
            if accepted and title.strip() and self._series is series:
                from urllib.parse import quote
                self.api.json("GET", f"/api/finder/{quote(sources[source], safe='')}/search",
                              lambda found: choose(sources[source], found), warning, params={"q": title.strip()})

        def choose(plugin, data):
            if self._series is not series or not isinstance(data, dict):
                return
            candidates = [entry for entry in data.get("items", []) if entry.get("id") and not entry.get("folder")]
            if not candidates:
                self.detail_notice.setText("No entries found. Try another title or source.")
                return
            choices = {f"{index}. {entry.get('title')} · {entry.get('author') or 'Unknown author'}": entry['id']
                       for index, entry in enumerate(candidates, 1)}
            selected, accepted = QInputDialog.getItem(self, "Link Content Finder entry", "Choose the matching entry", list(choices), 0, False)
            if accepted and self._series is series:
                self.api.json("PUT", f"/api/finder/series/{series['id']}/source",
                              lambda result: self.detail_notice.setText(f"Source linked · {result.get('matchedFiles', 0)} local files matched") if self._series is series else None,
                              warning, {"plugin": plugin, "sourceId": choices[selected]})

        self.api.json("GET", "/api/finder/sources", sources_loaded, warning)

    def _navigation_changed(self, item: QListWidgetItem | None, _previous=None) -> None:
        if not item or not self.user:
            return
        self._mode, self._library = item.data(ROLE)
        self._library_controls()
        self.heading.setText(item.text())
        self.search.blockSignals(True)
        self.search.clear()
        self.search.blockSignals(False)
        self.refresh()

    def search_now(self, *_args) -> None:
        self.search_timer.stop()
        if not self.user:
            return
        if self._mode == "home":
            self._mode, self._library = "library", None
            self.sidebar.blockSignals(True)
            self.sidebar.setCurrentRow(1)
            self.sidebar.blockSignals(False)
            self.heading.setText("Library")
        self._load_series(True)

    def refresh(self) -> None:
        if not self.user:
            return
        if self._mode != "home":
            if self._library is not None:
                self._refresh_library_health(self._library)
            self._load_series(True)
            return
        self.heading.setText("Home")
        generation = self._begin_load()

        def loaded(data: object) -> None:
            if generation != self._generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("continueReading"), list) or not isinstance(data.get("recentlyAdded"), list):
                self._load_error(ApiError("The server returned an invalid home page."), generation)
                return
            self.notice.setText("Continue reading, followed by recently added series. Select an item for details.")
            records = [{"kind": "book", "data": book} for book in data["continueReading"] if isinstance(book, dict)]
            records += [{"kind": "series", "data": series} for series in data["recentlyAdded"] if isinstance(series, dict)]
            self._append_records(records, generation)
            self.count.setText(f"{len(records)} items")
            if not records:
                self.notice.setText("No books yet. Add a library on your Flyleaf server, then refresh.")
        self.api.json("GET", "/api/home", loaded, lambda error: self._load_error(error, generation))

    def return_from_reader(self, book_id):
        item = self.grid.currentItem()
        if item:
            self._selection_changed(item, preferred=book_id, volume_scroll=self.books.verticalScrollBar().value())
            self.books.setFocus()

    def _begin_load(self) -> int:
        self._generation += 1
        self._detail_generation += 1
        self._covers.clear()
        self._records.clear()
        self.grid.clear()
        self.books.clear()
        self.summary.clear()
        self.detail_title.setText("Choose a book or series")
        self.detail_meta.clear()
        self.detail_notice.clear()
        self._series = {}
        self.notice.setText("Loading your library…")
        self.count.clear()
        self.more_button.hide()
        return self._generation

    def _load_series(self, reset: bool) -> None:
        generation = self._begin_load() if reset else self._generation
        self.more_button.setEnabled(False)
        offset = len(self._records)
        params = {"library": self._library, "want": 1 if self._mode == "want" else None,
                  "q": self.search.text().strip(), "read": self.read_filter.currentData(),
                  "sort": self.sort.currentData(), "limit": 48, "offset": offset}

        def loaded(data: object) -> None:
            if generation != self._generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                self._load_error(ApiError("The server returned an invalid series list."), generation)
                return
            self._append_records([{"kind": "series", "data": item} for item in data["items"] if isinstance(item, dict)], generation)
            self._has_more = bool(data.get("hasMore"))
            self.more_button.setVisible(self._has_more)
            self.more_button.setEnabled(True)
            self.count.setText(f"{len(self._records)} series shown")
            self.notice.setText("" if self._records else "No matching series. Try another search or reading-state filter.")
        self.api.json("GET", "/api/series", loaded, lambda error: self._load_error(error, generation), params=params)

    def _load_error(self, error: ApiError, generation: int) -> None:
        if generation == self._generation:
            self.notice.setText(error.message + " Use Refresh to retry.")
            self.more_button.setEnabled(True)

    def _append_records(self, records: list[dict], generation: int) -> None:
        for record in records:
            data = record["data"]
            if not isinstance(data.get("id"), int):
                continue
            title = text(data.get("name") if record["kind"] == "series" else data.get("series"), text(data.get("title"), "Untitled"))
            subtitle = "Continue reading" if record["kind"] == "book" else text((data.get("authors") or [""])[0])
            item = QListWidgetItem(f"{title}\n{subtitle}")
            item.setData(ROLE, record)
            item.setToolTip(title)
            item.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_FileIcon))
            self.grid.addItem(item)
            self._records.append(record)
            if self._show_covers and data.get("coverUrl") and not data.get("blur"):
                self._covers.append((generation, item, data["coverUrl"]))
        self._pump_covers()

    def _pump_covers(self) -> None:
        while self._covers and self._cover_active < 4:
            generation, item, path = self._covers.popleft()
            if generation != self._generation:
                continue
            self._cover_active += 1

            def done(payload=None, *, token=generation, target=item, session=self._session) -> None:
                if session != self._session:
                    return
                self._cover_active -= 1
                if self._show_covers and token == self._generation and isinstance(payload, bytes):
                    try:
                        target.setIcon(QIcon(QPixmap.fromImage(decode_image(payload, thumbnail=True))))
                    except ValueError:
                        pass  # A cover failure must not hide a readable library item.
                self._pump_covers()
            self.api.image(path, done, lambda _error, callback=done: callback())

    def _selection_changed(self, item: QListWidgetItem | None, _previous=None, *, preferred=None, volume_scroll=None) -> None:
        self._detail_generation += 1
        token = self._detail_generation
        self.books.clear()
        self.summary.clear()
        self.detail_notice.clear()
        self._series = {}
        self.find_source.hide()
        if not item:
            self.read_button.setEnabled(False)
            self.finished_button.setEnabled(False)
            return
        record = item.data(ROLE)
        data = record["data"]
        self.detail_title.setText(text(data.get("name"), text(data.get("title"), "Untitled")))
        self.detail_meta.setText("Loading details…")
        series_id = data.get("seriesId") if record["kind"] == "book" else data.get("id")
        if not isinstance(series_id, int):
            self._show_books([data], data.get("id"))
            self.detail_meta.clear()
            return

        def loaded(series: object) -> None:
            if token != self._detail_generation:
                return
            if not isinstance(series, dict) or not isinstance(series.get("books"), list):
                self.detail_notice.setText("The server returned invalid series details.")
                return
            self._series = series
            self.detail_title.setText(text(series.get("name"), "Untitled"))
            authors = series.get("authors") or []
            self.detail_meta.setText(" · ".join([text(author) for author in authors[:3]] + [f"{len(series['books'])} items"]))
            self.summary.setPlainText(text(series.get("summary")))
            selected = preferred if preferred is not None else data.get("id") if record["kind"] == "book" else series.get("nextBookId")
            self._show_books(series["books"], selected)
            if volume_scroll is not None:
                self.books.verticalScrollBar().setValue(volume_scroll)
            self._library_controls()
        self.api.json("GET", f"/api/series/{series_id}", loaded,
                      lambda error: self.detail_notice.setText(error.message) if token == self._detail_generation else None)

    def _show_books(self, books: list[dict], selected: int | None) -> None:
        books = [book for book in books if isinstance(book, dict) and isinstance(book.get("id"), int)]
        frontier = 0
        for index, book in enumerate(books):
            progress = book.get("progress") or {}
            if progress.get("finished") or progress.get("percent", 0) > 0:
                frontier = max(frontier, index + int(bool(progress.get("finished"))))
        protect = bool((self.user.get("prefs") or {}).get("spoilerSafe"))
        self.books.clear()
        for index, book in enumerate(books):
            if not isinstance(book, dict):
                continue
            title = text(book.get("label"), text(book.get("title"), "Untitled"))
            progress = book.get("progress") or {}
            if protect and index > frontier:
                title = f"Item {index + 1} · Future title hidden"
            suffix = "Finished" if progress.get("finished") else f"{round((progress.get('percent') or 0) * 100)}% read"
            item = QListWidgetItem(f"{title}\n{text(book.get('format')).upper()} · {suffix}")
            item.setData(ROLE, book)
            self.books.addItem(item)
            if book.get("id") == selected:
                self.books.setCurrentItem(item)
        if self.books.currentRow() < 0 and self.books.count():
            self.books.setCurrentRow(0)

    def _book_selection_changed(self, item: QListWidgetItem | None, _previous=None) -> None:
        self.read_button.setEnabled(item is not None)
        self.finished_button.setEnabled(item is not None)
        if item:
            finished = bool((item.data(ROLE).get("progress") or {}).get("finished"))
            self.finished_button.setText("Mark as unread" if finished else "Mark as read")

    def _activate_item(self, item: QListWidgetItem) -> None:
        record = item.data(ROLE)
        if record["kind"] == "book":
            self.book_requested.emit(record["data"])
        elif self.books.count() == 1:
            self._read_selected()

    def _read_selected(self) -> None:
        item = self.books.currentItem()
        if item:
            self.book_requested.emit(item.data(ROLE))

    def _toggle_finished(self) -> None:
        item = self.books.currentItem()
        if not item:
            return
        book = item.data(ROLE)
        finished = not bool((book.get("progress") or {}).get("finished"))
        self.finished_button.setEnabled(False)
        token = self._detail_generation

        def saved(_data: object) -> None:
            if token != self._detail_generation:
                return
            book["progress"] = {**(book.get("progress") or {}), "finished": finished, "percent": 1 if finished else 0}
            item.setText(f"{item.text().splitlines()[0]}\n{text(book.get('format')).upper()} · {'Finished' if finished else '0% read'}")
            self._book_selection_changed(self.books.currentItem())
            self.detail_notice.setText("Saved to the server. Refresh to update the library's reading-state filter.")
        def failed(error: ApiError) -> None:
            if token == self._detail_generation:
                self.finished_button.setEnabled(True)
                self.detail_notice.setText(error.message)
        self.api.json("POST", f"/api/books/{book['id']}/finished", saved, failed, {"finished": finished})

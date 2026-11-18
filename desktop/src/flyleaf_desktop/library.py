from collections import deque

from PySide6.QtCore import QSize, Qt, QTimer, Signal
from PySide6.QtGui import QIcon, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView, QComboBox, QHBoxLayout, QLineEdit, QListView, QListWidget,
    QListWidgetItem, QPlainTextEdit, QPushButton, QSplitter, QStyle, QVBoxLayout, QWidget,
)

from .api import ApiError, FlyleafApi
from .widgets import CoverDelegate, decode_image, label, text

ROLE = Qt.ItemDataRole.UserRole


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
        self._records: list[dict] = []
        self._covers: deque = deque()
        self._cover_active = 0
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
        for title, value in [("Title A–Z", "name"), ("Title Z–A", "name_desc"), ("Author", "author"), ("Recently added", "added"), ("Last read", "read"), ("Recently updated", "updated")]:
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
        self._mode, self._library = "home", None
        session = self._session
        self.sidebar.blockSignals(True)
        for title, mode in [("Home", "home"), ("Library", "library"), ("Want to read", "want")]:
            item = QListWidgetItem(title)
            item.setData(ROLE, (mode, None))
            self.sidebar.addItem(item)
        self.sidebar.setCurrentRow(0)
        self.sidebar.blockSignals(False)
        self.api.json("GET", "/api/libraries", lambda data: self._libraries_loaded(data, session),
                      lambda error: self.notice.setText(error.message) if session == self._session else None)
        self.refresh()

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
            item.setData(ROLE, ("library", library["id"]))
            self.sidebar.addItem(item)
        self.sidebar.blockSignals(False)

    def _navigation_changed(self, item: QListWidgetItem | None, _previous=None) -> None:
        if not item or not self.user:
            return
        self._mode, self._library = item.data(ROLE)
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
            if data.get("coverUrl") and not data.get("blur"):
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
                if token == self._generation and isinstance(payload, bytes):
                    try:
                        target.setIcon(QIcon(QPixmap.fromImage(decode_image(payload, thumbnail=True))))
                    except ValueError:
                        pass  # A cover failure must not hide a readable library item.
                self._pump_covers()
            self.api.image(path, done, lambda _error, callback=done: callback())

    def _selection_changed(self, item: QListWidgetItem | None, _previous=None) -> None:
        self._detail_generation += 1
        token = self._detail_generation
        self.books.clear()
        self.summary.clear()
        self.detail_notice.clear()
        self._series = {}
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
            self._show_books(series["books"], data.get("id") if record["kind"] == "book" else series.get("nextBookId"))
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

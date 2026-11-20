from collections import deque

from PySide6.QtCore import QSize, Qt, QTimer, Signal, QUrl, QSignalBlocker
from PySide6.QtGui import QDesktopServices, QIcon, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView, QComboBox, QDialog, QHBoxLayout, QLineEdit, QListView, QListWidget, QMenu, QMessageBox, QToolButton,
    QListWidgetItem, QPlainTextEdit, QPushButton, QSplitter, QStyle, QVBoxLayout, QWidget, QFrame, QScrollArea, QStackedWidget,
)

from .api import ApiError, FlyleafApi
from .widgets import CoverDelegate, decode_image, label, text
from .catalog_tools import CatalogTools
from .reading_room import RoomHero, NavigationDelegate
from .material import symbol, ui_px
from .finder import FinderPage
from .home_layout import SECTIONS, ordered_home, records_for_home

ROLE = Qt.ItemDataRole.UserRole


class LibraryPage(QWidget):
    book_requested = Signal(dict)
    account_requested = Signal()
    personal_requested = Signal()

    def __init__(self, api: FlyleafApi, appearance=None, home_layout=lambda: {}):
        super().__init__()
        self.api = api
        self.appearance = appearance
        self.home_layout = home_layout
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
        self._restore = None
        self._revealed_titles = set()
        self._revealed_summaries = set()
        self._bulk_busy = False
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 16, 8)
        layout.setSpacing(12)
        self.rail = QWidget()
        self.rail.setFixedWidth(204)
        navigation = QVBoxLayout(self.rail)
        navigation.setContentsMargins(0, 10, 0, 8)
        self.nav_caption = label("YOUR SPACE")
        self.nav_caption.setObjectName("eyebrow")
        navigation.addWidget(self.nav_caption)
        self.sidebar = QListWidget()
        self.sidebar.setObjectName("libraryNavigation")
        self.sidebar.setAccessibleName("Library navigation")
        self.sidebar.setMinimumWidth(0)
        self.sidebar.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.sidebar.setItemDelegate(NavigationDelegate(self.sidebar))
        self.sidebar.setMouseTracking(True)
        self.sidebar.currentItemChanged.connect(self._navigation_changed)
        navigation.addWidget(self.sidebar, 1)
        self.account_button = QPushButton("My account")
        self.account_button.setIcon(symbol("person"))
        self.account_button.setAccessibleName("My account")
        self.account_button.setToolTip("Edit your account and password")
        self.account_button.setProperty("kind", "text")
        self.account_button.clicked.connect(self.account_requested)
        navigation.addWidget(self.account_button)
        layout.addWidget(self.rail)
        surface = QFrame()
        surface.setObjectName("librarySurface")
        body = QVBoxLayout(surface)
        body.setContentsMargins(24, 20, 24, 20)
        body.setSpacing(12)
        self.surface = surface
        self.content = QStackedWidget()
        self.content.addWidget(surface)
        self.finder = FinderPage(api)
        self.content.addWidget(self.finder)
        layout.addWidget(self.content, 1)
        self.heading = label("Home", heading=True)
        self.heading.setProperty("role", "title")
        body.addWidget(self.heading)
        self.hero = RoomHero()
        self.hero.browse_requested.connect(lambda: self.sidebar.setCurrentRow(1))
        toolbar = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setObjectName("librarySearch")
        self.search.setPlaceholderText("Search your library")
        self.search.setAccessibleName("Search your library")
        self.search.setClearButtonEnabled(True)
        search_row = QHBoxLayout()
        search_row.addWidget(self.search, 1)
        self.scope = QComboBox()
        self.scope.setAccessibleName("Search scope")
        self.scope.addItem("Catalog", "catalog")
        self.scope.addItem("Inside books", "fulltext")
        self.scope.currentIndexChanged.connect(self._scope_changed)
        search_row.addWidget(self.scope)
        self.filters_button = QPushButton("Filters")
        self.filters_button.setToolTip("Catalog filters and saved searches")
        self.filters_button.setIcon(symbol("filter"))
        search_row.addWidget(self.filters_button)
        body.addLayout(search_row)
        self.filter_dialog = QDialog(self)
        self.filter_dialog.setWindowTitle("Catalog filters and saved searches")
        self.filter_dialog.resize(580, 540)
        dialog_layout = QVBoxLayout(self.filter_dialog)
        self.tools = CatalogTools(self.api)
        dialog_layout.addWidget(self.tools)
        self.filters_button.clicked.connect(self.filter_dialog.show)
        self.tools.applied.connect(self.search_now)
        self.tools.selected_filter.connect(self._apply_saved_query)
        self.tools.save.clicked.connect(lambda: self.tools.save_query(self.query_params(draft=True)))
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
        self.refresh_button.setIcon(symbol("refresh"))
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
        splitter = self.splitter = QSplitter()
        self.grid = QListWidget()
        self.grid.setObjectName("seriesGrid")
        self.grid.setAccessibleName("Books and series")
        self.grid.setViewMode(QListView.ViewMode.IconMode)
        self.grid.setResizeMode(QListView.ResizeMode.Adjust)
        self.grid.setMovement(QListView.Movement.Static)
        self.grid.setIconSize(QSize(112, 160))
        self.grid.setGridSize(QSize(ui_px(184), ui_px(286)))
        self.grid.setItemDelegate(CoverDelegate(self.grid, appearance))
        self.grid.setSpacing(8)
        self.grid.setWordWrap(True)
        self.grid.setUniformItemSizes(True)
        self.grid.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.grid.currentItemChanged.connect(self._selection_changed)
        self.grid.itemActivated.connect(self._activate_item)
        shelf = QWidget()
        shelf_layout = QVBoxLayout(shelf)
        shelf_layout.setContentsMargins(0, 0, 0, 0)
        shelf_layout.setSpacing(16)
        shelf_layout.addWidget(self.hero)
        self.home_section = QComboBox()
        self.home_section.setAccessibleName("Home shelf")
        self.home_section.currentIndexChanged.connect(self.refresh)
        shelf_layout.addWidget(self.home_section)
        shelf_layout.addWidget(self.grid, 1)
        splitter.addWidget(shelf)
        detail = QFrame()
        detail.setObjectName("detailPanel")
        details = QVBoxLayout(detail)
        details.setContentsMargins(18, 18, 18, 18)
        details.setSpacing(10)
        detail_eyebrow = label("ON YOUR BOOKSHELF")
        detail_eyebrow.setObjectName("eyebrow")
        details.addWidget(detail_eyebrow)
        self.detail_title = label("Choose a book or series", heading=True, wrap=True)
        self.detail_title.setProperty("role", "title")
        details.addWidget(self.detail_title)
        self.detail_meta = label("", wrap=True)
        self.detail_meta.setProperty("role", "caption")
        details.addWidget(self.detail_meta)
        self.metadata_links = QToolButton()
        self.metadata_links.setText("Metadata links")
        self.metadata_links.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.metadata_links.setMenu(QMenu(self.metadata_links))
        self.metadata_links.setEnabled(False)
        details.addWidget(self.metadata_links)
        self.summary = QPlainTextEdit()
        self.summary.setObjectName("seriesSummary")
        self.summary.setReadOnly(True)
        self.summary.setAccessibleName("Series summary")
        self.summary.setMaximumHeight(95)
        details.addWidget(self.summary)
        self.reveal_summary = QPushButton("Reveal unread summary")
        self.reveal_summary.clicked.connect(self._reveal_summary)
        self.reveal_summary.hide()
        details.addWidget(self.reveal_summary)
        self.books = QListWidget()
        self.books.setObjectName("volumeList")
        self.books.setAccessibleName("Books and volumes in this series")
        self.books.currentItemChanged.connect(self._book_selection_changed)
        self.books.itemActivated.connect(lambda _item: self._read_selected())
        details.addWidget(self.books, 1)
        self.reveal_title = QPushButton("Reveal this future title")
        self.reveal_title.setAccessibleName("Deliberately reveal selected future volume title")
        self.reveal_title.clicked.connect(self._reveal_selected_title)
        self.reveal_title.hide()
        details.addWidget(self.reveal_title)
        self.read_button = QPushButton("Read / resume")
        self.read_button.setProperty("primary", True)
        self.read_button.setIcon(symbol("play", "onPrimary"))
        self.read_button.setObjectName("readBookButton")
        self.read_button.setEnabled(False)
        self.read_button.clicked.connect(self._read_selected)
        details.addWidget(self.read_button)
        self.finished_button = QPushButton("Mark as read")
        self.finished_button.setIcon(symbol("check"))
        self.finished_button.setEnabled(False)
        self.finished_button.clicked.connect(self._toggle_finished)
        details.addWidget(self.finished_button)
        self.personal_button = QPushButton("Organize / review…")
        self.personal_button.setEnabled(False)
        self.personal_button.clicked.connect(self.personal_requested)
        details.addWidget(self.personal_button)
        self.detail_notice = label("", wrap=True)
        details.addWidget(self.detail_notice)
        self.detail_scroll = QScrollArea()
        self.detail_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.detail_scroll.setWidgetResizable(True)
        self.detail_scroll.setMinimumWidth(240)
        self.detail_scroll.setMaximumWidth(350)
        self.detail_scroll.setWidget(detail)
        splitter.addWidget(self.detail_scroll)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([650, 380])
        body.addWidget(splitter, 1)
        bottom = QHBoxLayout()
        self.count = label("")
        bottom.addWidget(self.count)
        self.bulk_notice = label("", wrap=True)
        bottom.addWidget(self.bulk_notice, 1)
        bottom.addStretch()
        selection_menu = QToolButton()
        selection_menu.setText("Selected series")
        selection_menu.setToolTip("Select multiple series with Ctrl or Shift.")
        selection_menu.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        menu = QMenu(selection_menu)
        for title, finished in (("Mark selected series as read…", True), ("Mark selected series as unread…", False)):
            menu.addAction(title, lambda checked=False, value=finished: self.bulk_finished(value))
        selection_menu.setMenu(menu)
        bottom.addWidget(selection_menu)
        self.more_button = QPushButton("Load more")
        self.more_button.clicked.connect(lambda: self._load_series(False))
        self.more_button.hide()
        bottom.addWidget(self.more_button)
        body.addLayout(bottom)
        if appearance:
            appearance.changed.connect(self.sync_ui_scale)

    def sync_ui_scale(self):
        compact_home = self._mode == "home" and self.home_layout().get("compact") is True
        width, height, art_width, art_height = (148, 236, 90, 136) if compact_home else (184, 286, 112, 160)
        self.grid.setGridSize(QSize(ui_px(width), ui_px(height)))
        self.grid.setIconSize(QSize(ui_px(art_width), ui_px(art_height)))
        self.detail_scroll.setMinimumWidth(ui_px(240))
        self.detail_scroll.setMaximumWidth(ui_px(350))
        self.resizeEvent(None)

    def resizeEvent(self, event):
        if event is not None:
            super().resizeEvent(event)
        compact = self.width() < ui_px(1080)
        self.rail.setFixedWidth(ui_px(76 if compact else 204))
        self.nav_caption.setVisible(not compact)
        self.account_button.setText("" if compact else "My account")
        self.hero.setVisible(self._mode == "home" and self.home_layout().get("hero") is not False and self.height() >= ui_px(650))

    def start_session(self, user: dict, capabilities=None) -> None:
        self.clear_session()
        self.user = user
        self.tools.start_session(capabilities)
        self._mode, self._library = "home", None
        session = self._session
        self.sidebar.blockSignals(True)
        for title, mode in [("Home", "home"), ("Library", "library"), ("Want to read", "want")]:
            item = QListWidgetItem(title)
            item.setToolTip(title)
            item.setData(ROLE, (mode, None))
            self.sidebar.addItem(item)
        self.sidebar.setCurrentRow(0)
        if user.get("role") == "admin" or (user.get("permissions") or {}).get("contentFinder"):
            item = QListWidgetItem("Content Finder")
            item.setToolTip("Content Finder")
            item.setData(ROLE, ("finder", None))
            self.sidebar.addItem(item)
        self.sidebar.blockSignals(False)
        self.api.json("GET", "/api/libraries", lambda data: self._libraries_loaded(data, session),
                      lambda error: self.notice.setText(error.message) if session == self._session else None)
        self.refresh()

    def clear_session(self) -> None:
        self._revealed_titles.clear()
        self._revealed_summaries.clear()
        self._bulk_busy = False
        self.bulk_notice.clear()
        self.reveal_title.hide()
        self.reveal_summary.hide()
        with QSignalBlocker(self.home_section):
            self.home_section.clear()
        # Clearing navigation can emit a transient current-item change. Revoke
        # the account before any widget signals can start another request.
        self.user = {}
        self.finder.clear_session()
        self.content.setCurrentWidget(self.surface)
        self._session += 1
        self._generation += 1
        self._detail_generation += 1
        self._restore = None
        self.filter_dialog.hide()
        self.tools.clear_session()
        self.metadata_links.menu().clear()
        self.metadata_links.setEnabled(False)
        for combo in (self.scope, self.sort, self.read_filter):
            with QSignalBlocker(combo):
                combo.setCurrentIndex(0)
        for control in (self.filters_button, self.sort, self.read_filter):
            control.setEnabled(True)
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
            item.setToolTip(item.text())
            item.setData(ROLE, ("library", library["id"]))
            self.sidebar.addItem(item)
        self.sidebar.blockSignals(False)

    def _navigation_changed(self, item: QListWidgetItem | None, _previous=None) -> None:
        if not item or not self.user:
            return
        self._mode, self._library = item.data(ROLE)
        if self._mode == "finder":
            self.content.setCurrentWidget(self.finder)
            if not self.finder.user:
                self.finder.start_session(self.user)
            return
        self.content.setCurrentWidget(self.surface)
        self._restore = None
        self.heading.setText(item.text())
        self.search.blockSignals(True)
        self.search.clear()
        self.search.blockSignals(False)
        self.refresh()

    def search_now(self, *_args) -> None:
        self.search_timer.stop()
        if not self.user:
            return
        self.hero.hide()
        self.home_section.hide()
        self._restore = None
        if self._mode in ("home", "series"):
            self._mode, self._library = "library", None
            self.sidebar.blockSignals(True)
            self.sidebar.setCurrentRow(1)
            self.sidebar.blockSignals(False)
            self.heading.setText("Library")
        self._load_series(True)

    def _scope_changed(self):
        catalog = self.scope.currentData() == "catalog"
        for control in (self.filters_button, self.sort, self.read_filter):
            control.setEnabled(catalog)
        if not catalog:
            self.filter_dialog.hide()
        self.search_now()

    def query_params(self, *, draft=False):
        return {**(self.tools.values() if draft else self.tools.params), "library": self._library, "want": 1 if self._mode == "want" else None,
                "q": self.search.text().strip(), "read": self.read_filter.currentData(), "sort": self.sort.currentData()}

    def _apply_saved_query(self, query):
        self.hero.hide()
        self.home_section.hide()
        self._library = query.get("library")
        self._mode = "want" if query.get("want") else "library"
        with QSignalBlocker(self.search), QSignalBlocker(self.sort), QSignalBlocker(self.read_filter), QSignalBlocker(self.scope):
            self.scope.setCurrentIndex(0)
            self.search.setText(text(query.get("q")))
            self.sort.setCurrentIndex(max(0, self.sort.findData(query.get("sort", "name"))))
            self.read_filter.setCurrentIndex(max(0, self.read_filter.findData(query.get("read", ""))))
        self.heading.setText(self.tools.saved.currentText())
        self.search_timer.stop()
        self._restore = None
        self._load_series(True)

    def capture_state(self):
        item, volume = self.grid.currentItem(), self.books.currentItem()
        record = item.data(ROLE) if item else None
        return {"identity": (self.api.base, self.user.get("id")), "count": len(self._records),
                "selected": (record["kind"], record["data"]["id"]) if record else None,
                "volume": volume.data(ROLE)["id"] if volume else None,
                "gridScroll": self.grid.verticalScrollBar().value(), "bookScroll": self.books.verticalScrollBar().value(),
                "detailScroll": self.detail_scroll.verticalScrollBar().value(),
                "splitter": self.splitter.sizes()}

    def refresh_preserving(self, state=None):
        if state and state.get("identity") == (self.api.base, self.user.get("id")):
            self._restore = state
        self.refresh()

    def _restore_selection(self):
        state = self._restore
        if not state:
            return
        if self._has_more and len(self._records) < state["count"]:
            self._load_series(False)
            return
        self.splitter.setSizes(state["splitter"])
        for row, record in enumerate(self._records):
            if (record["kind"], record["data"]["id"]) == state["selected"]:
                self.grid.setCurrentRow(row)
                return
        self._restore_scroll()

    def _restore_scroll(self):
        state = self._restore
        if not state:
            return
        generation = self._generation
        def restore():
            if generation == self._generation and self._restore is state:
                self.grid.doItemsLayout()
                self.grid.verticalScrollBar().setValue(state["gridScroll"])
                self.books.verticalScrollBar().setValue(state["bookScroll"])
                self.detail_scroll.verticalScrollBar().setValue(state.get("detailScroll", 0))
                self._restore = None
        QTimer.singleShot(0, restore)

    def refresh(self) -> None:
        if not self.user:
            return
        self.sync_ui_scale()
        self.home_section.setVisible(self._mode == "home")
        if self._mode == "finder":
            self.finder.refresh_sources()
            return
        if self._mode == "series":
            series_id = self._library
            generation = self._begin_load()
            def loaded(data):
                if generation != self._generation:
                    return
                if not isinstance(data, dict) or data.get("id") != series_id:
                    self._load_error(ApiError("The server returned invalid series details."), generation)
                    return
                self.heading.setText(text(data.get("name"), "Series"))
                self.notice.clear()
                self._append_records([{"kind": "series", "data": data}], generation)
                self.grid.setCurrentRow(0)
            self.api.json("GET", f"/api/series/{series_id}", loaded, lambda error: self._load_error(error, generation))
            return
        if self._mode != "home":
            self._load_series(True)
            return
        self.heading.setText("Welcome back, " + text(self.user.get("displayName"), text(self.user.get("username"), "reader")))
        home = self.home_layout()
        with QSignalBlocker(self.home_section):
            selected = self.home_section.currentData()
            self.home_section.clear()
            self.home_section.addItem("All Home shelves", None)
            hidden = home.get("hidden") if isinstance(home.get("hidden"), list) else []
            for key in ordered_home(home):
                if key in SECTIONS and key not in hidden:
                    self.home_section.addItem(SECTIONS[key][0], key)
            self.home_section.setCurrentIndex(max(0, self.home_section.findData(selected)))
        generation = self._begin_load()

        def loaded(data: object) -> None:
            if generation != self._generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("continueReading"), list) or not isinstance(data.get("recentlyAdded"), list):
                self._load_error(ApiError("The server returned an invalid home page."), generation)
                return
            self.notice.setText("Select an item for details.")
            records = records_for_home(data, home, self.home_section.currentData())
            self._append_records(records, generation)
            self.count.setText(f"{len(records)} items")
            if not records:
                self.notice.setText("No books in this Home selection.")
            self._has_more = False
            self._restore_selection()
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

    @property
    def selected_series(self):
        return self._series

    def inspect_series(self, series):
        if not self.user or type(series.get("id")) is not int:
            return
        with QSignalBlocker(self.sidebar), QSignalBlocker(self.search):
            self.sidebar.setCurrentRow(1)
            self.search.clear()
        self.content.setCurrentWidget(self.surface)
        self._mode, self._library = "series", series["id"]
        self._has_more = False
        self._restore = None
        self.refresh()

    def bulk_finished(self, finished):
        if not self.user or self._bulk_busy:
            return
        ids = [item.data(ROLE)["data"]["id"] for item in self.grid.selectedItems() if item.data(ROLE)["kind"] == "series"]
        if not ids:
            self.bulk_notice.setText("Select one or more series from the catalog.")
            return
        session = self._session
        state = "read" if finished else "unread"
        if QMessageBox.question(self, "Update reading state", f"Mark all books in {len(ids)} selected series as {state}?") != QMessageBox.StandardButton.Yes or session != self._session:
            return
        self._bulk_busy = True
        self.bulk_notice.setText("Updating selected series…")
        pending = deque(ids)
        failed = []
        def send_next():
            if session != self._session:
                return
            if not pending:
                self._bulk_busy = False
                self.bulk_notice.setText(f"{len(ids) - len(failed)} series updated." + (f" {len(failed)} failed. {failed[0]}" if failed else ""))
                self.refresh_preserving(self.capture_state())
                return
            def done(_data):
                QTimer.singleShot(0, send_next)
            def failure(error):
                failed.append(error.message)
                QTimer.singleShot(0, send_next)
            self.api.json("POST", f"/api/series/{pending.popleft()}/finished", done, failure, {"finished": finished})
        send_next()

    def _load_series(self, reset: bool) -> None:
        if self.scope.currentData() == "fulltext":
            self._load_fulltext()
            return
        generation = self._begin_load() if reset else self._generation
        self.more_button.setEnabled(False)
        offset = len(self._records)
        params = {**self.query_params(), "limit": 48, "offset": offset}

        def loaded(data: object) -> None:
            if generation != self._generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                self._load_error(ApiError("The server returned an invalid series list."), generation)
                return
            self._append_records([{"kind": "series", "data": item} for item in data["items"] if isinstance(item, dict)], generation)
            self._has_more = bool(data.get("hasMore")) and bool(data["items"])
            self.more_button.setVisible(self._has_more)
            self.more_button.setEnabled(True)
            self.count.setText(f"{len(self._records)} series shown")
            self.notice.setText("" if self._records else "No matching series. Try another search or reading-state filter.")
            self._restore_selection()
        self.api.json("GET", "/api/series", loaded, lambda error: self._load_error(error, generation), params=params)

    def _load_fulltext(self):
        generation = self._begin_load()
        self._has_more = False
        query = self.search.text().strip()
        if not query:
            self.notice.setText("Search inside indexed book text. Catalog filters do not apply to this search.")
            return
        def loaded(data):
            if generation != self._generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                self._load_error(ApiError("The server returned invalid full-text search results."), generation)
                return
            records = [{"kind": "book", "data": entry["book"], "hits": entry.get("hits", []), "subtitle": "Text matches"}
                       for entry in data["results"] if isinstance(entry, dict) and isinstance(entry.get("book"), dict)]
            self._append_records(records, generation)
            self.count.setText(f"{len(records)} books with matching text (up to 50)")
            self.notice.setText("Select a book for matching passages. This search covers only text indexed by the server; opening uses the format's available reader." if records else "No indexed text matches. The server may still be indexing, or this format may not contain searchable text.")
            self._restore_selection()
        self.api.json("GET", "/api/fulltext", loaded, lambda error: self._load_error(error, generation), params={"q": query, "limit": 50})

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
            subtitle = record.get("subtitle", "Continue reading") if record["kind"] == "book" else text((data.get("authors") or [""])[0])
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
        self.personal_button.setEnabled(False)
        self.reveal_summary.hide()
        self.detail_scroll.verticalScrollBar().setValue(0)
        self._detail_generation += 1
        token = self._detail_generation
        self.books.clear()
        self.summary.clear()
        self.detail_notice.clear()
        self._series = {}
        self.metadata_links.menu().clear()
        self.metadata_links.setEnabled(False)
        if not item:
            self.read_button.setEnabled(False)
            self.finished_button.setEnabled(False)
            return
        record = item.data(ROLE)
        if self._restore and (record["kind"], record["data"]["id"]) != self._restore["selected"]:
            # Qt may select the first row as a refreshed batch becomes visible.
            # Wait for the captured item instead of replacing its saved volume.
            return
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
            self.personal_button.setEnabled(True)
            self.detail_title.setText(text(series.get("name"), "Untitled"))
            authors = series.get("authors") or []
            self.detail_meta.setText(" · ".join([text(author) for author in authors[:3]] + [f"{len(series['books'])} items"]))
            snippets = [text(hit.get("snippet")).replace("\x01", "").replace("\x02", "") for hit in record.get("hits", []) if isinstance(hit, dict)]
            prefs = self.user.get("prefs") or {}
            hidden = (prefs.get("spoilerSafe") or prefs.get("blurUnreadSummaries")) and not series.get("progress") and not series.get("readCount")
            hidden = hidden and series_id not in self._revealed_summaries
            self.reveal_summary.setVisible(bool(hidden and (series.get("summary") or snippets)))
            if hidden:
                self.summary.clear()
            elif snippets:
                self.summary.setPlainText("Matching passages\n\n" + "\n\n".join(snippets))
            else:
                self.summary.setPlainText(text(series.get("summary")))
            self._set_metadata_links(series.get("links", []))
            self._show_books(series["books"], data.get("id") if record["kind"] == "book" else series.get("nextBookId"))
        self.api.json("GET", f"/api/series/{series_id}", loaded,
                      lambda error: self.detail_notice.setText(error.message) if token == self._detail_generation else None)

    def _reveal_summary(self):
        if self._series.get("id"):
            self._revealed_summaries.add(self._series["id"])
            self.reveal_summary.hide()
            self.summary.setPlainText(text(self._series.get("summary")))

    def _show_books(self, books: list[dict], selected: int | None) -> None:
        if self._restore and any(book.get("id") == self._restore["volume"] for book in books if isinstance(book, dict)):
            selected = self._restore["volume"]
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
            hidden = protect and index > frontier and book["id"] not in self._revealed_titles
            if hidden:
                title = f"Item {index + 1} · Future title hidden"
            suffix = "Finished" if progress.get("finished") else f"{round((progress.get('percent') or 0) * 100)}% read"
            item = QListWidgetItem(f"{title}\n{text(book.get('format')).upper()} · {suffix}")
            item.setData(ROLE, book)
            item.setData(int(ROLE) + 1, hidden)
            self.books.addItem(item)
            if book.get("id") == selected:
                self.books.setCurrentItem(item)
        if self.books.currentRow() < 0 and self.books.count():
            self.books.setCurrentRow(0)
        self._restore_scroll()

    def _set_metadata_links(self, links):
        menu = self.metadata_links.menu()
        menu.clear()
        for entry in links if isinstance(links, list) else []:
            if not isinstance(entry, dict):
                continue
            url = QUrl(text(entry.get("url")))
            if url.scheme() not in ("http", "https") or not url.host() or url.userInfo():
                continue
            action = menu.addAction(text(entry.get("label"), text(entry.get("type"), url.host())))
            action.setToolTip(url.toString())
            action.triggered.connect(lambda checked=False, target=QUrl(url): QDesktopServices.openUrl(target))
        self.metadata_links.setEnabled(not menu.isEmpty())

    def _book_selection_changed(self, item: QListWidgetItem | None, _previous=None) -> None:
        self.reveal_title.setVisible(bool(item and item.data(int(ROLE) + 1)))
        self.read_button.setEnabled(item is not None)
        self.finished_button.setEnabled(item is not None)
        if item:
            finished = bool((item.data(ROLE).get("progress") or {}).get("finished"))
            self.finished_button.setText("Mark as unread" if finished else "Mark as read")

    def _reveal_selected_title(self):
        item = self.books.currentItem()
        if not item or not item.data(int(ROLE) + 1):
            return
        book = item.data(ROLE)
        self._revealed_titles.add(book["id"])
        title = text(book.get("label"), text(book.get("title"), "Untitled"))
        progress = book.get("progress") or {}
        suffix = "Finished" if progress.get("finished") else f"{round((progress.get('percent') or 0) * 100)}% read"
        item.setText(f"{title}\n{text(book.get('format')).upper()} · {suffix}")
        item.setData(int(ROLE) + 1, False)
        self.reveal_title.hide()

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

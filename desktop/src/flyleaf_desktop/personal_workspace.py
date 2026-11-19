"""Account-scoped native organization and personal reading workspace."""
from datetime import datetime
from PySide6.QtCore import Qt, Signal, QDate, QSaveFile, QIODevice
from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QFormLayout,
    QTabWidget, QListWidget, QListWidgetItem, QPushButton, QComboBox, QLineEdit,
    QPlainTextEdit, QSpinBox, QDoubleSpinBox, QDateEdit, QCheckBox, QMessageBox,
    QFileDialog, QSplitter, QScrollArea)
from .widgets import label, text

ROLE = Qt.ItemDataRole.UserRole


def button(layout, caption, callback):
    control = QPushButton(caption); control.clicked.connect(callback)
    layout.addWidget(control)
    return control


def fill(listing, rows, caption):
    previous = listing.currentItem().data(ROLE) if listing.currentItem() else {}
    listing.blockSignals(True); listing.clear()
    selected = None
    for row in rows:
        if not isinstance(row, dict): continue
        item = QListWidgetItem(caption(row)); item.setData(ROLE, row); listing.addItem(item)
        if previous and row.get('id') == previous.get('id'): selected = item
    if selected: listing.setCurrentItem(selected)
    listing.blockSignals(False)


def current(listing):
    return listing.currentItem().data(ROLE) if listing.currentItem() else None


class PersonalPanel(QWidget):
    book_requested = Signal(dict)
    series_requested = Signal(dict)

    def __init__(self, api):
        super().__init__()
        self.api = api; self.user = None; self.epoch = 0; self.requests = {}
        self.series = {}; self.book = {}; self.busy = False
        self.outer = QVBoxLayout(self)
        self.notice = label('', wrap=True); self.outer.addWidget(self.notice)
        self.body = QWidget(); self.layout = QVBoxLayout(self.body)
        self.layout.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea(); scroll.setWidgetResizable(True); scroll.setWidget(self.body)
        self.outer.addWidget(scroll, 1)

    def start_session(self, user):
        self.clear_session(); self.user = user

    def clear_session(self):
        self.epoch += 1; self.requests.clear(); self.user = None
        self.series = {}; self.book = {}; self.busy = False
        self.body.setEnabled(True); self.notice.clear()
        for widget in self.body.findChildren(QListWidget): widget.clear()
        for widget in self.body.findChildren(QPlainTextEdit): widget.clear()
        for widget in self.body.findChildren(QLineEdit): widget.clear()

    def request(self, method, path, done, body=None, params=None, key='load'):
        if not self.user: return
        if method != 'GET' and self.busy: return
        token = self.requests.get(key, 0) + 1; self.requests[key] = token
        epoch = self.epoch
        writing = method != 'GET'
        if writing: self.busy = True; self.body.setEnabled(False)
        self.notice.setText('Saving…' if writing else 'Loading…')
        def valid(): return epoch == self.epoch and self.requests.get(key) == token
        def success(data):
            if not valid(): return
            if writing: self.busy = False; self.body.setEnabled(True)
            self.notice.clear(); done(data)
        def failure(error):
            if not valid(): return
            if writing: self.busy = False; self.body.setEnabled(True)
            self.notice.setText(error.message)
        self.api.json(method, path, success, failure, body, params=params)

    def context(self, series, book): self.series = series or {}; self.book = book or {}


class OrganizationPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        row = QHBoxLayout()
        self.kind = QComboBox(); self.kind.addItem('Collections', 'collections'); self.kind.addItem('Reading lists', 'reading-lists')
        self.kind.currentIndexChanged.connect(self.reload)
        row.addWidget(self.kind); button(row, 'Refresh', self.reload)
        self.layout.addLayout(row)
        self.shelves = QListWidget(); self.shelves.setAccessibleName('Collections and reading lists')
        self.shelves.currentItemChanged.connect(self.select)
        self.layout.addWidget(self.shelves, 1)
        form = QFormLayout()
        self.name = QLineEdit(); self.name.setMaxLength(80); form.addRow('Name', self.name)
        self.description = QLineEdit(); self.description.setMaxLength(2000); form.addRow('Description', self.description)
        self.layout.addLayout(form)
        row = QHBoxLayout()
        button(row, 'Create new', self.create)
        self.save = button(row, 'Save changes', self.save_shelf)
        self.delete = button(row, 'Delete', self.delete_shelf)
        self.layout.addLayout(row)
        self.context_label = label('Select a series or volume in Library to add it here.', wrap=True)
        self.layout.addWidget(self.context_label)
        self.add = button(self.layout, 'Add selected series / volume', self.add_context)
        self.items = QListWidget(); self.items.setAccessibleName('Shelf contents')
        self.items.itemActivated.connect(self.open_item)
        self.layout.addWidget(self.items, 1)
        row = QHBoxLayout()
        self.remove = button(row, 'Remove selected item', self.remove_item)
        self.up = button(row, 'Move up', lambda: self.move(-1))
        self.down = button(row, 'Move down', lambda: self.move(1))
        self.layout.addLayout(row)
        self.detail = None; self.select()

    def clear_session(self):
        super().clear_session(); self.detail = None
        if hasattr(self, 'shelves'): self.select(); self.context({}, {})

    def endpoint(self): return '/api/' + self.kind.currentData()

    def reload(self, *_args):
        self.requests['detail'] = self.requests.get('detail', 0) + 1
        self.detail = None; self.items.clear(); self.select()
        self.request('GET', self.endpoint(), self.loaded)

    def loaded(self, rows):
        if not isinstance(rows, list): self.notice.setText('The server returned invalid shelves.'); return
        fill(self.shelves, rows, lambda row: text(row.get('name'), 'Untitled') + f" · {row.get('count', 0)} items" + ('' if row.get('owned') else ' · Shared'))
        self.select()

    def context(self, series, book):
        super().context(series, book)
        self.context_label.setText('Selected: ' + text(series.get('name'), 'No series selected') + (' · selected volume available' if book else ''))
        self.select_controls()

    def select(self, *_args):
        self.detail = None; self.items.clear()
        self.requests['detail'] = self.requests.get('detail', 0) + 1
        row = current(self.shelves)
        self.name.setText(text(row.get('name')) if row else '')
        self.description.setText(text(row.get('summary')) if row else '')
        self.select_controls()
        if not row: return
        endpoint = self.endpoint()
        def loaded(data):
            if not isinstance(data, dict): self.notice.setText('Invalid shelf details.'); return
            self.detail = data
            if endpoint.endswith('reading-lists'):
                fill(self.items, data.get('books', []), lambda book: text(book.get('label'), text(book.get('title'), 'Untitled')))
                self.select_controls()
            else:
                # Fetch visible series through the permission-filtered catalog endpoint.
                self.request('GET', '/api/series', lambda rows: self.collection_items(rows), params={'collection': data['id'], 'limit': 200}, key='contents')
        self.request('GET', endpoint + '/' + str(row['id']), loaded, key='detail')

    def collection_items(self, data):
        if isinstance(data, dict): fill(self.items, data.get('items', []), lambda row: text(row.get('name'), 'Untitled'))
        self.select_controls()
        if isinstance(data, dict) and data.get('hasMore'): self.notice.setText('Showing the first 200 series. Use Library filters to browse the full collection.')

    def select_controls(self):
        row = current(self.shelves) or {}
        owned = bool(row.get('owned'))
        for control in (self.save, self.delete, self.remove): control.setEnabled(owned)
        self.name.setReadOnly(bool(row) and not owned); self.description.setReadOnly(bool(row) and not owned)
        self.add.setEnabled(owned and bool(self.series.get('id')))
        for control in (self.up, self.down): control.setEnabled(owned and self.kind.currentData() == 'reading-lists')

    def create(self):
        if not self.name.text().strip(): self.notice.setText('Give the new shelf a name.'); return
        self.request('POST', self.endpoint(), lambda _data: self.reload(), {'name': self.name.text().strip(), 'summary': self.description.text()}, key='write')

    def save_shelf(self):
        row = current(self.shelves)
        if row and row.get('owned') and self.name.text().strip():
            self.request('PATCH', self.endpoint() + '/' + str(row['id']), lambda _data: self.reload(), {'name': self.name.text().strip(), 'summary': self.description.text()}, key='write')

    def delete_shelf(self):
        row = current(self.shelves)
        if row and row.get('owned') and QMessageBox.question(self, 'Delete shelf', 'Delete this shelf? Books stay in your library.') == QMessageBox.StandardButton.Yes:
            self.request('DELETE', self.endpoint() + '/' + str(row['id']), lambda _data: self.reload(), key='write')

    def add_context(self):
        row = current(self.shelves)
        if not row or not row.get('owned') or not self.series.get('id'): return
        body = {'seriesIds': [self.series['id']]} if self.kind.currentData() == 'collections' else ({'bookIds': [self.book['id']]} if self.book else {'seriesId': self.series['id']})
        self.request('POST', self.endpoint() + f"/{row['id']}/items", lambda _data: self.select(), body, key='write')

    def remove_item(self):
        row, item = current(self.shelves), current(self.items)
        if row and row.get('owned') and item:
            self.request('DELETE', self.endpoint() + f"/{row['id']}/items/{item['id']}", lambda _data: self.select(), key='write')

    def move(self, delta):
        row = current(self.shelves); index = self.items.currentRow(); target = index + delta
        if not row or not row.get('owned') or self.kind.currentData() != 'reading-lists' or index < 0 or not 0 <= target < self.items.count(): return
        ids = [self.items.item(i).data(ROLE)['id'] for i in range(self.items.count())]
        ids[index], ids[target] = ids[target], ids[index]
        self.request('PATCH', self.endpoint() + f"/{row['id']}", lambda _data: self.select(), {'order': ids}, key='write')

    def open_item(self, item):
        (self.book_requested if self.kind.currentData() == 'reading-lists' else self.series_requested).emit(item.data(ROLE))


class TonightPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        self.layout.addWidget(label('What can I finish tonight?', heading=True))
        form = QFormLayout()
        self.minutes = QSpinBox(); self.minutes.setRange(5, 240); self.minutes.setValue(30); self.minutes.setSuffix(' min')
        self.kind = QComboBox()
        for caption, value in [('All formats', ''), ('Ebooks', 'text'), ('Comics', 'comic'), ('PDF', 'pdf'), ('Audiobooks', 'audio')]: self.kind.addItem(caption, value)
        self.speed = QDoubleSpinBox(); self.speed.setRange(.5, 3); self.speed.setValue(1); self.speed.setSingleStep(.25); self.speed.setSuffix('×')
        form.addRow('Available time', self.minutes); form.addRow('Format', self.kind); form.addRow('Listening speed', self.speed)
        self.layout.addLayout(form); button(self.layout, 'Find a read', self.reload)
        self.items = QListWidget(); self.items.setAccessibleName('Books that fit tonight')
        self.items.itemActivated.connect(lambda item: self.book_requested.emit(item.data(ROLE)['book']))
        self.layout.addWidget(self.items, 1)
        self.layout.addWidget(label('Estimates use remaining progress, known audio duration, indexed text or pages. Your measured pace is used when enough history exists; unknown estimates are omitted. Only the next unread volume is offered.', wrap=True))

    def reload(self):
        def loaded(data):
            if not isinstance(data, dict): self.notice.setText('Invalid reading estimates.'); return
            fill(self.items, data.get('items', []), lambda row: text(row.get('book', {}).get('title'), 'Untitled') + f"\n{max(1, round(row.get('seconds', 0) / 60))} min · " + {'duration': 'Known audio duration', 'personal': 'Your measured reading pace', 'typical': 'Typical reading pace'}.get(row.get('basis'), 'Estimate'))
            self.notice.setText(f"{self.items.count()} matches · {data.get('unknown', 0)} books have no reliable estimate. Open a result to read.")
        self.request('GET', '/api/reading/tonight', loaded, params={'minutes': self.minutes.value(), 'kind': self.kind.currentData(), 'speed': self.speed.value()})


class JournalPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        self.entry = None; self.snapshot = {}; self.dirty = False
        self.month = QDateEdit(QDate.currentDate()); self.month.setDisplayFormat('MMMM yyyy'); self.month.setCalendarPopup(True)
        row = QHBoxLayout(); row.addWidget(self.month); button(row, 'Load month', self.reload); button(row, 'Export Markdown', self.export)
        self.layout.addLayout(row)
        self.items = QListWidget(); self.items.setAccessibleName('Private journal reflections')
        self.items.currentItemChanged.connect(self.select)
        self.layout.addWidget(self.items, 1)
        self.day = QDateEdit(QDate.currentDate()); self.day.setCalendarPopup(True)
        self.mood = QComboBox(); self.mood.addItem('No mood', None)
        for mood in ('reflective', 'delighted', 'curious', 'moved', 'challenged', 'disappointed'): self.mood.addItem(mood.capitalize(), mood)
        self.link_book = QCheckBox('Link to the selected volume')
        form = QFormLayout(); form.addRow('Date', self.day); form.addRow('Mood', self.mood); form.addRow(self.link_book)
        self.layout.addLayout(form)
        self.reflection = QPlainTextEdit(); self.reflection.setAccessibleName('Private reflection'); self.reflection.setPlaceholderText('What stayed with you? Up to 10,000 characters.')
        self.layout.addWidget(self.reflection, 1)
        for signal in (self.reflection.textChanged, self.day.dateChanged, self.mood.currentIndexChanged, self.link_book.toggled): signal.connect(self.changed)
        row = QHBoxLayout(); button(row, 'New reflection', self.new); button(row, 'Save reflection', self.save); button(row, 'Delete reflection', self.delete)
        self.layout.addLayout(row)
        self.reading = QPlainTextEdit(); self.reading.setReadOnly(True); self.reading.setAccessibleName('Reading days and highlights'); self.reading.setMaximumHeight(150)
        self.layout.addWidget(self.reading)

    def changed(self, *_args): self.dirty = True

    def discard(self):
        return not self.dirty or QMessageBox.question(self, 'Unsaved reflection', 'Discard your unsaved reflection?') == QMessageBox.StandardButton.Yes

    def clear_session(self):
        super().clear_session(); self.entry = None; self.snapshot = {}; self.dirty = False
        if hasattr(self, 'link_book'): self.link_book.setChecked(False); self.mood.setCurrentIndex(0); self.dirty = False

    def reload(self):
        if not self.discard(): return
        date = self.month.date(); start = datetime(date.year(), date.month(), 1)
        end = datetime(date.year() + (date.month() == 12), date.month() % 12 + 1, 1)
        def loaded(data):
            if not isinstance(data, dict): self.notice.setText('Invalid journal response.'); return
            self.snapshot = data; self.entry = None
            fill(self.items, data.get('entries', []), lambda row: text(row.get('day')) + ' · ' + text(row.get('mood'), 'Reflection') + '\n' + text(row.get('body'))[:150])
            lines = [f"{row.get('day')}: {round(row.get('seconds', 0) / 60)} min · {row.get('pages', 0)} pages" for row in data.get('reading', []) if isinstance(row, dict)]
            lines += ['Highlight: ' + text(row.get('text')) for row in data.get('highlights', []) if isinstance(row, dict)]
            self.reading.setPlainText('\n'.join(lines)); self.reflection.clear(); self.dirty = False
            self.notice.setText(f"{len(data.get('entries', []))} reflections · {len(data.get('reading', []))} reading records")
        self.request('GET', '/api/journal', loaded, params={'month': start.strftime('%Y-%m'), 'from': round(start.timestamp() * 1000), 'until': round(end.timestamp() * 1000)})

    def select(self, item, _previous=None):
        if not item or not self.discard(): return
        row = item.data(ROLE); self.entry = row
        self.day.setDate(QDate.fromString(row['day'], 'yyyy-MM-dd'))
        self.mood.setCurrentIndex(max(0, self.mood.findData(row.get('mood'))))
        self.link_book.setChecked(bool(row.get('book')))
        self.reflection.setPlainText(text(row.get('body'))); self.dirty = False

    def new(self):
        if not self.discard(): return
        self.entry = None; self.items.clearSelection(); self.reflection.clear(); self.day.setDate(QDate.currentDate()); self.mood.setCurrentIndex(0); self.link_book.setChecked(False); self.dirty = False

    def save(self):
        content = self.reflection.toPlainText()
        if not content.strip() or len(content) > 10000: self.notice.setText('Write a reflection of 1–10,000 characters.'); return
        linked = (self.entry or {}).get('book') or self.book
        if self.link_book.isChecked() and not linked: self.notice.setText('Select a volume in Library first.'); return
        body = {'day': self.day.date().toString('yyyy-MM-dd'), 'mood': self.mood.currentData(), 'body': content, 'bookId': linked.get('id') if self.link_book.isChecked() else None}
        def saved(_data): self.dirty = False; self.reload()
        self.request('PUT' if self.entry else 'POST', '/api/journal' + (f"/{self.entry['id']}" if self.entry else ''), saved, body, key='write')

    def delete(self):
        if self.entry and QMessageBox.question(self, 'Delete reflection', 'Permanently delete this private reflection?') == QMessageBox.StandardButton.Yes:
            def deleted(_data): self.dirty = False; self.reload()
            self.request('DELETE', f"/api/journal/{self.entry['id']}", deleted, key='write')

    def markdown(self):
        lines = ['# Reading journal — ' + text(self.snapshot.get('month')), '']
        for row in self.snapshot.get('entries', []):
            lines += ['## ' + text(row.get('day')), text(row.get('mood')), text(row.get('body')), '']
        lines += ['## Reading days', '']
        for row in self.snapshot.get('reading', []): lines.append(f"- {row.get('day')}: {round(row.get('seconds', 0) / 60)} minutes, {row.get('pages', 0)} pages")
        lines += ['', '## Highlights', '']
        for row in self.snapshot.get('highlights', []): lines += [text(row.get('text')), text(row.get('note')), '']
        return '\n'.join(lines)

    def export(self):
        if not self.snapshot: self.notice.setText('Load a month first.'); return
        path, _filter = QFileDialog.getSaveFileName(self, 'Export private journal', 'flyleaf-journal.md', 'Markdown (*.md)')
        if not path: return
        file = QSaveFile(path); data = self.markdown().encode('utf-8')
        if not file.open(QIODevice.OpenModeFlag.WriteOnly) or file.write(data) != len(data) or not file.commit(): self.notice.setText('Could not save the journal export.')


class SeriesPersonalPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        self.title = label('Select a series in Library first.', heading=True, wrap=True); self.layout.addWidget(self.title)
        self.status = QComboBox(); self.status.addItem('No status', None)
        for caption, value in [('Reading', 'reading'), ('Completed', 'completed'), ('On hold', 'on_hold'), ('Dropped', 'dropped'), ('Plan to read', 'plan')]: self.status.addItem(caption, value)
        self.tags = QLineEdit(); self.tags.setMaxLength(1200); self.tags.setPlaceholderText('Separate personal tags with commas')
        self.want = QCheckBox('Want to read')
        form = QFormLayout(); form.addRow('Reading status', self.status); form.addRow('Personal tags', self.tags); form.addRow(self.want)
        self.layout.addLayout(form); button(self.layout, 'Save personal state', self.save_state)
        self.layout.addWidget(label('Your rating and review', heading=True))
        self.rating = QComboBox(); self.rating.addItem('No rating', None)
        for rating in range(1, 11): self.rating.addItem(f'{rating / 2:g} stars', rating)
        self.layout.addWidget(self.rating)
        self.review = QPlainTextEdit(); self.review.setAccessibleName('Your series review (visible to other readers)'); self.review.setPlaceholderText('Your review is visible to other readers. Up to 5,000 characters.')
        self.layout.addWidget(self.review, 1)
        self.spoiler = QCheckBox('This review contains spoilers'); self.layout.addWidget(self.spoiler)
        row = QHBoxLayout(); button(row, 'Publish / update review', self.save_review); button(row, 'Delete my review', self.delete_review); self.layout.addLayout(row)
        self.other_reviews = QPlainTextEdit(); self.other_reviews.setReadOnly(True); self.other_reviews.setAccessibleName('Reader reviews with spoilers hidden'); self.layout.addWidget(self.other_reviews, 1)

    def clear_session(self):
        super().clear_session()
        if hasattr(self, 'title'):
            self.title.setText('Select a series in Library first.'); self.status.setCurrentIndex(0); self.rating.setCurrentIndex(0); self.spoiler.setChecked(False); self.want.setChecked(False)

    def context(self, series, book):
        super().context(series, book)
        self.requests.clear()
        self.title.setText(text(series.get('name'), 'Select a series in Library first.'))
        self.status.setCurrentIndex(max(0, self.status.findData(series.get('userStatus'))))
        self.tags.setText(', '.join(series.get('userTags') or [])); self.want.setChecked(bool(series.get('wantToRead')))
        self.review.clear(); self.other_reviews.clear(); self.rating.setCurrentIndex(0); self.spoiler.setChecked(False)

    def reload(self):
        if self.series.get('id'): self.request('GET', f"/api/series/{self.series['id']}/reviews", self.reviews)
        else: self.notice.setText('Select a series, then choose Organize / review in Library.')

    def reviews(self, data):
        if not isinstance(data, dict): self.notice.setText('Invalid review response.'); return
        mine = data.get('mine') or {}
        self.rating.setCurrentIndex(max(0, self.rating.findData(mine.get('rating'))))
        self.review.setPlainText(text(mine.get('body'))); self.spoiler.setChecked(bool(mine.get('spoiler')))
        lines = []
        for row in data.get('reviews', []):
            if not isinstance(row, dict) or row.get('mine'): continue
            lines += [text((row.get('user') or {}).get('displayName'), 'Reader'), 'Spoiler review hidden.' if row.get('spoiler') else text(row.get('body')), '']
        self.other_reviews.setPlainText('\n'.join(lines))

    def save_state(self):
        if not self.series.get('id'): return
        tags = [tag.strip() for tag in self.tags.text().split(',') if tag.strip()]
        if len(tags) > 30 or any(len(tag) > 40 for tag in tags): self.notice.setText('Use up to 30 personal tags, each at most 40 characters.'); return
        body = {'status': self.status.currentData(), 'tags': tags, 'wantToRead': self.want.isChecked()}
        def saved(data):
            self.series.update({'userStatus': body['status'], 'userTags': tags, 'wantToRead': body['wantToRead']})
            self.notice.setText('Personal reading state saved.')
        self.request('PUT', f"/api/series/{self.series['id']}/user", saved, body, key='write')

    def save_review(self):
        if not self.series.get('id'): return
        content = self.review.toPlainText()
        if len(content) > 5000: self.notice.setText('Reviews can contain up to 5,000 characters.'); return
        self.request('PUT', f"/api/series/{self.series['id']}/review", self.reviews, {'rating': self.rating.currentData(), 'body': content, 'spoiler': self.spoiler.isChecked()}, key='write')

    def delete_review(self):
        if self.series.get('id') and QMessageBox.question(self, 'Delete review', 'Delete your published rating and review?') == QMessageBox.StandardButton.Yes:
            self.request('DELETE', f"/api/series/{self.series['id']}/review", self.reviews, key='write')


class DiscoveryPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        row = QHBoxLayout(); button(row, 'For you', self.reload); button(row, 'Similar to selected series', self.similar); self.layout.addLayout(row)
        row = QHBoxLayout()
        self.scope = QComboBox(); self.scope.addItem('Creator', 'person'); self.scope.addItem('Genre', 'genre')
        self.query = QLineEdit(); self.query.setPlaceholderText('Explore a creator or genre'); self.query.setMaxLength(200)
        self.query.returnPressed.connect(self.explore)
        row.addWidget(self.scope); row.addWidget(self.query, 1); button(row, 'Explore', self.explore); self.layout.addLayout(row)
        self.items = QListWidget(); self.items.setAccessibleName('Recommended and related series')
        self.items.itemActivated.connect(lambda item: self.series_requested.emit(item.data(ROLE)))
        self.layout.addWidget(self.items, 1)

    def loaded(self, rows):
        rows = rows.get('items', []) if isinstance(rows, dict) else rows
        if not isinstance(rows, list): self.notice.setText('Invalid recommendations.'); return
        fill(self.items, rows, lambda row: text(row.get('name'), 'Untitled') + '\n' + text(row.get('reason'), ', '.join(row.get('authors') or [])))
        self.notice.setText(f'{self.items.count()} series. Open a result for volumes and details.' if rows else 'No matches yet. Try another creator/genre or build more reading history.')

    def reload(self): self.request('GET', '/api/recommendations', self.loaded)
    def similar(self):
        if self.series.get('id'): self.request('GET', f"/api/series/{self.series['id']}/similar", self.loaded)
        else: self.notice.setText('Select a series in Library first.')
    def explore(self):
        if self.query.text().strip(): self.request('GET', '/api/series', self.loaded, params={self.scope.currentData(): self.query.text().strip(), 'limit': 100})


class InsightsPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        row = QHBoxLayout(); button(row, 'Reading overview', self.reload)
        self.year = QSpinBox(); self.year.setRange(2000, 2200); self.year.setValue(QDate.currentDate().year()); row.addWidget(self.year)
        button(row, 'Year in review', self.year_review); self.layout.addLayout(row)
        self.summary = label('', wrap=True); self.summary.setProperty('role', 'title'); self.layout.addWidget(self.summary)
        self.goal_books = QSpinBox(); self.goal_books.setRange(0, 100000)
        self.goal_pages = QSpinBox(); self.goal_pages.setRange(0, 10000000)
        self.daily = QSpinBox(); self.daily.setRange(0, 1440); self.daily.setSuffix(' min')
        form = QFormLayout(); form.addRow('Yearly books goal (0 removes)', self.goal_books); form.addRow('Yearly pages goal (0 removes)', self.goal_pages); form.addRow('Daily reading goal', self.daily)
        self.layout.addLayout(form)
        row = QHBoxLayout(); button(row, 'Save yearly goals', self.save_goals); button(row, 'Save daily goal', self.save_daily); self.layout.addLayout(row)
        self.days = QListWidget(); self.days.setAccessibleName('Reading time by day or month'); self.layout.addWidget(self.days, 1)

    def clear_session(self):
        super().clear_session()
        if hasattr(self, 'summary'):
            self.summary.clear(); self.goal_books.setValue(0); self.goal_pages.setValue(0); self.daily.setValue(0)

    def reload(self):
        def loaded(data):
            if not isinstance(data, dict): self.notice.setText('Invalid reading statistics.'); return
            self.summary.setText(f"{round(data.get('totalSeconds', 0) / 60)} minutes read · {data.get('activeDays', 0)} active days\n{data.get('finished', 0)} books finished · streak {data.get('streak', 0)} days · best {data.get('longestStreak', 0)} days")
            goal = data.get('goal') or {}
            self.year.setValue(goal.get('year') or QDate.currentDate().year()); self.goal_books.setValue(goal.get('books') or 0); self.goal_pages.setValue(goal.get('pages') or 0); self.daily.setValue(data.get('dailyGoalMinutes') or 0)
            fill(self.days, data.get('daily', []), lambda row: text(row.get('day')) + f" · {round(row.get('seconds', 0) / 60)} minutes")
        self.request('GET', '/api/stats', loaded, params={'today': QDate.currentDate().toString('yyyy-MM-dd'), 'days': 90})

    def year_review(self):
        def loaded(data):
            if not isinstance(data, dict): self.notice.setText('Invalid yearly review.'); return
            self.summary.setText(f"Your {data.get('year')} in books\n{data.get('finished', 0)} finished · {data.get('pages', 0)} pages · {round(data.get('totalSeconds', 0) / 3600, 1)} hours · {data.get('activeDays', 0)} active days\nLongest streak: {data.get('longestStreak', 0)} days · {data.get('highlights', 0)} highlights")
            self.goal_books.setValue(data.get('goal') or 0); self.goal_pages.setValue(data.get('pagesGoal') or 0)
            fill(self.days, data.get('byMonth', []), lambda row: text(row.get('month')) + f" · {round(row.get('seconds', 0) / 60)} minutes")
        self.request('GET', '/api/stats/year', loaded, params={'year': self.year.value()})

    def save_goals(self):
        self.request('PUT', '/api/stats/goal', lambda _data: self.year_review(), {'year': self.year.value(), 'books': self.goal_books.value(), 'pages': self.goal_pages.value()}, key='write')
    def save_daily(self):
        self.request('PUT', '/api/me/prefs', lambda _data: self.notice.setText('Daily reading goal saved.'), {'dailyGoalMinutes': self.daily.value()}, key='write')


class NotificationsPanel(PersonalPanel):
    sync_requested = Signal()

    def __init__(self, api):
        super().__init__(api)
        row = QHBoxLayout(); button(row, 'Refresh notifications', self.reload); button(row, 'Reading sync / offline activity', self.sync_requested.emit); self.layout.addLayout(row)
        self.items = QListWidget(); self.items.setAccessibleName('Notifications'); self.layout.addWidget(self.items, 1)
        row = QHBoxLayout(); button(row, 'Mark selected read', self.mark_read); button(row, 'Mark all read', self.mark_all); button(row, 'Clear history', self.clear_history); self.layout.addLayout(row)
        self.layout.addWidget(label('Server downloads and chapter updates are in Content Finder → Downloads and following. Reading sync opens pending local saves, conflicts and offline downloads.', wrap=True))

    def reload(self):
        def loaded(data):
            if not isinstance(data, dict): self.notice.setText('Invalid notification response.'); return
            fill(self.items, data.get('items', []), lambda row: ('' if row.get('read') else 'Unread · ') + text(row.get('title')) + '\n' + text(row.get('body')))
            self.notice.setText(f"{data.get('unread', 0)} unread · latest {self.items.count()} notifications")
        self.request('GET', '/api/notifications', loaded, params={'limit': 300})
    def mark_read(self):
        row = current(self.items)
        if row: self.request('POST', '/api/notifications/read', lambda _data: self.reload(), {'ids': [row['id']]}, key='write')
    def mark_all(self): self.request('POST', '/api/notifications/read', lambda _data: self.reload(), {}, key='write')
    def clear_history(self):
        if QMessageBox.question(self, 'Clear notifications', 'Delete your notification history?') == QMessageBox.StandardButton.Yes:
            self.request('DELETE', '/api/notifications', lambda _data: self.reload(), key='write')


class PersonalWorkspace(QWidget):
    book_requested = Signal(dict)
    series_requested = Signal(dict)
    sync_requested = Signal()

    def __init__(self, api):
        super().__init__()
        self.user = None
        layout = QVBoxLayout(self)
        layout.addWidget(label('My reading', heading=True))
        layout.addWidget(label('Make room for the stories you love. Organize, reflect and find your next chapter.', wrap=True))
        self.tabs = QTabWidget(); layout.addWidget(self.tabs, 1)
        self.organize = OrganizationPanel(api); self.personal = SeriesPersonalPanel(api)
        self.discover = DiscoveryPanel(api); self.tonight = TonightPanel(api)
        self.journal = JournalPanel(api); self.insights = InsightsPanel(api); self.activity = NotificationsPanel(api)
        self.panels = [self.organize, self.personal, self.discover, self.tonight, self.journal, self.insights, self.activity]
        for caption, panel in zip(['Shelves', 'Series', 'Discover', 'Tonight', 'Journal', 'Insights', 'Activity'], self.panels):
            self.tabs.addTab(panel, caption)
            panel.book_requested.connect(self.book_requested)
            panel.series_requested.connect(self.series_requested)
        self.activity.sync_requested.connect(self.sync_requested)
        self.tabs.currentChanged.connect(self.activate)

    def start_session(self, user):
        self.clear_session(); self.user = user
        for panel in self.panels: panel.start_session(user)

    def clear_session(self):
        self.user = None
        for panel in self.panels: panel.clear_session()

    def set_context(self, series, book):
        for panel in self.panels: panel.context(series, book)

    def activate(self, *_args):
        if self.user: self.panels[self.tabs.currentIndex()].reload()

/** Keep different sources, libraries and owners separate even when titles match. */
export function groupDownloads(rows, direction = 'asc') {
  const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  const groups = new Map();
  for (const row of rows) {
    const title = row.bookTitle || row.title || '';
    const key = JSON.stringify([row.userId, row.libraryId, row.plugin, row.sourceId || title.trim().toLowerCase()]);
    if (!groups.has(key)) groups.set(key, { key, title, cover: row.cover || null, rows: [] });
    const group = groups.get(key);
    group.cover ||= row.cover || null;
    group.rows.push(row);
  }
  const order = direction === 'desc' ? -1 : 1;
  return [...groups.values()].sort((a, b) => order * compare(a.title, b.title) || compare(a.key, b.key)).map(group => ({
    ...group,
    rows: group.rows.sort((a, b) => order * (compare(a.fileTitle || a.title, b.fileTitle || b.title) || a.id - b.id)),
  }));
}

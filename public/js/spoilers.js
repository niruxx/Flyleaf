// Reveal the first item, read items, and the current/next item; protect later artwork.
// Use the series' existing reading order rather than deriving order from translated labels.
export function spoilerHiddenIds(books) {
  let frontier = 0;
  for (let i = 0; i < books.length; i++) {
    const progress = books[i].progress;
    if (progress?.finished || progress?.percent > 0 || progress?.page > 0 || progress?.position) {
      frontier = Math.max(frontier, i + (progress.finished ? 1 : 0));
    }
  }
  return new Set(books.filter((book, index) => index > frontier && !book.progress?.finished && !(book.progress?.percent > 0)).map(book => book.id));
}

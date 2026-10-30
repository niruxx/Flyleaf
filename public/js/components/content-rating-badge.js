import { t } from '../i18n.js';
import { h, icon } from '../ui.js';

export function contentRating({ ageRating, nsfw } = {}, source = {}) {
  if (nsfw === true || ageRating === 2 || ageRating === 3) return 'nsfw';
  if (nsfw === false || ageRating === 0 || ageRating === 1) return 'safe';
  // An adult source is a useful warning; a general source can contain unrated books.
  return source.nsfw === true ? 'nsfw' : 'unknown';
}

export function contentRatingBadge(item, source) {
  const rating = contentRating(item, source);
  const label = rating === 'nsfw' ? t('NSFW') : rating === 'safe' ? t('Not NSFW') : t('Unrated');
  const title = rating === 'nsfw' ? t('Mature or adult content') : rating === 'safe' ? t('Rated for everyone or teens') : t('Content rating unavailable');
  return h(`span.language-badge.content-rating-badge.${rating}`, { title, 'aria-label': `${label}: ${title}` },
    icon(rating === 'nsfw' ? 'explicit' : rating === 'safe' ? 'verified_user' : 'help'), h('span', label));
}

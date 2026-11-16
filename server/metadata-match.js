'use strict';

const normalize = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const isWriter = (role) => /writer|author|story/i.test(role || '');

// Automatic matches must be unambiguous. Fuzzy results remain available for manual selection.
function bestMatch(name, results, people = []) {
  const writers = people.filter((p) => isWriter(p.role)).map((p) => normalize(p.name));
  const matches = results.filter((r) => {
    if (![r.title, ...(r.altTitles || [])].some((t) => normalize(t) && normalize(t) === normalize(name))) return false;
    if (!writers.length) return true;
    const candidates = (r.people || []).filter((p) => isWriter(p.role)).map((p) => normalize(p.name));
    return candidates.some((n) => writers.includes(n));
  });
  const unique = [...new Map(matches.map((r) => [r.id, r])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function creditRoles(role) {
  const value = String(role || '').toLowerCase();
  const relators = { trl: 'Translator', edt: 'Editor', clr: 'Colorist', ink: 'Inker', clb: 'Contributor' };
  if (relators[value]) return [relators[value]];
  const roles = [];
  if (/writer|author|story|original|^aut$/.test(value)) roles.push('Writer');
  if (/art|illustrat|^ill$/.test(value)) roles.push('Artist');
  return roles.length ? roles : [role || 'Writer'];
}

module.exports = { bestMatch, creditRoles, isWriter };

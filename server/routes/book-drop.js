'use strict';

const router = require('express').Router();
const { requireAdmin } = require('../auth');
const drop = require('../book-drop');
const { withWrite } = require('../storage-migration');

router.use(requireAdmin);
router.get('/', (req, res) => res.json(drop.inbox()));
router.post('/:id/import', async (req, res) => {
  const libraryId = req.body?.libraryId;
  if (!Number.isSafeInteger(libraryId) || libraryId < 1) return res.status(400).json({ error: 'Choose a destination library.' });
  const folder = req.body.folder ?? '';
  if (typeof folder !== 'string' || folder.length > 1000) return res.status(400).json({ error: 'Enter a folder name inside the library.' });
  const result = await withWrite(() => drop.importFile(req.params.id, libraryId, req.user.id, req.body.useMatch === true, folder));
  res.status(201).json(result);
});
router.post('/:id/dismiss', (req, res) => {
  drop.dismiss(req.params.id);
  res.json({ ok: true });
});

module.exports = { router };

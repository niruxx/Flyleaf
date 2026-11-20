'use strict';

const router = require('express').Router();
const migration = require('../storage-migration');

router.get('/storage-migration', (req, res) => res.json(migration.status(req.user)));
router.get('/storage-migration/folders', async (req, res) => res.json(await migration.browse(req.user, req.query.userId == null ? req.user.id : Number(req.query.userId), req.query.path)));
router.get('/storage-migration/preview', async (req, res) => res.json(await migration.preview(req.user, req.query.userId == null ? req.user.id : Number(req.query.userId), req.query.destination)));
router.post('/storage-migration', (req, res) => {
  const id = migration.start(req.user, req.user.id, req.body?.destination);
  res.status(202).json({ id });
});
router.post('/users/:id/storage-migration', (req, res) => {
  const id = migration.start(req.user, Number(req.params.id), req.body?.destination);
  res.status(202).json({ id });
});

module.exports = router;

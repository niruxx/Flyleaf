'use strict';
const { q, tx } = require('./db');
const { createTracking } = require('./tracking-service');
module.exports = createTracking({ q, tx, providers: require('./tracking-providers'), events: require('./events'),
  getUser: (id) => { const row = q('SELECT * FROM users WHERE id=?').get(id); return row ? require('./auth').toUser(row) : null; },
  canRead: (sid, user) => Boolean(require('./serialize').getSeries(sid, user)),
});

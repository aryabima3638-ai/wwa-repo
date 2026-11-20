// Database JSON sederhana (tanpa dependency native, aman untuk panel)
const fs = require('fs');
const path = require('path');
const S = require('../setting');
const T = require('../telegram');
const { mkdirp } = require('./util');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');
mkdirp(DIR);

const data = { users: {}, history: [], maintenance: false, stats: { builds: 0, ok: 0, fail: 0 } };
try {
  Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch {}

let timer = null;
function flush() {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('[db] gagal simpan:', e.message); }
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
}
process.on('exit', flush);

const isOwner = (id) => T.ownerIds.map(Number).includes(Number(id)) || data.users[id]?.role === 'owner';
const roleOf = (id) => (isOwner(id) ? 'owner' : data.users[id]?.role || 'member');

function ensure(from) {
  const id = String(from.id);
  let isNew = false;
  if (!data.users[id]) {
    data.users[id] = {
      id: Number(id), role: 'member', credits: S.limits.freeCredit, emptyAt: null,
      verified: false, banned: false, builds: 0, joinedAt: Date.now(),
    };
    isNew = true;
  }
  const u = data.users[id];
  u.name = [from.first_name, from.last_name].filter(Boolean).join(' ') || u.name || 'User';
  u.username = from.username || u.username || '';
  save();
  return { user: u, isNew };
}

// Stub untuk user yang ditambah credit/role sebelum pernah /start
function stub(id) {
  id = String(id);
  if (!data.users[id]) {
    data.users[id] = {
      id: Number(id), role: 'member', credits: 0, emptyAt: null, verified: false,
      banned: false, builds: 0, joinedAt: Date.now(), name: 'User', username: '',
    };
    save();
  }
  return data.users[id];
}

function refill(u) {
  if (u.credits <= 0 && u.emptyAt && Date.now() - u.emptyAt >= S.limits.refillHours * 3600e3) {
    u.credits = S.limits.freeCredit;
    u.emptyAt = null;
    save();
  }
}
const canBuild = (id) => {
  if (roleOf(id) !== 'member') return true;
  const u = data.users[id];
  if (!u) return false;
  refill(u);
  return u.credits > 0;
};
function charge(id) {
  if (roleOf(id) !== 'member') return true;
  const u = data.users[id];
  refill(u);
  if (u.credits <= 0) return false;
  u.credits--;
  if (u.credits <= 0) u.emptyAt = Date.now();
  save();
  return true;
}
function refund(id) {
  if (roleOf(id) !== 'member') return;
  const u = data.users[id];
  if (!u) return;
  u.credits++;
  u.emptyAt = null;
  save();
}
function addCredit(id, n) {
  const u = stub(id);
  u.credits += n;
  u.emptyAt = null;
  save();
  return u;
}
function setRole(id, role) {
  const u = stub(id);
  u.role = role;
  save();
  return u;
}
function addHistory(entry) {
  data.history.push(entry);
  if (data.history.length > 500) data.history.splice(0, data.history.length - 500);
  data.stats.builds++;
  if (entry.status === 'sukses') data.stats.ok++;
  else if (entry.status === 'gagal') data.stats.fail++;
  save();
}

module.exports = {
  data, save, isOwner, roleOf, ensure, stub, refill, canBuild, charge, refund,
  addCredit, setRole, addHistory,
};

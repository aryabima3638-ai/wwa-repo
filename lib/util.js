const fs = require('fs');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bar = (p) => {
  const n = Math.max(0, Math.min(10, Math.round(p / 10)));
  return '█'.repeat(n) + '░'.repeat(10 - n);
};
const fmtBytes = (b) => {
  if (!b && b !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}j ${m}m ${sec}d` : m ? `${m}m ${sec}d` : `${sec}d`;
};
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const mkdirp = (d) => fs.mkdirSync(d, { recursive: true });
const rmf = (p) => { try { fs.rmSync(p, { force: true, recursive: true }); } catch {} };

module.exports = { esc, sleep, bar, fmtBytes, fmtDur, stripAnsi, mkdirp, rmf };

// MTProto (gramjs) - untuk download/kirim file besar (sampai 2GB) yang melebihi batas Bot API (20MB/50MB)
const fs = require('fs');
const path = require('path');
const S = require('../setting');
const { sleep } = require('./util');

const SESSION = path.join(__dirname, '..', 'data', 'mtproto.session');
let client = null;
let ready = false;
const cache = new Map(); // "uid:msgId" -> { m, at }

function onMsg(e) {
  try {
    const m = e.message;
    if (!m || !m.document || !m.isPrivate) return;
    cache.set(`${String(m.senderId)}:${m.id}`, { m, at: Date.now() });
    if (cache.size > 200) {
      const old = Date.now() - 30 * 60e3;
      for (const [k, v] of cache) if (v.at < old) cache.delete(k);
    }
  } catch {}
}

async function init() {
  if (!S.apiId || !S.apiHash) {
    console.log('[mtproto] NONAKTIF (apiId/apiHash kosong) -> ZIP maksimal 20MB lewat Telegram, atau pakai link direct.');
    return false;
  }
  try {
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const { NewMessage } = require('telegram/events');
    const str = fs.existsSync(SESSION) ? fs.readFileSync(SESSION, 'utf8') : '';
    client = new TelegramClient(new StringSession(str), S.apiId, S.apiHash, {
      connectionRetries: 10, autoReconnect: true,
    });
    try { client.setLogLevel('error'); } catch {}
    await client.start({ botAuthToken: S.botToken });
    fs.writeFileSync(SESSION, client.session.save());
    client.addEventHandler(onMsg, new NewMessage({ incoming: true }));
    ready = true;
    console.log('[mtproto] AKTIF -> ZIP sampai 2GB didukung.');
  } catch (e) {
    console.error('[mtproto] gagal start:', e.message);
    ready = false;
  }
  return ready;
}

async function download(uid, msgId, dest, onProgress, shouldAbort) {
  if (!ready) throw new Error('MTProto nonaktif');
  let item;
  for (let i = 0; i < 24 && !item; i++) {
    item = cache.get(`${uid}:${msgId}`);
    if (!item) await sleep(500);
  }
  if (!item) throw new Error('Pesan ZIP tidak terbaca oleh MTProto. Kirim ulang ZIP-nya.');
  await client.downloadMedia(item.m, {
    outputFile: dest,
    progressCallback: (rec, tot) => {
      if (shouldAbort && shouldAbort()) throw new Error('ABORT');
      onProgress(Number(rec.toString()), Number(tot.toString()));
    },
  });
  cache.delete(`${uid}:${msgId}`);
}

async function sendFile(chatId, file, filename, caption, onProgress) {
  if (!ready) throw new Error('MTProto nonaktif');
  const { CustomFile } = require('telegram/client/uploads');
  const size = fs.statSync(file).size;
  await client.sendFile(chatId, {
    file: new CustomFile(filename, size, file),
    caption, forceDocument: true,
    progressCallback: (p) => onProgress && onProgress(Math.round(Number(p) * 100)),
  });
}

module.exports = { init, download, sendFile, isReady: () => ready };

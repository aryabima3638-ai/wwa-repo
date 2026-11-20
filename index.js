// =====================================================
//  index.js  -  MENU UTAMA BOT FLUTTER BUILD
// =====================================================
const { Telegraf, Markup } = require('telegraf');
const S = require('./setting');
const T = require('./telegram');
const db = require('./lib/db');
const mt = require('./lib/mtproto');
const builder = require('./lib/builder');
const setup = require('./lib/setup');
const { esc, sleep, fmtDur, fmtBytes } = require('./lib/util');

if (!S.botToken || S.botToken.startsWith('ISI_')) {
  console.error('❌ Isi botToken di setting.js (atau env BOT_TOKEN) dulu.');
  process.exit(1);
}

const bot = new Telegraf(S.botToken, { handlerTimeout: 60000 });
const btn = Markup.button;
const kb = (rows) => Markup.inlineKeyboard(rows);
const pending = new Map(); // uid -> { kind, mode, at }
const memberCache = new Map(); // uid -> { ok, at }
const lastHit = new Map();
let photoId = null;

const BADGE = { owner: '👑 OWNER', reseller: '🏪 RESELLER', member: '👤 MEMBER' };
const creditEmptyText = () =>
  `CREDIT ANDA SUDAH HABIS!!! SILAHKAN BELI CREDIT/TUNGGU 1 HARI LAGI UNTUK MENDAPATKAN CREDIT ANDA KEMBALI\nOWNER : ${T.ownerUsername}`;
const denyReseller = '⚠️ <b>WARNING!</b>\nHanya role di atas member yang bisa memakai command ini!';
const denyOwner = '⚠️ <b>WARNING!</b>\nHanya role <b>OWNER</b> yang bisa memakai command ini!';

// ---------------- helper tampilan ----------------
async function sendPhotoMsg(chatId, caption, extra = {}) {
  try {
    const m = await bot.telegram.sendPhoto(chatId, photoId || S.photoUrl, { caption, parse_mode: 'HTML', ...extra });
    if (m.photo) photoId = m.photo[m.photo.length - 1].file_id;
    return m;
  } catch {
    return bot.telegram.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
}

async function show(ctx, text, keyboard) {
  const extra = { parse_mode: 'HTML', ...keyboard };
  const msg = ctx.callbackQuery?.message;
  if (msg?.photo && text.length <= 1000) {
    try { await ctx.editMessageCaption(text, extra); return; } catch (e) {
      if (/not modified/i.test(e.description || e.message)) return;
    }
  } else if (msg && !msg.photo) {
    try { await ctx.editMessageText(text, { ...extra, disable_web_page_preview: true }); return; } catch (e) {
      if (/not modified/i.test(e.description || e.message)) return;
    }
  }
  if (text.length <= 1000) await sendPhotoMsg(ctx.chat.id, text, keyboard);
  else await ctx.reply(text, { ...extra, disable_web_page_preview: true });
}

async function logChannel(text) {
  try { await sendPhotoMsg(S.logChannel, text); } catch (e) { console.error('[log channel]', e.description || e.message); }
}

const who = (u) => `${esc(u.name)}${u.username ? ' (@' + esc(u.username) + ')' : ''} • <code>${u.id}</code>`;

async function isMember(uid) {
  const c = memberCache.get(uid);
  if (c && Date.now() - c.at < 60000) return c.ok;
  let ok = false;
  try {
    const m = await bot.telegram.getChatMember(S.channel.id, uid);
    ok = ['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member);
  } catch (e) {
    console.error('[cek member]', e.description || e.message, '-> pastikan bot admin di channel');
  }
  memberCache.set(uid, { ok, at: Date.now() });
  return ok;
}

// ---------------- menu ----------------
function mainKb(uid) {
  const role = db.roleOf(uid);
  const rows = [
    [btn.callback('🌐 Build Web', 'b:web'), btn.callback('📱 Build Flutter', 'b:flutter')],
    [btn.callback('👤 Profil', 'profile'), btn.callback('💳 Credit', 'credit')],
    [btn.callback('📜 Riwayat', 'history'), btn.callback('📊 Status Build', 'status')],
  ];
  if (role === 'reseller' || role === 'owner') rows.push([btn.callback('🏪 Panel Reseller', 'reseller')]);
  if (role === 'owner') rows.push([btn.callback('👑 Panel Owner', 'owner')]);
  rows.push([btn.callback('❓ Bantuan', 'help'), btn.url('📢 Channel', S.channel.link)]);
  return kb(rows);
}

const creditText = (u, role) => {
  if (role !== 'member') return '♾ Unlimited';
  db.refill(u);
  if (u.credits > 0) return `${u.credits} credit`;
  const left = Math.max(0, u.emptyAt + S.limits.refillHours * 3600e3 - Date.now());
  return `0 (reset ${fmtDur(left)} lagi)`;
};

function mainText(u) {
  const role = db.roleOf(u.id);
  return `🤖 <b>FLUTTER BUILD BOT</b>\n━━━━━━━━━━━━━━\n👤 ${esc(u.name)}\n🆔 <code>${u.id}</code>\n🎖 Role: <b>${BADGE[role]}</b>\n💳 Credit: <b>${creditText(u, role)}</b>\n🛠 Bot: ${db.data.maintenance ? '🔴 Maintenance' : '🟢 Online'}\n━━━━━━━━━━━━━━\nPilih menu di bawah 👇`;
}

const showMain = (ctx) => show(ctx, mainText(db.data.users[ctx.from.id]), mainKb(ctx.from.id));

function joinScreen(ctx) {
  return show(ctx,
    `👋 Halo <b>${esc(ctx.from.first_name)}</b>!\n\n🤖 <b>FLUTTER BUILD BOT</b>\nBuild Flutter jadi APK langsung dari ZIP source (sampai 2GB).\n\n⚠️ Untuk memakai bot, kamu wajib:\n1️⃣ Follow channel dulu\n2️⃣ Tekan tombol <b>Verifikasi</b>`,
    kb([[btn.url('📢 Follow Channel', S.channel.link)], [btn.callback('✅ Verifikasi', 'verify')]]));
}

// ---------------- middleware ----------------
bot.catch((err, ctx) => console.error('[bot error]', ctx?.updateType, err.message));

bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return; // hanya chat pribadi
  const { user, isNew } = db.ensure(ctx.from);
  if (isNew) {
    logChannel(`🆕 <b>USER BARU /START</b>\n━━━━━━━━━━━━━━\n👤 ${who(user)}\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n👥 Total user: <b>${Object.keys(db.data.users).length}</b>`);
  }
  if (user.banned && !db.isOwner(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('🚫 Kamu diblokir.', { show_alert: true }).catch(() => {});
    return ctx.reply('🚫 Kamu diblokir dari bot ini.');
  }
  // anti spam
  const now = Date.now();
  if (now - (lastHit.get(ctx.from.id) || 0) < 500) {
    if (ctx.callbackQuery) ctx.answerCbQuery().catch(() => {});
    return;
  }
  lastHit.set(ctx.from.id, now);
  // maintenance (owner bebas)
  if (db.data.maintenance && !db.isOwner(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery(S.texts.maintenance, { show_alert: true }).catch(() => {});
    return ctx.reply(`🚧 <b>${esc(S.texts.maintenance)}</b>`, { parse_mode: 'HTML' });
  }
  // wajib follow channel
  const free = ctx.callbackQuery?.data === 'verify' || ctx.message?.text?.startsWith('/start');
  if (!free && !db.isOwner(ctx.from.id) && !(await isMember(ctx.from.id))) {
    if (ctx.callbackQuery) ctx.answerCbQuery('Follow channel dulu!', { show_alert: true }).catch(() => {});
    return joinScreen(ctx);
  }
  return next();
});

// ---------------- start & verifikasi ----------------
bot.start(async (ctx) => {
  pending.delete(ctx.from.id);
  const u = db.data.users[ctx.from.id];
  if (db.isOwner(ctx.from.id) || (u.verified && (await isMember(ctx.from.id)))) return showMain(ctx);
  return joinScreen(ctx);
});

bot.action('verify', async (ctx) => {
  memberCache.delete(ctx.from.id);
  if (!(await isMember(ctx.from.id))) {
    return ctx.answerCbQuery('❌ Kamu belum follow channel! Follow dulu lalu tekan Verifikasi.', { show_alert: true });
  }
  await ctx.answerCbQuery('✅ Verifikasi berhasil!');
  const u = db.data.users[ctx.from.id];
  const first = !u.verified;
  u.verified = true; db.save();
  if (first) {
    logChannel(`✅ <b>USER BARU TERVERIFIKASI</b>\n━━━━━━━━━━━━━━\n👤 ${who(u)}\n🎖 Role: ${BADGE[db.roleOf(u.id)]}\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n👥 Total user: <b>${Object.keys(db.data.users).length}</b>`);
  }
  // logo + menu muncul setelah berhasil join
  try { await ctx.deleteMessage(); } catch {}
  await sendPhotoMsg(ctx.chat.id, `🎉 <b>Verifikasi berhasil!</b>\nSelamat datang, ${esc(u.name)}.\n\n` + mainText(u), mainKb(u.id));
});

bot.action('menu', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); return showMain(ctx); });

// ---------------- menu build ----------------
const backBtn = [btn.callback('⬅️ Kembali', 'menu')];

function needCredit(ctx) {
  if (db.canBuild(ctx.from.id)) return false;
  show(ctx, `❌ <b>${esc(creditEmptyText())}</b>`, kb([backBtn]));
  return true;
}

function askZip(ctx, kind, mode) {
  pending.set(ctx.from.id, { kind, mode, at: Date.now() });
  const big = mt.isReady() ? 'sampai 2GB' : 'maks 20MB (isi apiId/apiHash agar bisa 2GB)';
  return show(ctx,
    `📦 <b>${kind === 'web' ? 'BUILD WEB' : `BUILD FLUTTER ${mode.toUpperCase()}`}</b>\n\nKirim sekarang:\n• File <b>.ZIP</b> project Flutter (${big})\n• atau <b>link direct</b> ke ZIP (https://...)\n\n📌 ZIP harus berisi <code>pubspec.yaml</code>.\n💳 1 build = 1 credit.`,
    kb([[btn.callback('❌ Batal', 'menu')]]));
}

bot.action('b:web', async (ctx) => {
  await ctx.answerCbQuery();
  if (builder.getJob(ctx.from.id)) return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (needCredit(ctx)) return;
  return askZip(ctx, 'web', 'release');
});

bot.action('b:flutter', async (ctx) => {
  await ctx.answerCbQuery();
  if (builder.getJob(ctx.from.id)) return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (needCredit(ctx)) return;
  return show(ctx, '📱 <b>BUILD FLUTTER</b>\nPilih tipe build:\n\n🚀 <b>Release</b> - APK final, ukuran kecil\n🐞 <b>Debug</b> - APK debug, build lebih cepat',
    kb([[btn.callback('🚀 Build Release', 'bf:release'), btn.callback('🐞 Build Debug', 'bf:debug')], backBtn]));
});

bot.action(/^bf:(release|debug)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (needCredit(ctx)) return;
  return askZip(ctx, 'flutter', ctx.match[1]);
});

async function launch(ctx, src) {
  const p = pending.get(ctx.from.id);
  if (!p || Date.now() - p.at > 15 * 60e3) {
    pending.delete(ctx.from.id);
    return ctx.reply('⚠️ Pilih menu build dulu (Build Flutter / Build Web) baru kirim ZIP.');
  }
  pending.delete(ctx.from.id);
  const r = await builder.start(bot, { uid: ctx.from.id, chatId: ctx.chat.id, kind: p.kind, mode: p.mode, src });
  if (!r.ok && r.reason === 'credit') return ctx.reply(`❌ ${creditEmptyText()}`);
  if (!r.ok && r.reason === 'busy') return ctx.reply('⚠️ Kamu masih punya build yang berjalan.');
}

bot.on('document', async (ctx) => {
  const d = ctx.message.document;
  if (!pending.get(ctx.from.id)) return ctx.reply('⚠️ Pilih menu build dulu (Build Flutter / Build Web) baru kirim ZIP.');
  if (!/\.zip$/i.test(d.file_name || '') && !/zip/i.test(d.mime_type || '')) return ctx.reply('❌ File harus berformat <b>.zip</b>', { parse_mode: 'HTML' });
  if (d.file_size > S.limits.maxZipBytes) return ctx.reply(`❌ File terlalu besar (${fmtBytes(d.file_size)}). Maksimal ${fmtBytes(S.limits.maxZipBytes)}.`);
  if (d.file_size > 20 * 1024 * 1024 && !mt.isReady()) {
    return ctx.reply(`❌ ZIP ${fmtBytes(d.file_size)} > 20MB. Owner belum mengaktifkan MTProto (apiId/apiHash).\nSolusi: kirim <b>link direct</b> ZIP kamu.`, { parse_mode: 'HTML' });
  }
  return launch(ctx, { type: 'tg', fileId: d.file_id, size: d.file_size, msgId: ctx.message.message_id, name: d.file_name });
});

bot.on('text', async (ctx, next) => {
  const t = ctx.message.text.trim();
  if (pending.get(ctx.from.id) && /^https?:\/\/\S+$/i.test(t)) return launch(ctx, { type: 'url', url: t });
  return next();
});

bot.action(/^cancel:(\d+)$/, async (ctx) => {
  const uid = Number(ctx.match[1]);
  if (uid !== ctx.from.id && !db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Bukan build kamu.', { show_alert: true });
  const ok = builder.cancel(uid, 'user');
  return ctx.answerCbQuery(ok ? '🛑 Membatalkan build...' : 'Build sudah selesai.', { show_alert: !ok });
});

// ---------------- profil, credit, riwayat, status, bantuan ----------------
bot.action('profile', async (ctx) => {
  await ctx.answerCbQuery();
  const u = db.data.users[ctx.from.id];
  const role = db.roleOf(u.id);
  return show(ctx, `👤 <b>PROFIL</b>\n━━━━━━━━━━━━━━\nNama: ${esc(u.name)}\nID: <code>${u.id}</code>\nRole: <b>${BADGE[role]}</b>\nCredit: <b>${creditText(u, role)}</b>\nTotal build: <b>${u.builds}</b>\nBergabung: ${new Date(u.joinedAt).toLocaleDateString('id-ID')}`, kb([backBtn]));
});

bot.action('credit', async (ctx) => {
  await ctx.answerCbQuery();
  const u = db.data.users[ctx.from.id];
  const role = db.roleOf(u.id);
  const info = role === 'member'
    ? `Member dapat <b>${S.limits.freeCredit} credit gratis</b>. Kalau habis, tunggu ${S.limits.refillHours} jam atau beli credit.\n`
    : 'Role kamu <b>unlimited build</b>.\n';
  return show(ctx, `💳 <b>CREDIT</b>\n━━━━━━━━━━━━━━\nSaldo: <b>${creditText(u, role)}</b>\n${info}\nBeli credit / upgrade reseller: ${T.ownerUsername}`, kb([backBtn]));
});

bot.action('history', async (ctx) => {
  await ctx.answerCbQuery();
  const h = db.data.history.filter((x) => x.uid === ctx.from.id).slice(-8).reverse();
  const em = { sukses: '✅', gagal: '❌', error: '⚠️', maintenance: '🚧', dibatalkan: '🛑', stuck: '⌛' };
  const body = h.length
    ? h.map((x) => `${em[x.status] || '•'} ${x.kind === 'web' ? 'Web' : 'Flutter ' + x.mode} • ${x.status} • ${fmtDur(x.dur)}\n   ${new Date(x.at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`).join('\n')
    : 'Belum ada riwayat build.';
  return show(ctx, `📜 <b>RIWAYAT BUILD</b>\n━━━━━━━━━━━━━━\n${body}`, kb([backBtn]));
});

bot.action('status', async (ctx) => {
  await ctx.answerCbQuery();
  const j = builder.getJob(ctx.from.id);
  if (!j) return show(ctx, '📊 <b>STATUS BUILD</b>\nTidak ada build yang berjalan.', kb([backBtn]));
  return show(ctx, builder.render(j), kb([[btn.callback('❌ Batalkan', `cancel:${j.uid}`)], backBtn]));
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return show(ctx, `❓ <b>BANTUAN</b>\n━━━━━━━━━━━━━━\n1. Pilih Build Flutter / Web\n2. Kirim ZIP project (atau link direct)\n3. Tunggu, hasil APK dikirim otomatis\n4. Kalau gagal, log error lengkap dikirim\n\n<b>Command</b>\n/start • menu utama\n/addcredit &lt;id&gt; [jumlah] • reseller/owner\n/addreseller &lt;id&gt; • owner\n/addowner &lt;id&gt; • owner\n\nOwner: ${T.ownerUsername}`, kb([backBtn]));
});

// ---------------- panel reseller & owner ----------------
bot.action('reseller', async (ctx) => {
  await ctx.answerCbQuery();
  if (db.roleOf(ctx.from.id) === 'member') return ctx.answerCbQuery('Khusus reseller/owner', { show_alert: true });
  return show(ctx, `🏪 <b>PANEL RESELLER</b>\n━━━━━━━━━━━━━━\nTambah credit user:\n<code>/addcredit ID_USER [jumlah]</code>\n\nContoh: <code>/addcredit 123456789 10</code>\n(jumlah kosong = ${S.limits.freeCredit})`, kb([backBtn]));
});

function ownerPanel() {
  const on = db.data.maintenance;
  return {
    text: `👑 <b>PANEL OWNER</b>\n━━━━━━━━━━━━━━\n🛠 Maintenance: <b>${on ? '🔴 ON' : '🟢 OFF'}</b>\n🔧 Build aktif: <b>${builder.allJobs().length}</b>\n\nCommand:\n/addcredit • /addreseller • /addowner\n/setupgithub • /delreseller • /ban • /unban • /cekuser\n/broadcast • /maintenance on|off`,
    keyboard: kb([
      [btn.callback(on ? '🟢 Matikan Maintenance' : '🔴 Nyalakan Maintenance', 'mt:toggle')],
      [btn.callback('📊 Statistik', 'stats'), btn.callback('🔧 Build Aktif', 'active')],
      [btn.callback('⚙️ Setup GitHub Otomatis', 'setupgh')],
      backBtn,
    ]),
  };
}

bot.action('owner', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const p = ownerPanel();
  return show(ctx, p.text, p.keyboard);
});

function setMaintenance(on) {
  db.data.maintenance = on; db.save();
  return on ? builder.abortAllForMaintenance() : 0;
}

bot.action('mt:toggle', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const n = setMaintenance(!db.data.maintenance);
  await ctx.answerCbQuery(db.data.maintenance ? `Maintenance ON, ${n} build dihentikan` : 'Maintenance OFF', { show_alert: true });
  const p = ownerPanel();
  return show(ctx, p.text, p.keyboard);
});

async function runSetup() {
  try { return `✅ <b>Setup GitHub selesai</b>\n<pre>${esc(await setup.ensure())}</pre>`; }
  catch (e) { return `❌ <b>Setup GitHub gagal</b>\n<pre>${esc(e.message).slice(0, 800)}</pre>\nCek github.token (scope repo+workflow) & github.repo di setting.js`; }
}
bot.action('setupgh', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Menyiapkan GitHub...');
  return show(ctx, await runSetup(), kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});
bot.command('setupgithub', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  return ctx.reply(await runSetup(), { parse_mode: 'HTML' });
});

bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const us = Object.values(db.data.users);
  const c = (r) => us.filter((u) => db.roleOf(u.id) === r).length;
  const s = db.data.stats;
  return show(ctx, `📊 <b>STATISTIK</b>\n━━━━━━━━━━━━━━\n👥 User: <b>${us.length}</b> (verified ${us.filter((u) => u.verified).length})\n👑 Owner ${c('owner')} • 🏪 Reseller ${c('reseller')} • 👤 Member ${c('member')}\n🏗 Total build: <b>${s.builds}</b>\n✅ Sukses ${s.ok} • ❌ Gagal ${s.fail}`, kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});

bot.action('active', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const js = builder.allJobs();
  const body = js.length
    ? js.map((j) => `• <code>${j.uid}</code> ${j.kind} ${j.mode} • ${fmtDur(Date.now() - j.startedAt)} • ${esc(j.steps.find((s) => s.st === 'run')?.t || '...')}`).join('\n')
    : 'Tidak ada build aktif.';
  return show(ctx, `🔧 <b>BUILD AKTIF</b>\n━━━━━━━━━━━━━━\n${body}`, kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});

// ---------------- command ----------------
const args = (ctx) => ctx.message.text.trim().split(/\s+/).slice(1);
const validId = (s) => /^\d{5,15}$/.test(s || '');
const notify = (id, text) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});

bot.command('addcredit', async (ctx) => {
  if (db.roleOf(ctx.from.id) === 'member') return ctx.reply(denyReseller, { parse_mode: 'HTML' });
  const [id, n] = args(ctx);
  if (!validId(id)) return ctx.reply('Format: <code>/addcredit ID_USER [jumlah]</code>', { parse_mode: 'HTML' });
  const amount = n === undefined ? S.limits.freeCredit : parseInt(n, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return ctx.reply('❌ Jumlah credit tidak valid (1 - 100000).');
  const u = db.addCredit(id, amount);
  notify(id, `💳 Kamu mendapat <b>+${amount} credit</b>!\nSaldo sekarang: <b>${u.credits}</b>`);
  return ctx.reply(`✅ Berhasil menambah <b>${amount} credit</b> ke <code>${id}</code>.\nSaldo: ${u.credits}`, { parse_mode: 'HTML' });
});

async function roleCmd(ctx, role) {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id)) return ctx.reply(`Format: <code>${ctx.message.text.split(' ')[0]} ID_USER</code>`, { parse_mode: 'HTML' });
  if (role === 'reseller' && db.isOwner(id)) return ctx.reply('❌ User itu sudah OWNER.');
  db.setRole(id, role);
  notify(id, `🎉 Role kamu sekarang <b>${BADGE[role]}</b>!\nKetik /start untuk membuka menu.`);
  return ctx.reply(`✅ <code>${id}</code> sekarang <b>${BADGE[role]}</b>.`, { parse_mode: 'HTML' });
}
bot.command(['addreseller', 'address'], (ctx) => roleCmd(ctx, 'reseller'));
bot.command('addowner', (ctx) => roleCmd(ctx, 'owner'));

bot.command('delreseller', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id) || db.data.users[id]?.role !== 'reseller') return ctx.reply('❌ ID bukan reseller. Format: /delreseller ID_USER');
  db.setRole(id, 'member');
  return ctx.reply(`✅ <code>${id}</code> dikembalikan jadi MEMBER.`, { parse_mode: 'HTML' });
});

bot.command('maintenance', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [a] = args(ctx);
  if (!['on', 'off'].includes((a || '').toLowerCase())) return ctx.reply('Format: /maintenance on|off');
  const on = a.toLowerCase() === 'on';
  const n = setMaintenance(on);
  return ctx.reply(on ? `🔴 Maintenance ON. ${n} build user dihentikan.` : '🟢 Maintenance OFF. Bot kembali normal.');
});

for (const [cmd, val] of [['ban', true], ['unban', false]]) {
  bot.command(cmd, async (ctx) => {
    if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
    const [id] = args(ctx);
    if (!validId(id) || db.isOwner(id)) return ctx.reply(`Format: /${cmd} ID_USER (owner tidak bisa di-ban)`);
    db.stub(id).banned = val; db.save();
    if (val) builder.cancel(id, 'user');
    return ctx.reply(`✅ <code>${id}</code> ${val ? 'diblokir' : 'dibuka blokirnya'}.`, { parse_mode: 'HTML' });
  });
}

bot.command('cekuser', async (ctx) => {
  if (db.roleOf(ctx.from.id) === 'member') return ctx.reply(denyReseller, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  const u = db.data.users[id];
  if (!u) return ctx.reply('❌ User tidak ditemukan.');
  return ctx.reply(`👤 ${who(u)}\nRole: ${BADGE[db.roleOf(id)]}\nCredit: ${creditText(u, db.roleOf(id))}\nBuild: ${u.builds}\nVerified: ${u.verified ? 'ya' : 'belum'}\nBanned: ${u.banned ? 'ya' : 'tidak'}`, { parse_mode: 'HTML' });
});

bot.command('stats', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const s = db.data.stats;
  return ctx.reply(`👥 User: ${Object.keys(db.data.users).length}\n🏗 Build: ${s.builds} (✅ ${s.ok} / ❌ ${s.fail})\n🔧 Aktif: ${builder.allJobs().length}\n🛠 Maintenance: ${db.data.maintenance ? 'ON' : 'OFF'}`);
});

bot.command('broadcast', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();
  if (!text) return ctx.reply('Format: /broadcast teks pesan');
  const ids = Object.values(db.data.users).filter((u) => u.verified).map((u) => u.id);
  await ctx.reply(`📢 Mengirim ke ${ids.length} user...`);
  (async () => {
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await bot.telegram.sendMessage(id, `📢 <b>PENGUMUMAN</b>\n\n${esc(text)}`, { parse_mode: 'HTML' }); ok++; } catch { fail++; }
      await sleep(60);
    }
    notify(ctx.from.id, `✅ Broadcast selesai. Terkirim ${ok}, gagal ${fail}.`);
  })();
});

// ---------------- jalankan ----------------
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => {
  await mt.init();
  const me = await bot.telegram.getMe();
  console.log(`✅ Bot @${me.username} berjalan | Owner: ${T.ownerIds.join(', ')}`);
  try {
    const m = await bot.telegram.getChatMember(S.channel.id, me.id);
    if (!['administrator', 'creator'].includes(m.status)) console.warn('⚠️ Bot BUKAN admin di channel! Jadikan admin agar verifikasi & notifikasi jalan.');
  } catch (e) {
    console.warn('⚠️ Channel tidak terbaca:', e.description || e.message, '-> cek setting.js channel.id & jadikan bot admin.');
  }
  setup.ensure().then((r) => console.log('[setup github]\n' + r)).catch((e) => console.warn('⚠️ Setup GitHub gagal:', e.message));
  bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error('Gagal launch:', e.message); process.exit(1); });
})();

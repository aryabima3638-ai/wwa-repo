// Wrapper GitHub API (release, workflow dispatch, run, job log, artifact)
const fs = require('fs');
const https = require('https');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const S = require('../setting');
const { sleep } = require('./util');

const cfg = S.github;
const BASE = 'https://api.github.com';
const HEAD = () => ({
  Authorization: `Bearer ${cfg.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'flutter-build-bot',
});

async function api(method, pathname, { body, raw, retries = 3 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(BASE + pathname, {
        method,
        headers: { ...HEAD(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status >= 500 && i < retries) { await sleep(2000 * (i + 1)); continue; }
      if (raw) return res;
      if (res.status === 204) return null;
      const txt = await res.text();
      let json; try { json = JSON.parse(txt); } catch { json = txt; }
      if (!res.ok) {
        const err = new Error(`GitHub ${res.status}: ${json?.message || txt}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } catch (e) {
      if (e.status) throw e;
      if (i < retries) { await sleep(2000 * (i + 1)); continue; }
      throw e;
    }
  }
}

const R = () => `/repos/${cfg.repo}`;

async function createRelease(tag) {
  return api('POST', `${R()}/releases`, {
    body: {
      tag_name: tag, target_commitish: cfg.branch, name: tag,
      body: 'Source ZIP sementara (otomatis dihapus setelah build)', prerelease: true,
    },
  });
}

// Upload file besar (sampai 2GB) secara streaming
function uploadAsset(releaseId, file, name, onProgress, shouldAbort) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const u = new URL(`https://uploads.github.com/repos/${cfg.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`);
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: { ...HEAD(), 'Content-Type': 'application/zip', 'Content-Length': size },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(JSON.parse(buf));
        reject(new Error(`Upload asset gagal (${res.statusCode}): ${buf.slice(0, 300)}`));
      });
    });
    req.setTimeout(180000, () => req.destroy(new Error('Upload ke GitHub timeout (tidak ada aktivitas 3 menit)')));
    req.on('error', reject);
    const rs = fs.createReadStream(file);
    let sent = 0;
    rs.on('data', (c) => {
      sent += c.length;
      if (shouldAbort && shouldAbort()) { rs.destroy(); req.destroy(new Error('ABORT')); return; }
      onProgress && onProgress(sent, size);
    });
    rs.on('error', reject);
    rs.pipe(req);
  });
}

const dispatch = (workflow, inputs) =>
  api('POST', `${R()}/actions/workflows/${workflow}/dispatches`, { body: { ref: cfg.branch, inputs } });

const listRuns = (workflow) =>
  api('GET', `${R()}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`);
const getRun = (id) => api('GET', `${R()}/actions/runs/${id}`);
const getJobs = (id) => api('GET', `${R()}/actions/runs/${id}/jobs?per_page=30`);
const cancelRun = (id) => api('POST', `${R()}/actions/runs/${id}/cancel`).catch(() => {});
const listArtifacts = (id) => api('GET', `${R()}/actions/runs/${id}/artifacts`);

async function jobLog(jobId) {
  const res = await api('GET', `${R()}/actions/jobs/${jobId}/logs`, { raw: true });
  if (!res.ok) throw new Error(`Gagal ambil log job (${res.status})`);
  return res.text();
}

async function downloadArtifact(id, dest) {
  const res = await fetch(`${BASE}${R()}/actions/artifacts/${id}/zip`, {
    headers: HEAD(), redirect: 'follow', signal: AbortSignal.timeout(15 * 60e3),
  });
  if (!res.ok) throw new Error(`Download artifact gagal (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function cleanup({ releaseId, tag, runId, artifactIds = [] }) {
  const q = [];
  if (releaseId) q.push(api('DELETE', `${R()}/releases/${releaseId}`));
  if (tag) q.push(api('DELETE', `${R()}/git/refs/tags/${tag}`));
  artifactIds.forEach((a) => q.push(api('DELETE', `${R()}/actions/artifacts/${a}`)));
  if (runId) q.push(api('DELETE', `${R()}/actions/runs/${runId}`));
  await Promise.allSettled(q);
}

module.exports = {
  api, createRelease, uploadAsset, dispatch, listRuns, getRun, getJobs, cancelRun,
  listArtifacts, jobLog, downloadArtifact, cleanup,
};

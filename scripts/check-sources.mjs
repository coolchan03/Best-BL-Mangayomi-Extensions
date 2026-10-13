import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { load } from 'cheerio';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
export const INDEXES = ['index.json', 'novel_index.json', 'anime_index.json'];
const TIMEOUT = 10000;
const hashOf = data => createHash('sha256').update(data).digest('hex');

export function decideStatus(previous, probe, checkedAt) {
  const old = previous ?? {};
  const common = { checkedAt, probeReason: String(probe.reason || 'unknown').slice(0, 120),
    probeHash: probe.hash || '' };
  if (probe.kind === 'ok') return { ...common, status: 'ok', failureStreak: 0 };
  if (probe.kind === 'definitive') {
    const failureStreak = old.probeHash === probe.hash && old.probeReason === probe.reason
      ? (Number(old.failureStreak) || 0) + 1 : 1;
    return { ...common, status: failureStreak >= 2 ? 'broken' : 'unverified', failureStreak };
  }
  if (old.status === 'broken' && old.probeHash && old.probeHash === probe.hash)
    return { ...common, status: 'broken', failureStreak: old.failureStreak };
  return { ...common, status: 'unverified', failureStreak: 0 };
}

export function safeUrl(address) {
  const uri = new URL(address);
  if (uri.protocol !== 'https:') throw Error('https_only');
  const host = uri.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') ||
      host.endsWith('.internal') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host.includes(':')) throw Error('unsafe_host');
  return uri;
}

async function request(address, options = {}) {
  let uri = safeUrl(address);
  for (let i = 0; i < 4; i++) {
    const response = await fetch(uri, { ...options, redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': 'MonogatariExtensionCheck/1.0', ...(options.headers || {}) } });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
      uri = safeUrl(new URL(response.headers.get('location'), uri).href);
      continue;
    }
    if (!response.ok) throw Error('HTTP_' + response.status);
    const len = Number(response.headers.get('content-length') || 0);
    if (len > 2_000_000) throw Error('too_large');
    const body = await response.text();
    if (body.length > 2_000_000) throw Error('too_large');
    return { body, url: uri.href, statusCode: response.status, status: response.status };
  }
  throw Error('redirect_limit');
}

function document(html) {
  const $ = load(String(html || ''));
  class Element {
    constructor(node) { this.node = node; }
    select(selector) { return $(selector, this.node).toArray().map(n => new Element(n)); }
    selectFirst(selector) { const n = $(selector, this.node).get(0); return n && new Element(n); }
    get text() { return $(this.node).text().trim(); }
    attr(name) { return $(this.node).attr(name) || ''; }
    getAttribute(name) { return this.attr(name); }
    get getHref() { return this.attr('href'); }
    get getSrc() { return this.attr('src') || this.attr('data-src'); }
    get html() { return $(this.node).html() || ''; }
  }
  return new Element($.root().get(0));
}

async function dynamic(entry, code) {
  const api = {
    console: { log() {}, warn() {}, error() {} },
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, encodeURI,
    decodeURI, atob, btoa, setTimeout, clearTimeout,
    MProvider: class { constructor() { this.source = entry; } },
    Client: class {
      get(url, headers = {}) { return request(url, { headers }); }
      post(url, body = {}, headers = {}) {
        return request(url, { method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body) });
      }
    },
    Document: class { constructor(html) { return document(html); } },
    SharedPreferences: class { get() { return ''; } set() {} },
    Headers, FormData, Request, Response,
  };
  vm.createContext(api, { codeGeneration: { strings: false, wasm: false } });
  const Extension = new vm.Script(code + '\n;DefaultExtension',
    { filename: entry.name + '.js' }).runInContext(api, { timeout: 1500 });
  if (typeof Extension !== 'function') return { kind: 'definitive', reason: 'missing_entrypoint' };
  const instance = new Extension();
  instance.source = entry;
  if (typeof instance.search !== 'function' || typeof instance.getDetail !== 'function')
    return { kind: 'definitive', reason: 'missing_search_or_detail' };
  const found = await instance.search('love', 1, []);
  const items = Array.isArray(found) ? found : found?.list;
  if (!Array.isArray(items) || !items.length)
    return { kind: 'unknown', reason: 'empty_or_unsupported_search' };
  const item = items[0], url = item?.link || item?.url || item?.publicUrl;
  if (typeof url !== 'string' || !url)
    return { kind: 'unknown', reason: 'detail_url_missing' };
  const detail = await instance.getDetail(url);
  const title = detail?.name || detail?.title || detail?.info?.name;
  return typeof title === 'string' && title.trim()
    ? { kind: 'ok', reason: 'search_and_detail_verified' }
    : { kind: 'unknown', reason: 'detail_not_verified' };
}

async function child() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try {
    const { entry, code } = JSON.parse(data);
    process.stdout.write(JSON.stringify(await dynamic(entry, code)));
  } catch (e) {
    process.stdout.write(JSON.stringify({ kind: 'unknown', reason: 'runtime_' +
      String(e?.message || e).replace(/\W+/g, '_').slice(0, 70) }));
  }
}

function dynamicInProcess(entry, code) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [SELF, '--probe-one'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: ROOT, env: { PATH: process.env.PATH || '', NODE_ENV: 'production' },
    });
    let output = '';
    const watchdog = setTimeout(() => proc.kill(), 20000);
    proc.stdout.on('data', chunk => { output += String(chunk).slice(0, 2000); });
    proc.stdin.on('error', () => {});
    proc.on('error', () => { clearTimeout(watchdog); resolve({ kind: 'unknown', reason: 'probe_spawn_error' }); });
    proc.on('close', () => {
      clearTimeout(watchdog);
      try { resolve(JSON.parse(output)); }
      catch { resolve({ kind: 'unknown', reason: 'probe_timeout_or_crash' }); }
    });
    proc.stdin.end(JSON.stringify({ entry, code }));
  });
}

export async function probe(entry) {
  if (entry.sourceCodeLanguage !== 1 ||
      !String(entry.sourceCodeUrl || '').match(/\.js(?:\?.*)?$/i)) {
    return { kind: 'unknown', reason: 'unsupported_source_language', hash: String(entry.version) };
  }
  let code;
  try { code = (await request(entry.sourceCodeUrl)).body; }
  catch (err) {
    return { kind: 'unknown', reason: 'download_' + String(err.message || err).slice(0, 60),
      hash: String(entry.version) + '|' + entry.sourceCodeUrl };
  }
  const hash = hashOf(code);
  try { new vm.Script(code, { filename: entry.name + '.js' }); }
  catch { return { kind: 'definitive', reason: 'javascript_syntax_error', hash }; }
  if (!/\bclass\s+DefaultExtension\b|\bDefaultExtension\s*=/.test(code))
    return { kind: 'definitive', reason: 'missing_entrypoint', hash };
  return { ...await dynamicInProcess(entry, code), hash };
}

async function main() {
  const checkedAt = new Date().toISOString();
  for (const name of INDEXES) {
    const path = join(ROOT, name);
    const entries = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!Array.isArray(entries)) throw Error(name + ': index not an array');
    let current = 0;
    const statuses = {};
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (current < entries.length) {
        const entry = entries[current++];
        if (!entry || !entry.id || !entry.sourceCodeUrl) continue;
        const result = decideStatus(entry, await probe(entry), checkedAt);
        Object.assign(entry, result);
        statuses[result.status] = (statuses[result.status] || 0) + 1;
      }
    }));
    await fs.writeFile(path, JSON.stringify(entries, null, 2) + '\n', 'utf8');
    console.log(name, JSON.stringify(statuses), checkedAt);
  }
}

if (process.argv.includes('--probe-one')) await child();
else if (process.argv[1] && resolve(process.argv[1]) === SELF) await main();

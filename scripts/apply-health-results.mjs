import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const incoming = resolve(process.argv[2] || './checked-indexes');
const files = ['index.json', 'novel_index.json', 'anime_index.json'];
const statuses = new Set(['ok', 'broken', 'unverified']);
const healthFields = ['status', 'checkedAt', 'probeReason', 'failureStreak', 'probeHash'];

export function mergeResults(current, checked) {
  if (!Array.isArray(current) || !Array.isArray(checked)) throw Error('Index not an array');
  const byId = new Map(checked.map(item => [String(item.id), item]));
  if (byId.size !== checked.length || checked.length !== current.length) throw Error('Index membership changed');
  return current.map(item => {
    const result = byId.get(String(item.id));
    if (!result || item.sourceCodeUrl !== result.sourceCodeUrl ||
        item.version !== result.version || item.baseUrl !== result.baseUrl)
      throw Error('Index changed during probe');
    if (!statuses.has(result.status) || Number.isNaN(Date.parse(result.checkedAt)))
      throw Error('Invalid probe result');
    const updated = { ...item };
    for (const field of healthFields) {
      if (result[field] !== undefined) updated[field] = result[field];
    }
    return updated;
  });
}

async function main() {
  for (const file of files) {
    const current = JSON.parse(await fs.readFile(join(root, file), 'utf8'));
    const checked = JSON.parse(await fs.readFile(join(incoming, file), 'utf8'));
    const merged = mergeResults(current, checked);
    await fs.writeFile(join(root, file), JSON.stringify(merged, null, 2) + '\n');
    console.log(file, merged.length, 'source health statuses updated');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

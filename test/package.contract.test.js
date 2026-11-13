import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('Calendar uses a consistent package identity', async () => {
  const [manifest, index, api] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('index.js', root), 'utf8'),
    readFile(new URL('views/lib/api.js', root), 'utf8'),
  ]);

  const pkg = JSON.parse(manifest);
  assert.equal(pkg.name, 'calendar');
  assert.deepEqual(pkg.manifest.iconPreset, { pack: 'lucide', name: 'Calendar' });
  assert.equal(pkg.manifest.menu.icon, undefined);
  assert.match(index, /getProxy\('calendar'\)/);
  assert.match(index, /dispatchEvent\('calendar:created'/);
  assert.match(index, /@register_tool calendar_createEvent/);
  assert.match(api, /const BASE = '\/calendar'/);
});

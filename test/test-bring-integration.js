import assert from 'node:assert/strict';
import test from 'node:test';
import { BringRecipeClient } from '../tools/bring/export-recipes.mjs';
import { YuvomiClient } from '../tools/bring/import-recipes.mjs';
import { checkShoppingSync } from '../tools/bring/integration.mjs';

const bringPath = 'v2/bringlists/ci';
const yuvomiPath = 'api/v1/shopping/42/items';

function fakeApis({ populated = false, failYuvomiCreate = false } = {}) {
  let remote;
  let local = populated ? { id: 12, name: 'existing item' } : undefined;
  const mutations = [];
  const fetchImpl = async (url, options) => {
    const path = url.pathname.slice(1);
    const method = options.method ?? 'GET';
    if (path === 'v2/bringauth') {
      return Response.json({ uuid: 'private', publicUuid: 'public', access_token: 'fake' });
    }
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (path === bringPath) {
      return Response.json({
        items: {
          purchase: remote && !remote.checked ? [remote] : [],
          recently: remote?.checked ? [remote] : [],
        },
      });
    }
    if (path === `${bringPath}/items` && method === 'PUT') {
      const change = body.changes[0];
      mutations.push(change.operation);
      remote = change.operation === 'REMOVE' ? undefined : {
        itemId: change.itemId, specification: change.specification, checked: change.operation === 'TO_RECENTLY',
      };
      return new Response(null, { status: 204 });
    }
    if (path === yuvomiPath && method === 'GET') return Response.json({ data: local ? [local] : [] });
    if (path === yuvomiPath && method === 'POST') {
      mutations.push('POST');
      if (failYuvomiCreate) return new Response(null, { status: 503 });
      local = { ...body, id: 1, is_checked: 0 };
      return Response.json({ data: local }, { status: 201 });
    }
    assert.equal(path, 'api/v1/shopping/items/1');
    mutations.push(method);
    if (method === 'DELETE') {
      local = undefined;
      return Response.json({ ok: true });
    }
    assert.equal(method, 'PATCH');
    local = { ...local, ...body };
    return Response.json({ data: local });
  };
  return {
    bring: new BringRecipeClient({ email: 'ci@example.test', password: 'fake', baseUrl: 'http://localhost', fetchImpl }),
    yuvomi: new YuvomiClient({ baseUrl: 'http://localhost', apiToken: 'fake', fetchImpl }),
    bringList: 'ci', yuvomiList: '42', mutations,
  };
}

test('checks the full item lifecycle in both directions through the APIs', async () => {
  const fixture = fakeApis();
  await fixture.bring.login();
  await checkShoppingSync(fixture);
  assert.deepEqual(fixture.mutations, [
    'TO_PURCHASE', 'POST', 'TO_PURCHASE', 'PATCH', 'TO_RECENTLY', 'PATCH',
    'TO_PURCHASE', 'PATCH', 'REMOVE', 'DELETE',
    'POST', 'TO_PURCHASE', 'PATCH', 'TO_PURCHASE', 'PATCH', 'TO_RECENTLY',
    'PATCH', 'TO_PURCHASE', 'DELETE', 'REMOVE',
  ]);
  assert.deepEqual(await fixture.yuvomi.listShoppingItems('42'), []);
  assert.deepEqual(await fixture.bring.readList('ci'), { purchase: [], recently: [] });
});

test('refuses populated test lists before any write', async () => {
  const fixture = fakeApis({ populated: true });
  await fixture.bring.login();
  await assert.rejects(checkShoppingSync(fixture), /must be empty/);
  assert.deepEqual(fixture.mutations, []);
});

test('cleans the source item when mirroring fails', async () => {
  const fixture = fakeApis({ failYuvomiCreate: true });
  await fixture.bring.login();
  await assert.rejects(checkShoppingSync(fixture), /HTTP 503/);
  assert.deepEqual(fixture.mutations, ['TO_PURCHASE', 'POST', 'REMOVE']);
});

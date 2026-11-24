import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BringRecipeClient, exportBringRecipes } from './export-recipes.mjs';
import { importBringRecipes, YuvomiClient } from './import-recipes.mjs';

async function verify(read, expected, side) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const actual = await read();
    if (actual?.quantity === expected?.quantity && actual?.checked === expected?.checked) return actual;
    await delay(500);
  }
  throw new Error(`${side} did not return the expected shopping item state`);
}

export async function checkShoppingSync({ bring, yuvomi, bringList, yuvomiList }) {
  if (!/^[a-z0-9-]+$/i.test(bringList ?? '') || !/^[1-9][0-9]*$/.test(yuvomiList ?? '')) {
    throw new Error('Provide BRING_TEST_LIST_ID and YUVOMI_TEST_LIST_ID for dedicated test lists');
  }
  const name = `Yuvomi CI ${randomUUID().slice(0, 12)}`;
  const [remote, local] = await Promise.all([
    bring.readList(bringList), yuvomi.listShoppingItems(yuvomiList),
  ]);
  if (remote.purchase.length || remote.recently.length || local.length) {
    throw new Error('Both dedicated test lists must be empty before the sync check');
  }

  async function readBring() {
    const { purchase, recently } = await bring.readList(bringList);
    const active = purchase.find(item => item.itemId === name);
    if (active) return { quantity: active.specification ?? '', checked: false };
    const done = recently.find(item => item.itemId === name);
    return done && { quantity: done.specification ?? '', checked: true };
  }

  async function readYuvomi() {
    const items = await yuvomi.listShoppingItems(yuvomiList);
    const item = items.find(item => item.name === name);
    return item && { id: item.id, quantity: item.quantity ?? '', checked: Boolean(item.is_checked) };
  }

  async function writeBring(item) {
    const operation = !item ? 'REMOVE' : item.checked ? 'TO_RECENTLY' : 'TO_PURCHASE';
    await bring.changeListItem(bringList, name, item?.quantity ?? '', operation);
  }

  async function writeYuvomi(item) {
    const existing = await readYuvomi();
    if (!item) {
      if (existing) await yuvomi.changeShoppingItem(`items/${existing.id}`, 'DELETE');
      return;
    }
    if (!existing) {
      await yuvomi.changeShoppingItem(`${yuvomiList}/items`, 'POST', { name, quantity: item.quantity });
      return;
    }
    await yuvomi.changeShoppingItem(`items/${existing.id}`, 'PATCH', {
      quantity: item.quantity, is_checked: item.checked ? 1 : 0,
    });
  }

  const sides = [
    { name: 'Bring', read: readBring, write: writeBring },
    { name: 'Yuvomi', read: readYuvomi, write: writeYuvomi },
  ];
  let failure;
  try {
    for (const source of sides) {
      const target = sides.find(side => side !== source);
      for (const state of [
        { quantity: '1', checked: false }, { quantity: '2', checked: false },
        { quantity: '2', checked: true }, { quantity: '2', checked: false }, undefined,
      ]) {
        await source.write(state);
        const observed = await verify(source.read, state, source.name);
        await target.write(observed);
        await verify(target.read, state, target.name);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = await Promise.allSettled(sides.map(async side => {
      if (await side.read()) {
        await side.write(undefined);
        await verify(side.read, undefined, side.name);
      }
    }));
    if (cleanup.some(outcome => outcome.status === 'rejected')) {
      throw new Error(`Cleanup failed for "${name}" in the dedicated test lists`, { cause: failure });
    }
    if (failure) throw failure;
  }
}

async function main(operation) {
  if (!['bring-preview', 'bring-import', 'bring-sync-test'].includes(operation)) {
    throw new Error('Select bring-preview, bring-import, or bring-sync-test');
  }
  const config = JSON.parse(await text(process.stdin));
  const bringOptions = {
    email: config.BRING_EMAIL, password: config.BRING_PASSWORD, country: config.BRING_COUNTRY,
  };
  const yuvomiUrl = 'https://self-host.mattiss4you.de';
  if (operation === 'bring-sync-test') {
    const bring = new BringRecipeClient(bringOptions);
    await bring.login();
    await checkShoppingSync({
      bring, yuvomi: new YuvomiClient({ baseUrl: yuvomiUrl, apiToken: config.YUVOMI_API_TOKEN }),
      bringList: config.BRING_TEST_LIST_ID, yuvomiList: config.YUVOMI_TEST_LIST_ID,
    });
    process.stdout.write('Both directions passed add, quantity edit, check, uncheck, and remove.\n');
    return;
  }
  const exportData = await exportBringRecipes({ ...bringOptions, includeTemplates: true });
  const result = await importBringRecipes({
    exportData, yuvomiUrl, apiToken: config.YUVOMI_API_TOKEN,
    apply: operation === 'bring-import', rejectInvalid: operation === 'bring-import',
  });
  const { createdLinks, ...counts } = result;
  process.stdout.write(JSON.stringify({
    exportedRecipes: exportData.recipeCount, exportedTemplates: exportData.templateCount, ...counts,
  }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => {
    process.stderr.write(`Bring integration failed: ${error instanceof SyntaxError ? 'Invalid Secret Manager JSON' : error.message}\n`);
    process.exitCode = 1;
  });
}

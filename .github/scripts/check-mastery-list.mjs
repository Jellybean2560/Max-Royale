// Compares the app's hardcoded MASTERY_THIRD_SET against the Card Mastery wiki page.
//
// Cards with a 3rd mastery task set have 9 mastery levels; every other card has 6.
// The Clash Royale API doesn't expose that anywhere (it reports maxLevel 10 for
// every mastery), so the list has to be maintained by hand. The wiki is usually
// updated a few weeks after a new card ships, hence the monthly run.
//
// Writes a GitHub Actions output `changed=true/false` plus an `issue-body.md` when
// the lists differ. Never edits index.html — a human decides what to apply.

import { readFile, writeFile } from 'node:fs/promises';

const WIKI_API = 'https://clashroyale.fandom.com/api.php?action=parse&page=Card_Mastery&prop=wikitext&format=json';
const CARDS_API = 'https://quiet-frost-f9f0.jellevandenwouwer.workers.dev/cards';

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

async function getJson(url, what) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Max-Royale-mastery-check' } });
  if (!res.ok) throw new Error(`${what} returned HTTP ${res.status}`);
  return res.json();
}

// The list lives in a table under the line "Currently these are the cards that have
// a 3rd Card Mastery Task:" — pull every [[Card Name]] link that follows it.
function parseWikiList(wikitext) {
  const marker = /Currently these are the cards that have a 3rd Card Mastery Task:/i;
  const idx = wikitext.search(marker);
  if (idx === -1) throw new Error('marker sentence not found — the wiki page layout changed');
  const table = wikitext.slice(idx, wikitext.indexOf('|}', idx));
  if (!table) throw new Error('could not find the end of the card table');
  const names = [...table.matchAll(/\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/g)]
    .map(m => m[1].trim())
    .filter(n => !/^(Category|File|Image):/i.test(n));
  return [...new Set(names)];
}

function parseAppList(html) {
  const start = html.indexOf('const MASTERY_THIRD_SET');
  if (start === -1) throw new Error('MASTERY_THIRD_SET not found in index.html');
  const block = html.slice(start, html.indexOf('].map(', start));
  return [...block.matchAll(/'([^']+)'/g)].map(m => m[1]);
}

const fail = msg => { console.error(`FAILED: ${msg}`); process.exit(1); };

try {
  const [wikiJson, cardsJson, html] = await Promise.all([
    getJson(WIKI_API, 'Wiki API'),
    getJson(CARDS_API, 'Cards API'),
    readFile(new URL('../../index.html', import.meta.url), 'utf8')
  ]);

  const wikiNames = parseWikiList(wikiJson.parse.wikitext['*']);
  const appNames = parseAppList(html);
  const catalog = new Map((cardsJson.items || []).map(c => [norm(c.name), c.name]));

  // Sanity gates — a vandalised or restructured page should fail loudly, not
  // silently report that every card changed.
  if (wikiNames.length < 15) fail(`only ${wikiNames.length} cards parsed from the wiki; expected 15+`);
  const unknown = wikiNames.filter(n => !catalog.has(norm(n)));
  if (unknown.length) fail(`wiki names not in the live card catalog: ${unknown.join(', ')}`);

  // Compare on normalised names, report using the catalog's spelling.
  const wikiKeys = new Set(wikiNames.map(norm));
  const appKeys = new Set(appNames.map(norm));
  const toAdd = [...wikiKeys].filter(k => !appKeys.has(k)).map(k => catalog.get(k)).sort();
  const toRemove = [...appKeys].filter(k => !wikiKeys.has(k)).map(k => catalog.get(k) || k).sort();
  const changed = toAdd.length > 0 || toRemove.length > 0;

  console.log(`wiki: ${wikiNames.length} cards | app: ${appNames.length} cards`);
  console.log(`add: ${toAdd.join(', ') || '(none)'}`);
  console.log(`remove: ${toRemove.join(', ') || '(none)'}`);

  if (changed) {
    await writeFile('issue-body.md', [
      'The Card Mastery wiki page lists a different set of cards with a 3rd task set than `MASTERY_THIRD_SET` in `index.html`.',
      '',
      'Cards with a 3rd task set have **9** mastery levels; all others have **6**. Getting this wrong makes those cards show the wrong denominator and progress bar in the Badges tab.',
      '',
      `**Add:** ${toAdd.length ? toAdd.map(n => `\`${n}\``).join(', ') : '_(none)_'}`,
      `**Remove:** ${toRemove.length ? toRemove.map(n => `\`${n}\``).join(', ') : '_(none)_'}`,
      '',
      `Wiki lists ${wikiNames.length} cards, the app has ${appNames.length}. Every wiki name matched a card in the live \`/cards\` catalog.`,
      '',
      'Update `MASTERY_THIRD_SET` in `index.html` to match, then verify a card from each group shows the right `Lvl x/6` or `Lvl x/9` in the Badges tab.',
      '',
      `_Source: ${'https://clashroyale.fandom.com/wiki/Card_Mastery'} — checked automatically._`
    ].join('\n'));
  }

  await writeFile(process.env.GITHUB_OUTPUT || '/dev/null', `changed=${changed}\n`, { flag: 'a' });
} catch (err) {
  fail(err.message);
}

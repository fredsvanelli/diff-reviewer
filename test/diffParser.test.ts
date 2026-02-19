import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff, splitHunks } from '../src/git/diffParser';

const __dirname =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

describe('parseDiff', () => {
  it('parses a simple single-file, single-hunk diff', () => {
    const raw = readFileSync(join(fixturesDir, 'simple.diff'), 'utf-8');
    const files = parseDiff(raw);

    assert.equal(files.length, 1);
    const file = files[0];
    assert.equal(file.oldPath, 'hello.txt');
    assert.equal(file.newPath, 'hello.txt');
    assert.equal(file.isBinary, false);
    assert.equal(file.hunks.length, 1);

    const hunk = file.hunks[0];
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.oldCount, 3);
    assert.equal(hunk.newStart, 1);
    assert.equal(hunk.newCount, 4);

    // Check line types
    const types = hunk.lines.map((l) => l.type);
    assert.deepEqual(types, ['context', 'remove', 'add', 'add', 'context']);

    // Check content
    assert.equal(hunk.lines[0].content, 'hello');
    assert.equal(hunk.lines[1].content, 'world');
    assert.equal(hunk.lines[2].content, 'beautiful world');
    assert.equal(hunk.lines[3].content, 'today');
    assert.equal(hunk.lines[4].content, 'end');

    // rawLines should include the @@ header
    assert.ok(hunk.rawLines[0].startsWith('@@'));
  });

  it('parses a multi-file, multi-hunk diff', () => {
    const raw = readFileSync(join(fixturesDir, 'multi-hunk.diff'), 'utf-8');
    const files = parseDiff(raw);

    assert.equal(files.length, 2);

    // First file: src/app.ts with 2 hunks
    const app = files[0];
    assert.equal(app.newPath, 'src/app.ts');
    assert.equal(app.hunks.length, 2);

    // First hunk
    assert.equal(app.hunks[0].oldStart, 1);
    assert.equal(app.hunks[0].newStart, 1);
    const hunk0Removes = app.hunks[0].lines.filter((l) => l.type === 'remove');
    assert.equal(hunk0Removes.length, 1);
    assert.ok(hunk0Removes[0].content.includes('const app = express()'));

    // Second hunk
    assert.equal(app.hunks[1].oldStart, 10);
    const hunk1Adds = app.hunks[1].lines.filter((l) => l.type === 'add');
    assert.ok(hunk1Adds.length >= 1);

    // Second file: README.md with 1 hunk
    const readme = files[1];
    assert.equal(readme.newPath, 'README.md');
    assert.equal(readme.hunks.length, 1);
  });

  it('handles empty input', () => {
    const files = parseDiff('');
    assert.equal(files.length, 0);
  });

  it('preserves rawLines for patch reconstruction', () => {
    const raw = readFileSync(join(fixturesDir, 'simple.diff'), 'utf-8');
    const files = parseDiff(raw);
    const hunk = files[0].hunks[0];

    // rawLines should contain: @@ header + all content lines
    assert.ok(hunk.rawLines.length >= 6); // @@ + 5 content lines
    assert.ok(hunk.rawLines[0].startsWith('@@'));
    // Every non-header raw line should start with +, -, or space
    for (let i = 1; i < hunk.rawLines.length; i++) {
      const ch = hunk.rawLines[i][0];
      assert.ok(['+', '-', ' '].includes(ch), `rawLine ${i} starts with '${ch}'`);
    }
  });

  it('parses binary file indicator', () => {
    const raw = `diff --git a/image.png b/image.png
index 1234..5678
Binary files a/image.png and b/image.png differ
`;
    const files = parseDiff(raw);
    assert.equal(files.length, 1);
    assert.equal(files[0].isBinary, true);
  });
});

describe('splitHunks', () => {
  it('splits a hunk with two change groups separated by context', () => {
    const hunks = splitHunks([
      {
        oldStart: 16,
        oldCount: 8,
        newStart: 16,
        newCount: 9,
        header: '@@ -16,8 +16,9 @@',
        lines: [
          { type: 'context', content: 'line16' },
          { type: 'context', content: 'line17' },
          { type: 'add', content: 'line18new' },
          { type: 'add', content: 'line19new' },
          { type: 'context', content: 'line20' },
          { type: 'context', content: 'line21' },
          { type: 'remove', content: 'line22old' },
          { type: 'add', content: 'line22new' },
          { type: 'context', content: 'line23' },
        ],
        rawLines: [
          '@@ -16,8 +16,9 @@',
          ' line16',
          ' line17',
          '+line18new',
          '+line19new',
          ' line20',
          ' line21',
          '-line22old',
          '+line22new',
          ' line23',
        ],
      },
    ]);

    assert.equal(hunks.length, 2);

    // First sub-hunk: pure insertion at new lines 18-19
    assert.equal(hunks[0].newStart, 18);
    assert.equal(hunks[0].newCount, 2);
    assert.equal(hunks[0].oldCount, 0);
    assert.equal(hunks[0].lines.length, 2);
    assert.deepEqual(
      hunks[0].lines.map((l) => l.type),
      ['add', 'add'],
    );

    // Second sub-hunk: replace at new line 22
    assert.equal(hunks[1].newStart, 22);
    assert.equal(hunks[1].newCount, 1);
    assert.equal(hunks[1].oldCount, 1);
    assert.equal(hunks[1].lines.length, 2);
    assert.deepEqual(
      hunks[1].lines.map((l) => l.type),
      ['remove', 'add'],
    );
  });

  it('does not split a hunk with only one change group', () => {
    const hunks = splitHunks([
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        header: '@@ -1,3 +1,4 @@',
        lines: [
          { type: 'context', content: 'hello' },
          { type: 'remove', content: 'world' },
          { type: 'add', content: 'beautiful world' },
          { type: 'add', content: 'today' },
          { type: 'context', content: 'end' },
        ],
        rawLines: ['@@ -1,3 +1,4 @@', ' hello', '-world', '+beautiful world', '+today', ' end'],
      },
    ]);

    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].lines.length, 3); // remove + 2 adds (context stripped)
  });

  it('produces valid rawLines for git apply', () => {
    const hunks = splitHunks([
      {
        oldStart: 5,
        oldCount: 4,
        newStart: 5,
        newCount: 5,
        header: '@@ -5,4 +5,5 @@',
        lines: [
          { type: 'add', content: 'inserted' },
          { type: 'context', content: 'middle' },
          { type: 'remove', content: 'old' },
          { type: 'add', content: 'new' },
        ],
        rawLines: ['@@ -5,4 +5,5 @@', '+inserted', ' middle', '-old', '+new'],
      },
    ]);

    assert.equal(hunks.length, 2);

    // Each sub-hunk rawLines should start with @@ header
    for (const h of hunks) {
      assert.ok(h.rawLines[0].startsWith('@@'), `rawLines[0] = ${h.rawLines[0]}`);
      // Non-header lines should start with + or -
      for (let i = 1; i < h.rawLines.length; i++) {
        const ch = h.rawLines[i][0];
        assert.ok(['+', '-'].includes(ch), `rawLine ${i} starts with '${ch}'`);
      }
    }
  });

  it('handles pure deletion group', () => {
    const hunks = splitHunks([
      {
        oldStart: 10,
        oldCount: 4,
        newStart: 10,
        newCount: 2,
        header: '@@ -10,4 +10,2 @@',
        lines: [
          { type: 'context', content: 'keep' },
          { type: 'remove', content: 'gone1' },
          { type: 'remove', content: 'gone2' },
          { type: 'context', content: 'keep2' },
        ],
        rawLines: ['@@ -10,4 +10,2 @@', ' keep', '-gone1', '-gone2', ' keep2'],
      },
    ]);

    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldCount, 2);
    assert.equal(hunks[0].newCount, 0);
    assert.equal(hunks[0].newStart, 11); // position after "keep" line
  });
});

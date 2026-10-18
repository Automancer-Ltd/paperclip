import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const dockerWorkflow = '.github/workflows/docker.yml';
const stepMarker = '      - name: Compute lowercase image repository\n';

/**
 * A registry reference must be lowercase, and `github.repository` keeps the
 * owner's casing. A fork under `Automancer-Ltd` therefore fails buildx setup
 * with "invalid reference format: repository name (Automancer-Ltd/paperclip)
 * must be lowercase" before any layer builds. docker/metadata-action lowercases
 * `images` on its own, but the `cache-from`/`cache-to` refs reach buildx
 * verbatim, so they must use the lowercased slug instead.
 */
test('docker workflow lowercases the registry cache refs it passes to buildx', async () => {
  const contents = await readFile(dockerWorkflow, 'utf8');

  const cacheRefs = contents.match(/^\s*cache-(?:from|to):[^\n]*$/gm) ?? [];
  assert.ok(cacheRefs.length >= 4, 'docker.yml must declare both cache refs in both build jobs');

  for (const ref of cacheRefs) {
    assert.doesNotMatch(
      ref,
      /\$\{\{\s*github\.repository\s*\}\}/,
      `cache ref must not use the case-preserving repository slug: ${ref.trim()}`
    );
    assert.match(
      ref,
      /ref=ghcr\.io\/\$\{\{ steps\.image-repo\.outputs\.repository \}\}:/,
      `cache ref must use the lowercased repository slug: ${ref.trim()}`
    );
  }
});

test('the lowercase step emits a registry-safe slug for a mixed-case owner', async () => {
  const contents = await readFile(dockerWorkflow, 'utf8');
  const blocks = contents.split(stepMarker).slice(1);
  assert.equal(blocks.length, 2, 'both build jobs must run the lowercase-slug step');

  for (const block of blocks) {
    const step = block.split('\n      - name: ')[0];
    assert.match(step, /^ {8}id: image-repo\n/m, 'the step needs the id the cache refs reference');
    assert.match(step, /^ {10}REPOSITORY: \$\{\{ github\.repository \}\}$/m, 'the step reads the repository slug from the context');

    const runLine = step.split('\n').find((line) => line.trimStart().startsWith('run:'));
    assert.ok(runLine, 'the step must define a run command');

    const outputFile = path.join(mkdtempSync(path.join(tmpdir(), 'registry-ref-')), 'github-output');
    execFileSync('bash', ['-c', runLine.trimStart().slice('run:'.length)], {
      env: { ...process.env, REPOSITORY: 'Automancer-Ltd/paperclip', GITHUB_OUTPUT: outputFile },
      stdio: 'pipe',
    });

    assert.equal(
      readFileSync(outputFile, 'utf8').trim(),
      'repository=automancer-ltd/paperclip',
      'the step must lowercase the owner so the ref is valid for the registry'
    );
  }
});

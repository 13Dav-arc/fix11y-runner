import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runPatchJob } from '../src/patch-job.js';
import { formatPrBody } from '../src/pr-formatter.js';

test('deterministic fallback - applies safe and caution rules cleanly without GEMINI_API_KEY', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix11y-fallback-test-'));
  const artifactDir = path.join(tmpDir, 'workspace-artifact');

  try {
    // Create HTML fixture with both safe and caution violations
    const htmlFixture = `<!DOCTYPE html>
<html>
<body>
  <!-- Safe violation: missing alt on decorative divider -->
  <img src="decorative-divider.png">

  <!-- Caution violation: button semantics -->
  <div onclick="doSomething()">Click Me</div>
</body>
</html>`;

    fs.writeFileSync(path.join(tmpDir, 'index.html'), htmlFixture, 'utf-8');

    // Run patch job with NO Gemini API key
    const result = await runPatchJob({
      targetDir: tmpDir,
      artifactDir,
      geminiApiKey: '', // explicitly empty
      payload: { runId: 'test-fallback-run', sha: '1234567890abcdef' },
    });

    assert.equal(result.hasPatches, true);
    assert.ok(result.appliedPatches.length >= 2, 'Should apply both safe and caution deterministic patches');

    const patchedHtml = fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf-8');
    assert.match(patchedHtml, /alt=""/, 'Safe rule (img-alt) was applied');
    assert.match(patchedHtml, /<button/i, 'Caution rule (button-semantics) was applied');

    // Check manifest artifact
    const manifestRaw = fs.readFileSync(path.join(artifactDir, 'patch-manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.runId, 'test-fallback-run');
    assert.ok(manifest.appliedPatches.some(p => p.safety === 'safe'));
    assert.ok(manifest.appliedPatches.some(p => p.safety === 'caution'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('pr-formatter - renders explicit missing-key notice for unresolved AI issues', () => {
  const prBody = formatPrBody({
    commitSha: 'a1b2c3d4e5f6',
    appliedPatches: [
      {
        file: 'templates/hero.html',
        ruleId: 'img-alt',
        wcag: '1.1.1',
        safety: 'safe',
        message: 'Injected decorative alt attribute',
        line: 10,
      },
    ],
    unresolvedAiIssues: [
      {
        file: 'templates/chart.html',
        ruleId: 'complex-graphic-alt',
        wcag: '1.1.1',
        message: 'Informative SVG requires contextual description',
        line: 25,
      },
    ],
    diffSummary: '+ <img src="hero.jpg" alt="">',
    testSummary: '5 passed',
  });

  // Check safety badge
  assert.match(prBody, /🟢 `safe`/);

  // Check fallback notice header & table
  assert.match(prBody, /AI-Assisted Remediation Notice/);
  assert.match(prBody, /The following violation\(s\) were detected but require AI assistance/);
  assert.match(prBody, /They were not auto-patched because `GEMINI_API_KEY` was not configured/);
  assert.match(prBody, /templates\/chart\.html/);
  assert.match(prBody, /complex-graphic-alt/);
  assert.match(prBody, /Awaiting human review or Gemini API key/);
});

test('pr-formatter - renders manual review notice for zero-patch caution issues (e.g. unknown classification)', () => {
  const prBody = formatPrBody({
    commitSha: 'b2c3d4e5f6a1',
    appliedPatches: [
      {
        file: 'index.html',
        ruleId: 'img-alt',
        wcag: '1.1.1',
        safety: 'safe',
        message: 'Decorative <img> element is missing an "alt" attribute.',
        line: 12,
      },
    ],
    unresolvedAiIssues: [
      {
        file: 'index.html',
        ruleId: 'img-alt',
        wcag: '1.1.1',
        safety: 'caution',
        message: '<img> element has no alt attribute and cannot be deterministically classified as decorative or meaningful.',
        line: 45,
        requiresAi: false,
      },
    ],
    diffSummary: '+ <img src="divider.png" alt="">',
    testSummary: 'All tests passed cleanly',
  });

  // Overview table should show manual review item
  assert.match(prBody, /Manual Review Items \(No Patch\)/);
  assert.match(prBody, /1/);

  // Manual Review section
  assert.match(prBody, /### ⚠️ Manual Review Items \(No Auto-Patch Applied\)/);
  assert.match(prBody, /cannot be deterministically classified as decorative or meaningful/);
  assert.match(prBody, /Manual review required \(no auto-patch\)/);
});


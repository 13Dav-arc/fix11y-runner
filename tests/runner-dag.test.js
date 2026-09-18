import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runResolveJob } from '../src/resolve-job.js';

test('runner DAG - Branch 1: Patch job fails outright before setting has_patches', async () => {
  const checkUpdates = [];
  const mockOctokit = {
    updateCheckRun: async (params) => {
      checkUpdates.push(params);
      return { id: 123 };
    },
    createPullRequest: async () => {
      assert.fail('Pull request should NOT be opened when patch job fails');
    },
  };

  const result = await runResolveJob({
    payload: { owner: 'acme', repo: 'web-app', sha: 'abc1234', checkRunId: 999 },
    patchResult: 'failure',
    verifyResult: 'skipped',
    hasPatches: false,
    octokit: mockOctokit,
    token: 'mock-token',
  });

  assert.equal(result.status, 'failure');
  assert.equal(result.category, 'pipeline_error');
  assert.equal(checkUpdates.length, 1);
  assert.equal(checkUpdates[0].conclusion, 'failure');
  assert.equal(checkUpdates[0].output.title, 'fix11y: Audit pipeline error');
  assert.match(checkUpdates[0].output.summary, /internal infrastructure error/i);
});

test('runner DAG - Branch 2: Zero violations path resolves Check Run to success', async () => {
  const checkUpdates = [];
  const mockOctokit = {
    updateCheckRun: async (params) => {
      checkUpdates.push(params);
      return { id: 123 };
    },
    createPullRequest: async () => {
      assert.fail('Pull request should NOT be opened when there are zero violations');
    },
  };

  const result = await runResolveJob({
    payload: { owner: 'acme', repo: 'web-app', sha: 'abc1234', checkRunId: 999 },
    patchResult: 'success',
    verifyResult: 'skipped',
    hasPatches: false,
    octokit: mockOctokit,
    token: 'mock-token',
  });

  assert.equal(result.status, 'success');
  assert.equal(result.category, 'none');
  assert.equal(result.zeroViolations, true);
  assert.equal(checkUpdates.length, 1);
  assert.equal(checkUpdates[0].conclusion, 'success');
  assert.equal(checkUpdates[0].output.title, 'fix11y: No accessibility violations found');
  assert.match(checkUpdates[0].output.summary, /No remediation patches required/i);
});

test('runner DAG - Branch 3: Verification harness failure (missing manifest) attributes to pipeline_error', async () => {
  const checkUpdates = [];
  const mockOctokit = {
    updateCheckRun: async (params) => {
      checkUpdates.push(params);
      return { id: 123 };
    },
    createPullRequest: async () => {
      assert.fail('Pull request should NOT be opened on harness error');
    },
  };

  // Temp folder with NO verification-result.json
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix11y-test-'));
  const origCwd = process.cwd();

  try {
    process.chdir(tmpDir);
    const result = await runResolveJob({
      payload: { owner: 'acme', repo: 'web-app', sha: 'abc1234', checkRunId: 999 },
      patchResult: 'success',
      verifyResult: 'failure',
      hasPatches: true,
      octokit: mockOctokit,
      token: 'mock-token',
    });

    assert.equal(result.status, 'failure');
    assert.equal(result.category, 'pipeline_error');
    assert.equal(checkUpdates.length, 1);
    assert.equal(checkUpdates[0].conclusion, 'failure');
    assert.equal(checkUpdates[0].output.title, 'fix11y: Verification harness error');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runner DAG - Branch 4: Target repo test failure attributes to test_failure and suppresses PR', async () => {
  const checkUpdates = [];
  let prCreated = false;
  const mockOctokit = {
    updateCheckRun: async (params) => {
      checkUpdates.push(params);
      return { id: 123 };
    },
    createPullRequest: async () => {
      prCreated = true;
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix11y-test-'));
  const origCwd = process.cwd();

  try {
    process.chdir(tmpDir);
    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync(
      path.join('artifacts', 'verification-result.json'),
      JSON.stringify({
        success: false,
        category: 'test_failure',
        exitCode: 1,
        summary: 'Target repository tests failed with exit code 1.',
        logExcerpt: 'FAIL: Button component click handler broke',
      }),
      'utf-8'
    );

    const result = await runResolveJob({
      payload: { owner: 'acme', repo: 'web-app', sha: 'abc1234', checkRunId: 999 },
      patchResult: 'success',
      verifyResult: 'failure',
      hasPatches: true,
      octokit: mockOctokit,
      token: 'mock-token',
    });

    assert.equal(result.status, 'failure');
    assert.equal(result.category, 'test_failure');
    assert.equal(prCreated, false, 'PR MUST NOT be created when tests fail');
    assert.equal(checkUpdates.length, 1);
    assert.equal(checkUpdates[0].conclusion, 'failure');
    assert.equal(checkUpdates[0].output.title, 'fix11y: Test verification failed');
    assert.match(checkUpdates[0].output.summary, /To prevent breaking changes, no pull request was created/i);
    assert.match(checkUpdates[0].output.text, /FAIL: Button component click handler broke/);
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runner DAG - Branch 5: Verified success opens PR and resolves Check Run to success', async () => {
  const checkUpdates = [];
  const prCalls = [];
  const mockOctokit = {
    updateCheckRun: async (params) => {
      checkUpdates.push(params);
      return { id: 123 };
    },
    createPullRequest: async (params) => {
      prCalls.push(params);
      return { html_url: 'https://github.com/acme/web-app/pull/42' };
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix11y-test-'));
  const origCwd = process.cwd();

  try {
    process.chdir(tmpDir);
    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync(
      path.join('artifacts', 'verification-result.json'),
      JSON.stringify({
        success: true,
        category: 'none',
        exitCode: 0,
        summary: 'Target repository tests passed cleanly (exit code 0).',
      }),
      'utf-8'
    );

    fs.writeFileSync(
      path.join('artifacts', 'patch-manifest.json'),
      JSON.stringify({
        commitSha: 'fedcba987654321',
        appliedPatches: [
          {
            file: 'src/index.html',
            ruleId: 'img-alt',
            wcag: '1.1.1',
            safety: 'safe',
            message: 'Injected decorative alt attribute',
            line: 5,
          },
          {
            file: 'src/components/card.html',
            ruleId: 'button-semantics',
            wcag: '4.1.2',
            safety: 'caution',
            message: 'Replaced non-semantic div with button',
            line: 12,
          },
        ],
        unresolvedAiIssues: [],
        diffSummary: '--- a/src/index.html\n+++ b/src/index.html\n@@ -5 +5 @@\n-<img src="a.jpg">\n+<img src="a.jpg" alt="">',
      }),
      'utf-8'
    );

    const result = await runResolveJob({
      payload: { owner: 'acme', repo: 'web-app', sha: 'fedcba987654321', checkRunId: 999 },
      patchResult: 'success',
      verifyResult: 'success',
      hasPatches: true,
      octokit: mockOctokit,
      token: 'mock-token',
    });

    assert.equal(result.status, 'success');
    assert.equal(result.category, 'none');
    assert.equal(prCalls.length, 1);
    assert.equal(prCalls[0].head, 'fix11y/remediation-fedcba9');
    assert.match(prCalls[0].body, /Total Surgical Patches Applied/);
    assert.match(prCalls[0].body, /🟢 `safe`/);
    assert.match(prCalls[0].body, /🟡 `caution`/);

    assert.equal(checkUpdates.length, 1);
    assert.equal(checkUpdates[0].conclusion, 'success');
    assert.equal(checkUpdates[0].output.title, 'fix11y: Accessibility remediations verified & PR opened');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

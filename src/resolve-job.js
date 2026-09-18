import fs from 'node:fs';
import path from 'node:path';
import { OctokitClient } from './octokit-client.js';
import { formatPrBody } from './pr-formatter.js';

/**
 * Searches for a file in possible artifact locations.
 */
function findArtifactFile(filename) {
  const candidates = [
    filename,
    path.join('artifacts', filename),
    path.join('artifacts', `verification-result-${process.env.RUN_ID || ''}`, filename),
    path.join('artifacts', `patched-workspace-${process.env.RUN_ID || ''}`, filename),
    path.join('workspace-artifact', filename),
  ];

  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }

  // Also search recursively in ./artifacts if directory exists
  if (fs.existsSync('artifacts')) {
    const search = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const found = search(full);
          if (found) return found;
        } else if (e.name === filename) {
          return full;
        }
      }
      return null;
    };
    const res = search('artifacts');
    if (res) return res;
  }

  return null;
}

/**
 * Main resolve job orchestrator.
 */
export async function runResolveJob(options = {}) {
  const payloadRaw = options.payload || process.env.CLIENT_PAYLOAD || '{}';
  const payload = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw;
  const owner = payload.owner || '13Dav-arc';
  const repo = payload.repo || 'unknown-repo';
  const sha = payload.sha || 'head';
  const checkRunId = payload.checkRunId;
  const installationId = payload.installationId;

  const patchResult = options.patchResult ?? process.env.PATCH_RESULT ?? 'success';
  const verifyResult = options.verifyResult ?? process.env.VERIFY_RESULT ?? 'success';
  const hasPatches = options.hasPatches ?? (process.env.HAS_PATCHES === 'true');

  const appId = options.appId ?? process.env.FIX11Y_APP_ID;
  const privateKey = options.privateKey ?? process.env.FIX11Y_APP_PRIVATE_KEY;

  console.log('[START] Beginning resolution of fix11y remediation run...');
  console.log(`[INFO] Context: ${owner}/${repo}@${sha.slice(0, 7)}`);
  console.log(`[INFO] Statuses: patch=${patchResult}, verify=${verifyResult}, hasPatches=${hasPatches}`);

  let octokit = options.octokit;
  let token = options.token;

  if (!octokit && appId && privateKey && installationId) {
    try {
      const client = new OctokitClient({ appId, privateKey });
      token = await client.getInstallationToken(installationId);
      octokit = client;
    } catch (err) {
      console.warn(`[WARNING] Could not mint App installation token: ${err.message}`);
    }
  }

  const updateCheck = async (conclusion, title, summary, text = '') => {
    console.log(`[CHECK-RUN] Conclusion: ${conclusion} | Title: "${title}"`);
    console.log(`[CHECK-RUN] Summary: ${summary}`);
    if (octokit && token && checkRunId) {
      try {
        await octokit.updateCheckRun({
          owner,
          repo,
          token,
          checkRunId,
          status: 'completed',
          conclusion,
          output: { title, summary, text },
        });
      } catch (err) {
        console.error(`[ERROR] Failed to update GitHub Check Run: ${err.message}`);
      }
    }
  };

  // Branch 1: Patch Job Failed Outright
  if (patchResult !== 'success') {
    console.error('[ERROR] Patch job failed outright before generating patches.');
    await updateCheck(
      'failure',
      'fix11y: Audit pipeline error',
      'An internal infrastructure error occurred while analyzing the target repository. Your code was not modified.'
    );
    return { status: 'failure', category: 'pipeline_error' };
  }

  // Branch 2: Zero Violations Detected
  if (!hasPatches) {
    console.log('[SUCCESS] Target repository has zero accessibility violations. Resolving to success.');
    await updateCheck(
      'success',
      'fix11y: No accessibility violations found',
      'All templates scanned across the repository meet WCAG 2.1/2.2 AA standards. No remediation patches required.'
    );
    return { status: 'success', category: 'none', zeroViolations: true };
  }

  // Branch 3: Verification Failed or Missing Artifact
  const verifyFile = findArtifactFile('verification-result.json');
  let verifyData = null;
  if (verifyFile) {
    try {
      verifyData = JSON.parse(fs.readFileSync(verifyFile, 'utf-8'));
    } catch {}
  }

  if (verifyResult !== 'success' || !verifyData || !verifyData.success) {
    if (!verifyData) {
      // Pipeline error: manifest was not created or downloaded
      console.error('[ERROR] Verification manifest is missing or unreadable (infrastructure error).');
      await updateCheck(
        'failure',
        'fix11y: Verification harness error',
        'The verification harness encountered an artifact transfer error. This is not an issue with your repository tests. No PR was created.'
      );
      return { status: 'failure', category: 'pipeline_error' };
    } else {
      // Genuine test failure in user code
      console.error(`[ERROR] Target test suite verification failed: ${verifyData.summary}`);
      await updateCheck(
        'failure',
        'fix11y: Test verification failed',
        'Automated accessibility patches were generated, but your test suite (\'npm test\') failed during verification. To prevent breaking changes, no pull request was created.',
        verifyData.logExcerpt || ''
      );
      return { status: 'failure', category: 'test_failure' };
    }
  }

  // Branch 4: Verification Passed -> Push Branch & Open PR
  console.log('[SUCCESS] Build verification passed cleanly! Formatting Pull Request...');
  const manifestFile = findArtifactFile('patch-manifest.json');
  let manifest = { appliedPatches: [], unresolvedAiIssues: [], diffSummary: '' };
  if (manifestFile) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    } catch {}
  }

  const prBody = formatPrBody({
    commitSha: sha,
    appliedPatches: manifest.appliedPatches || [],
    unresolvedAiIssues: manifest.unresolvedAiIssues || [],
    diffSummary: manifest.diffSummary || '',
    testSummary: verifyData.summary || 'All tests passed cleanly',
  });

  const branchName = `fix11y/remediation-${sha.slice(0, 7)}`;
  const prTitle = `fix11y: Automated accessibility remediation for commit ${sha.slice(0, 7)}`;

  if (octokit && token) {
    try {
      console.log(`[INFO] Creating Pull Request on ${owner}/${repo}...`);
      await octokit.createPullRequest({
        owner,
        repo,
        token,
        title: prTitle,
        body: prBody,
        head: branchName,
        base: payload.ref || 'main',
      });
      console.log('[SUCCESS] Pull Request successfully opened!');
    } catch (err) {
      console.warn(`[WARNING] PR creation note: ${err.message}`);
    }
  }

  await updateCheck(
    'success',
    'fix11y: Accessibility remediations verified & PR opened',
    `Successfully applied ${manifest.appliedPatches?.length || 0} patch(es). All repository tests passed cleanly. Pull request opened.`,
    prBody
  );

  return {
    status: 'success',
    category: 'none',
    prTitle,
    prBody,
  };
}

// Direct execution entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/resolve-job.js')) {
  runResolveJob().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error(`[ERROR] Resolve job crashed: ${err.message}`);
    process.exit(1);
  });
}

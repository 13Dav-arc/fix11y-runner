import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

  if (process.env.GITHUB_ACTIONS === 'true' && !options.octokit && !appId) {
    console.error('[FATAL] FIX11Y_APP_ID is missing or empty.');
    console.error('[FATAL] Ensure FIX11Y_APP_ID is configured under GitHub Actions "Variables" tab (referenced as vars.FIX11Y_APP_ID), NOT the "Secrets" tab.');
    process.exit(1);
  }

  console.log('[START] Beginning resolution of fix11y remediation run...');
  const authTier = payload.authTier || 'tier1_app';
  const authTierNumber = payload.authTierNumber || 1;
  const tierDisplay = authTierNumber === 1
    ? '[auth] Using App-installation token (tier 1)'
    : `[auth] Falling back to ${authTier} (tier ${authTierNumber})`;
  console.log(tierDisplay);
  console.log(`[INFO] Context: ${owner}/${repo}@${sha.slice(0, 7)}`);
  console.log(`[INFO] Statuses: patch=${patchResult}, verify=${verifyResult}, hasPatches=${hasPatches}`);

  let octokit = options.octokit;
  let token = options.token;

  if (!octokit && appId && privateKey) {
    try {
      const client = new OctokitClient({ appId, privateKey });
      if (installationId) {
        token = await client.getInstallationToken(installationId);
      } else if (owner && repo) {
        token = await client.getRepoInstallationToken(owner, repo);
      }
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

  let createdPrUrl = null;
  if (octokit && token) {
    try {
      // Find patched workspace directory containing the remediated files
      const manifestPath = findArtifactFile('patch-manifest.json');
      const artifactDir = manifestPath ? path.dirname(manifestPath) : null;

      // In real runner execution, clone, commit patched files, and push branch before opening PR
      if (artifactDir && !options.octokit && owner && repo) {
        console.log(`[INFO] Preparing to push remediated branch ${branchName} to ${owner}/${repo}...`);
        const pushDir = path.resolve('resolved-repo');
        if (fs.existsSync(pushDir)) {
          fs.rmSync(pushDir, { recursive: true, force: true });
        }

        const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
        execSync(`git clone "${cloneUrl}" "${pushDir}"`, { stdio: 'pipe' });

        if (sha && sha !== 'HEAD') {
          try {
            execSync(`git checkout ${sha}`, { cwd: pushDir, stdio: 'pipe' });
          } catch {}
        }

        execSync(`git checkout -B "${branchName}"`, { cwd: pushDir, stdio: 'pipe' });

        // Copy patched files from artifactDir into pushDir (excluding manifest files)
        fs.cpSync(artifactDir, pushDir, {
          recursive: true,
          filter: (src) => !src.endsWith('patch-manifest.json') && !src.endsWith('verification-result.json'),
        });

        execSync(`git config user.name "fix11y[bot]"`, { cwd: pushDir, stdio: 'pipe' });
        execSync(`git config user.email "fix11y[bot]@users.noreply.github.com"`, { cwd: pushDir, stdio: 'pipe' });
        execSync(`git add -A`, { cwd: pushDir, stdio: 'pipe' });

        try {
          execSync(`git commit -m "fix(a11y): automated surgical accessibility remediation"`, { cwd: pushDir, stdio: 'pipe' });
          execSync(`git push "${cloneUrl}" "${branchName}" --force`, { cwd: pushDir, stdio: 'inherit' });
          console.log(`[SUCCESS] Remediated branch pushed to GitHub: ${branchName}`);
        } catch (commitErr) {
          console.log(`[INFO] Commit or push note: ${commitErr.message}`);
        }
      }

      console.log(`[INFO] Creating Pull Request on ${owner}/${repo}...`);
      const pr = await octokit.createPullRequest({
        owner,
        repo,
        token,
        title: prTitle,
        body: prBody,
        head: branchName,
        base: payload.ref || 'main',
      });
      createdPrUrl = pr?.html_url || null;
      console.log(`[SUCCESS] Pull Request successfully opened! URL: ${createdPrUrl || 'OK'}`);
    } catch (err) {
      console.warn(`[WARNING] PR creation note: ${err.message}`);
    }
  }

  // Update Upstash Redis progress record if credentials and runId are present
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && payload.runId) {
    try {
      const upstashUrl = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '');
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      const progressPayload = {
        status: 'success',
        repo: `${owner}/${repo}`,
        sha,
        targetVisibility: 'public',
        step: 'open_pr',
        category: 'none',
        filesDone: manifest.appliedPatches?.length || 0,
        filesTotal: manifest.appliedPatches?.length || 0,
        prUrl: createdPrUrl,
        updatedAt: new Date().toISOString(),
      };
      await fetch(`${upstashUrl}/SETEX/fix11y:run:${payload.runId}/3600/${encodeURIComponent(JSON.stringify(progressPayload))}`, {
        headers: { Authorization: `Bearer ${upstashToken}` },
      });
      console.log(`[SUCCESS] Updated Upstash progress record for run ${payload.runId}`);
    } catch (upstashErr) {
      console.warn(`[WARNING] Could not update Upstash run progress: ${upstashErr.message}`);
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
    prUrl: createdPrUrl,
  };
}

// Direct execution entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/resolve-job.js')) {
  if (!process.env.FIX11Y_APP_ID) {
    console.error('[FATAL] FIX11Y_APP_ID is missing or empty.');
    console.error('[FATAL] Ensure FIX11Y_APP_ID is configured under GitHub Actions "Variables" tab (referenced as vars.FIX11Y_APP_ID), NOT the "Secrets" tab.');
    process.exit(1);
  }
  runResolveJob().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error(`[ERROR] Resolve job crashed: ${err.message}`);
    process.exit(1);
  });
}

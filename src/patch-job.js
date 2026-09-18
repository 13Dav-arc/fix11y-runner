import fs from 'node:fs';
import path from 'node:path';
import { parse, evaluateRules, applyPatches, createUnifiedDiff } from './core/index.js';

/**
 * Recursively finds all HTML and template files in a directory.
 */
function findTemplateFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
        findTemplateFiles(fullPath, fileList);
      }
    } else if (/\.(html|mustache|hbs)$/i.test(entry.name)) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

/**
 * Sets a step output for GitHub Actions.
 */
function setGithubOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

/**
 * Main patch job orchestrator.
 */
export async function runPatchJob(options = {}) {
  const payloadRaw = options.payload || process.env.CLIENT_PAYLOAD || '{}';
  const payload = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw;
  const targetDir = options.targetDir || payload.targetDirectory || '.';
  const geminiApiKey = options.geminiApiKey ?? process.env.GEMINI_API_KEY;

  if (process.env.GITHUB_ACTIONS === 'true' && !process.env.FIX11Y_APP_ID) {
    console.error('[FATAL] FIX11Y_APP_ID is missing or empty.');
    console.error('[FATAL] Ensure FIX11Y_APP_ID is configured under GitHub Actions "Variables" tab (referenced as vars.FIX11Y_APP_ID), NOT the "Secrets" tab.');
    process.exit(1);
  }

  console.log('[START] Beginning fix11y isolated audit and surgical patching...');
  console.log(`[INFO] Scanning directory: ${path.resolve(targetDir)}`);

  if (!geminiApiKey) {
    console.log('[INFO] No GEMINI_API_KEY detected — running in pure deterministic mode.');
  }

  const templateFiles = findTemplateFiles(targetDir);
  console.log(`[INFO] Found ${templateFiles.length} template file(s) to evaluate.`);

  const appliedPatches = [];
  const unresolvedAiIssues = [];
  let combinedDiff = '';

  for (const file of templateFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    const relativePath = path.relative(targetDir, file).replace(/\\/g, '/');

    // Sequential CST surgical patching with atomic in-memory re-parsing (Invariant 7)
    let hasMorePatches = true;
    let iteration = 0;
    const maxIterations = 50;

    while (hasMorePatches && iteration < maxIterations) {
      iteration++;
      const cst = parse(content);
      // Run element-scoped rules (safe and caution deterministic rules)
      const diagnostics = evaluateRules(cst, { scope: 'element' });

      // Identify first unapplied patchable violation
      let nextViolationToPatch = null;
      for (const diag of diagnostics) {
        if (!diag.patches || diag.patches.length === 0) {
          // AI-dependent or detection-only issue
          if (diag.requiresAi || diag.safety === 'review_needed') {
            if (!geminiApiKey && !unresolvedAiIssues.some(i => i.file === relativePath && i.ruleId === diag.ruleId)) {
              unresolvedAiIssues.push({
                file: relativePath,
                ruleId: diag.ruleId,
                wcag: diag.wcag,
                message: diag.message,
                line: diag.loc?.start?.line,
              });
            }
          }
          continue;
        }

        // Deterministic patch (safe or caution)
        nextViolationToPatch = diag;
        break;
      }

      if (!nextViolationToPatch) {
        hasMorePatches = false;
        break;
      }

      // Apply surgical patch to content
      const patchedContent = applyPatches(content, nextViolationToPatch.patches);
      if (patchedContent === content) {
        hasMorePatches = false;
        break;
      }

      appliedPatches.push({
        file: relativePath,
        ruleId: nextViolationToPatch.ruleId,
        wcag: nextViolationToPatch.wcag,
        safety: nextViolationToPatch.safety,
        message: nextViolationToPatch.message,
        line: nextViolationToPatch.loc?.start?.line,
      });

      content = patchedContent;
    }

    // If file was modified, write back to target workspace
    const originalContent = fs.readFileSync(file, 'utf-8');
    if (content !== originalContent) {
      fs.writeFileSync(file, content, 'utf-8');
      const fileDiff = createUnifiedDiff(originalContent, content, relativePath, relativePath);
      combinedDiff += (combinedDiff ? '\n' : '') + fileDiff;
    }
  }

  const hasPatches = appliedPatches.length > 0;
  setGithubOutput('has_patches', String(hasPatches));

  console.log(`[INFO] Audit complete. Applied patches: ${appliedPatches.length}, Deferred AI issues: ${unresolvedAiIssues.length}`);

  // Prepare artifact directory
  const artifactDir = options.artifactDir || path.resolve('workspace-artifact');
  if (hasPatches) {
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    const manifest = {
      runId: payload.runId || 'local-run',
      commitSha: payload.sha || 'head',
      appliedPatches,
      unresolvedAiIssues,
      diffSummary: combinedDiff,
      generatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(artifactDir, 'patch-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
    console.log(`[SUCCESS] Patched manifest written to ${artifactDir}/patch-manifest.json`);
  } else {
    console.log('[SUCCESS] Zero accessibility violations detected in target repository.');
  }

  return {
    hasPatches,
    appliedPatches,
    unresolvedAiIssues,
    diffSummary: combinedDiff,
  };
}

// Direct execution entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/patch-job.js')) {
  runPatchJob().catch((err) => {
    console.error(`[ERROR] Patch job failed: ${err.message}`);
    process.exit(1);
  });
}

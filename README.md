# fix11y-runner ⚡

> **Hardened 3-Job GitHub Actions Orchestration Runner for fix11y.**  
> Automatically triggered via `repository_dispatch` to audit, surgically patch, verify, and resolve accessibility remediations for public repositories.

---

## 🔒 3-Job Security Isolation Architecture

`fix11y-runner` implements a mathematically air-gapped 3-job workflow DAG:

```mermaid
flowchart TD
    Dispatch[repository_dispatch: fix11y-scan] --> Job1[1. Audit & Patch<br>Token: FIX11Y_APP_PRIVATE_KEY<br>ZERO target scripts executed<br>Timeout: 15m]
    Job1 -->|Artifact: workspace-artifact| Job2[2. Build Verification<br>Structural Zero-Access: permissions: {}<br>harden-runner: block<br>npm ci --ignore-scripts && npm test<br>Timeout: 10m]
    Job2 -->|Artifact: verification-result.json| Job3[3. Resolve & Open PR<br>Token: FIX11Y_APP_PRIVATE_KEY<br>Checks verify outcome<br>Timeout: 5m]
    Job3 -->|Success| PR[Push branch + Open Accessible PR<br>Check Run: conclusion: success]
    Job3 -->|Test Failure| Fail[No PR Created<br>Check Run: conclusion: failure]
```

### 1. Job 1: `patch` (Isolated Audit & CST Patching)
- **Permissions:** Ambient `permissions: { contents: read }`. Target repository operations use a scoped GitHub App installation token.
- **Invariant:** **Never executes any target repository code** (no `npm install`, no lifecycle hooks, no tests).
- **Execution:** Runs `@fix11y/core` with `scope: "element"` across `.html`, `.hbs`, and `.mustache` templates.
- **Deterministic Fallback:** When `GEMINI_API_KEY` is omitted, applies all deterministic `safe` and `caution` patches, and flags generative AI items for human review.

### 2. Job 2: `verify` (Untrusted Code Execution Boundary)
- **Permissions:** **`permissions: {}` (Structural Zero-Access Guarantee)**. No `GITHUB_TOKEN` exists in this runner VM.
- **Network Filtering:** `step-security/harden-runner` runs with `egress-policy: block`. Only `github.com:443`, `nodejs.org:443`, `registry.npmjs.org:443`, and Actions artifact storage are reachable (`api.github.com` is strictly blocked).
- **Lifecycle Protection:** Runs `npm ci --ignore-scripts` to block malicious postinstall/preinstall execution.
- **Bounded Runtime:** Hard platform timeout of 10 minutes (`timeout-minutes: 10`) with a 5-minute child process timeout.

### 3. Job 3: `resolve` (Check Run & PR Finalizer)
- **Permissions:** Ambient `permissions: { contents: read }`.
- **Categorized Error Attribution:**
  - **`pipeline_error`:** Infrastructure or artifact transfer failures are attributed to the runner, not the user's code.
  - **`test_failure`:** User test failures are surfaced with log excerpts; **PR creation is strictly suppressed**.
  - **`zero_violations`:** Resolves Check Run to `success` with `"No accessibility violations detected"`.
  - **`success`:** Pushes `fix11y/remediation-<sha>`, opens/updates PR, and resolves Check Run to `success`.

---

## 🛠️ Environment Configuration

| Variable / Secret | Type | Purpose |
| :--- | :--- | :--- |
| `FIX11Y_APP_PRIVATE_KEY` | Secret | GitHub App Private Key (PEM format) for target repo access |
| `FIX11Y_APP_ID` | Variable | GitHub App Client ID |
| `GEMINI_API_KEY` | Secret | Optional Google Gemini API key for AI-assisted image description |

---

## 🧪 Local Testing

Run the native test suite (zero external dependencies):

```bash
npm test
```

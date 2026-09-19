import crypto from 'node:crypto';

/**
 * Encodes a JavaScript object or string to base64url.
 * @param {object|string} obj
 * @returns {string}
 */
export function base64url(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Generates an RS256 JWT for GitHub App authentication.
 * @param {string} appId
 * @param {string} privateKeyPem
 * @returns {string}
 */
export function generateAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // 60 seconds clock skew tolerance
    exp: now + 540, // 9 minutes expiration
    iss: appId,
  };

  const encodedHeader = base64url(header);
  const encodedPayload = base64url(payload);
  const signInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  const signature = signer.sign(privateKeyPem, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signInput}.${signature}`;
}

/**
 * Native Node.js GitHub REST Client using fetch and node:crypto.
 * Zero external dependencies.
 */
export class OctokitClient {
  constructor({ appId, privateKey, baseUrl = 'https://api.github.com' } = {}) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.baseUrl = baseUrl;
    this.tokens = new Map(); // installationId -> { token, expiresAt }
  }

  /**
   * Returns a valid installation access token for the given installation ID.
   */
  async getInstallationToken(installationId) {
    if (!this.appId || !this.privateKey) {
      throw new Error('App ID and Private Key are required to mint installation tokens.');
    }

    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.token;
    }

    const jwt = generateAppJwt(this.appId, this.privateKey);
    const res = await fetch(`${this.baseUrl}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fix11y-runner/1.0',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to mint installation token (${res.status}): ${errText}`);
    }

    const data = await res.json();
    this.tokens.set(installationId, {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    });
    return data.token;
  }

  /**
   * Looks up repository installation and returns an installation access token.
   */
  async getRepoInstallationToken(owner, repo) {
    const jwt = generateAppJwt(this.appId, this.privateKey);
    const res = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/installation`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fix11y-runner/1.0',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to find installation for ${owner}/${repo} (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return await this.getInstallationToken(data.id);
  }

  /**
   * Updates an existing GitHub Check Run.
   */
  async updateCheckRun({ owner, repo, token, checkRunId, status, conclusion, output }) {
    const res = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fix11y-runner/1.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status,
        ...(conclusion ? { conclusion } : {}),
        ...(output ? { output } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to update Check Run ${checkRunId} (${res.status}): ${errText}`);
    }

    return await res.json();
  }

  /**
   * Opens or updates a GitHub Pull Request.
   */
  async createPullRequest({ owner, repo, token, title, body, head, base }) {
    const res = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fix11y-runner/1.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, head, base }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 422 && errText.toLowerCase().includes('already exists')) {
        const listRes = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'fix11y-runner/1.0',
          },
        });
        if (listRes.ok) {
          const openPrs = await listRes.json();
          if (openPrs.length > 0) {
            const updateRes = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/pulls/${openPrs[0].number}`, {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'fix11y-runner/1.0',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ title, body }),
            });
            if (updateRes.ok) return await updateRes.json();
            return openPrs[0];
          }
        }
      }
      throw new Error(`Failed to create Pull Request (${res.status}): ${errText}`);
    }

    return await res.json();
  }
}

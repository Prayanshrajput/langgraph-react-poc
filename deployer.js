import { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

// All env vars read lazily inside functions — ES module imports run before dotenv.config()
// so reading them at module level would get undefined values.

function octokit() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

export async function createGitHubRepo(projectId) {
  const repoName = `ai-preview-${projectId}`;
  const org = process.env.GITHUB_ORG;

  const { data } = org
    ? await octokit().repos.createInOrg({ org, name: repoName, private: false, auto_init: false })
    : await octokit().repos.createForAuthenticatedUser({ name: repoName, private: false, auto_init: false });

  return { repoName, cloneUrl: data.clone_url, htmlUrl: data.html_url, fullName: data.full_name };
}

export async function pushToGitHub(projectDir, cloneUrl, projectId) {
  // Authenticate with personal username (not org name) even when pushing to org repos
  const username = process.env.GITHUB_USERNAME;
  const token = process.env.GITHUB_TOKEN;
  const authedUrl = cloneUrl.replace('https://', `https://${username}:${token}@`);

  const git = simpleGit(projectDir);
  await git.init();
  await git.addConfig('user.email', 'ai-bot@yourapp.com');
  await git.addConfig('user.name', 'AI Bot');

  await fs.writeFile(path.join(projectDir, '.gitignore'), 'node_modules\ndist\n');

  await git.add('.');
  await git.commit(`feat: AI generated project ${projectId}`);

  try { await git.addRemote('origin', authedUrl); } catch {}
  await git.push('origin', 'main', ['--set-upstream', '--force']);
}

// ─── Cloudflare Pages direct upload ──────────────────────────────────────────

async function cfRequest(method, endpoint, body, isForm = false) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_TOKEN;

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body ?? undefined,
  });

  const data = await res.json();
  if (!data.success) throw new Error(`Cloudflare error: ${JSON.stringify(data.errors)}`);
  return data.result;
}

async function ensureCFProject(projectName) {
  try {
    return await cfRequest('GET', `/pages/projects/${projectName}`);
  } catch {
    return await cfRequest('POST', `/pages/projects`, JSON.stringify({
      name: projectName,
      production_branch: 'main',
    }));
  }
}

export async function deployToCloudflarePages(distDir, projectId) {
  const projectName = `ai-preview-${projectId}`;
  await ensureCFProject(projectName);

  // Read all files from dist/ and compute SHA-256 hashes
  const files = [];
  const walk = async (dir, base = '') => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else {
        const content = await fs.readFile(path.join(dir, entry.name));
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        files.push({ path: `/${rel}`, content, hash });
      }
    }
  };
  await walk(distDir);

  // Build multipart form for Cloudflare Pages direct upload
  const form = new FormData();
  const manifest = {};
  for (const f of files) manifest[f.path] = f.hash;
  form.append('manifest', JSON.stringify(manifest));
  for (const f of files) form.append(f.hash, new Blob([f.content]), f.path.slice(1));

  const result = await cfRequest('POST', `/pages/projects/${projectName}/deployments`, form, true);
  return result.url ? `https://${result.url}` : `https://${projectName}.pages.dev`;
}

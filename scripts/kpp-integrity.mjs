#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function toArchivePath(root, filePath) {
  return relative(root, filePath).split(sep).join('/');
}

export function listPackagedArtifacts(stagingDir) {
  const root = resolve(stagingDir);
  const files = [];
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      const filePath = join(current, name);
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`KPP staging 不允许符号链接: ${toArchivePath(root, filePath)}`);
      }
      if (stat.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`KPP staging 只允许普通文件: ${toArchivePath(root, filePath)}`);
      }
      const archivePath = toArchivePath(root, filePath);
      if (archivePath !== 'manifest.json') files.push(archivePath);
    }
  };
  visit(root);
  return files.sort();
}

function assertSafeArtifactPath(artifactPath) {
  const normalized = posix.normalize(artifactPath);
  if (
    !artifactPath
    || isAbsolute(artifactPath)
    || artifactPath.includes('\\')
    || normalized !== artifactPath
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`integrity.artifacts 含非法路径: ${artifactPath}`);
  }
}

function requiredEntryPaths(manifest) {
  const entries = new Set();
  for (const candidate of [
    manifest.entry?.backend,
    manifest.entry?.frontend,
    manifest.capabilities?.frontend?.bundle,
    ...Object.values(manifest.entry?.frontend_entries ?? {}),
    ...(manifest.capabilities?.frontend?.surfaces ?? []).map(surface => surface?.entry),
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) entries.add(candidate.trim());
  }
  return [...entries].sort();
}

export function stampStagingIntegrity(stagingDir) {
  const root = resolve(stagingDir);
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const artifacts = {};
  for (const artifactPath of listPackagedArtifacts(root)) {
    artifacts[artifactPath] = `sha256:${sha256File(join(root, artifactPath))}`;
  }
  manifest.integrity = { algorithm: 'sha256', artifacts };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, artifacts };
}

export function verifyStagingIntegrity(stagingDir) {
  const root = resolve(stagingDir);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.integrity?.algorithm !== 'sha256') {
    throw new Error('manifest.integrity.algorithm 必须为 sha256');
  }
  const artifacts = manifest.integrity?.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('manifest 缺少 integrity.artifacts');
  }

  const packagedPaths = listPackagedArtifacts(root);
  const declaredPaths = Object.keys(artifacts).sort();
  if (JSON.stringify(packagedPaths) !== JSON.stringify(declaredPaths)) {
    const packaged = new Set(packagedPaths);
    const declared = new Set(declaredPaths);
    const missing = packagedPaths.filter(item => !declared.has(item));
    const extra = declaredPaths.filter(item => !packaged.has(item));
    throw new Error(`integrity.artifacts 覆盖不完整: missing=${missing.join(',')} extra=${extra.join(',')}`);
  }

  const verified = [];
  for (const artifactPath of declaredPaths) {
    assertSafeArtifactPath(artifactPath);
    const expected = artifacts[artifactPath];
    if (typeof expected !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`integrity.artifacts[${artifactPath}] 不是规范 sha256`);
    }
    const filePath = join(root, artifactPath);
    const actualHex = sha256File(filePath);
    if (expected !== `sha256:${actualHex}`) {
      throw new Error(`integrity 校验失败: ${artifactPath}`);
    }
    verified.push({
      path: artifactPath,
      sha256: expected,
      size: lstatSync(filePath).size,
    });
  }

  for (const entryPath of requiredEntryPaths(manifest)) {
    if (!Object.prototype.hasOwnProperty.call(artifacts, entryPath)) {
      throw new Error(`manifest 入口未纳入 integrity.artifacts: ${entryPath}`);
    }
  }
  return { manifest, artifacts: verified };
}

function main() {
  const stagingArg = process.argv.find(arg => arg.startsWith('--staging='));
  if (!stagingArg) throw new Error('用法: node scripts/kpp-integrity.mjs --staging=<KPP staging 目录>');
  const stagingDir = resolve(process.cwd(), stagingArg.slice('--staging='.length));
  const stamped = stampStagingIntegrity(stagingDir);
  const verified = verifyStagingIntegrity(stagingDir);
  console.log(`[kimpo-workflow] integrity.artifacts 已覆盖 ${verified.artifacts.length} 件非 manifest 制品`);
  console.log(`__KIMPO_WORKFLOW_INTEGRITY_JSON__${JSON.stringify({
    stagingDir,
    pluginId: stamped.manifest.plugin_id,
    version: stamped.manifest.version,
    artifacts: verified.artifacts,
  })}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}

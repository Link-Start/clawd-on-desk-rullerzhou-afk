"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  TARGETS,
  PINNED_CHECKSUMS,
  binaryChecksumName,
  sha256,
  targetBinaryPath,
} = require("./fetch-sidecar-binaries");
const {
  inspectNativeBuffer,
  stableJson,
} = require("./audit-repository-assets");

const ASSERT_COMMAND = "node scripts/assert-packaged-sidecar.js";
const SIDECAR_RESOURCE_ROOT = path.join("sidecars", "cc-connect-clawd");

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), "en");
}

function targetByName(name) {
  const target = TARGETS.find((item) => item.dir === name);
  if (!target) {
    throw new Error(
      `Unsupported sidecar target "${name}". Expected one of: ${TARGETS.map((item) => item.dir).join(", ")}`,
    );
  }
  return target;
}

function defaultLayout(targetName, pkg) {
  const version = pkg.version;
  const productName = pkg.build && pkg.build.productName;
  const layouts = {
    "windows-x64": {
      packageRoot: path.join("dist", "win-unpacked"),
      resourcesRoot: path.join("dist", "win-unpacked", "resources"),
      artifacts: [path.join("dist", `Clawd-on-Desk-Setup-${version}-x64.exe`)],
    },
    "windows-arm64": {
      packageRoot: path.join("dist", "win-arm64-unpacked"),
      resourcesRoot: path.join("dist", "win-arm64-unpacked", "resources"),
      artifacts: [path.join("dist", `Clawd-on-Desk-Setup-${version}-arm64.exe`)],
    },
    "darwin-x64": {
      packageRoot: path.join("dist", "mac", `${productName}.app`),
      resourcesRoot: path.join("dist", "mac", `${productName}.app`, "Contents", "Resources"),
      artifacts: [path.join("dist", `Clawd-on-Desk-${version}-x64.dmg`)],
    },
    "darwin-arm64": {
      packageRoot: path.join("dist", "mac-arm64", `${productName}.app`),
      resourcesRoot: path.join("dist", "mac-arm64", `${productName}.app`, "Contents", "Resources"),
      artifacts: [path.join("dist", `Clawd-on-Desk-${version}-arm64.dmg`)],
    },
    "linux-x64": {
      packageRoot: path.join("dist", "linux-unpacked"),
      resourcesRoot: path.join("dist", "linux-unpacked", "resources"),
      artifacts: [
        path.join("dist", `Clawd-on-Desk-${version}-x86_64.AppImage`),
        path.join("dist", `Clawd-on-Desk-${version}-amd64.deb`),
      ],
    },
  };
  const layout = layouts[targetName];
  if (!layout) targetByName(targetName);
  return layout;
}

function resolveFrom(root, value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function isDirectory(fsModule, filePath) {
  try {
    return fsModule.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(fsModule, filePath) {
  try {
    return fsModule.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function walkRelativeFiles(root, fsModule = fs) {
  if (!isDirectory(fsModule, root)) return [];
  const files = [];
  function visit(current, relative) {
    const entries = fsModule.readdirSync(current, { withFileTypes: true })
      .slice()
      .sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push(normalizePath(relativePath));
      } else {
        throw new Error(`Unsupported non-file package entry: ${fullPath}`);
      }
    }
  }
  visit(root, "");
  return files;
}

function summarizeTree(root, label, fsModule = fs) {
  const files = walkRelativeFiles(root, fsModule);
  return {
    path: normalizePath(label),
    files: files.length,
    bytes: files.reduce(
      (total, relativePath) => total + fsModule.statSync(resolveFrom(root, relativePath)).size,
      0,
    ),
  };
}

function packagedFileRecord(root, relativePath, fsModule = fs) {
  const fullPath = resolveFrom(root, relativePath);
  const contents = fsModule.readFileSync(fullPath);
  return {
    path: normalizePath(relativePath),
    bytes: contents.length,
    sha256: sha256(contents),
  };
}

function relativeOrBasename(repoRoot, filePath) {
  const relative = normalizePath(path.relative(repoRoot, filePath));
  return relative.startsWith("../") || relative === ".."
    ? normalizePath(path.basename(filePath))
    : relative;
}

function normalizeDarwinCodeSignature(filePath, options = {}) {
  const fsModule = options.fs || fs;
  const spawn = options.spawnSync || spawnSync;
  const requireSignature = options.requireSignature === true;
  const verification = spawn("codesign", ["--verify", "--strict", filePath], {
    encoding: "utf8",
  });
  if (verification.error) {
    return { ok: false, error: `codesign verification could not start: ${verification.error.message}` };
  }
  if (verification.status !== 0) {
    if (!requireSignature) {
      return {
        ok: true,
        buffer: fsModule.readFileSync(filePath),
        signed: false,
        method: "unsigned-source",
      };
    }
    const detail = String(verification.stderr || verification.stdout || "").trim();
    return { ok: false, error: `codesign verification failed${detail ? `: ${detail}` : ""}` };
  }

  const tempDir = fsModule.mkdtempSync(path.join(os.tmpdir(), "clawd-sidecar-codesign-"));
  const tempPath = path.join(tempDir, path.basename(filePath));
  try {
    fsModule.copyFileSync(filePath, tempPath);
    const removal = spawn("codesign", ["--remove-signature", tempPath], {
      encoding: "utf8",
    });
    if (removal.error) {
      return { ok: false, error: `codesign signature removal could not start: ${removal.error.message}` };
    }
    if (removal.status !== 0) {
      const detail = String(removal.stderr || removal.stdout || "").trim();
      return { ok: false, error: `codesign signature removal failed${detail ? `: ${detail}` : ""}` };
    }
    return {
      ok: true,
      buffer: fsModule.readFileSync(tempPath),
      signed: true,
      method: "codesign-stripped",
    };
  } finally {
    fsModule.rmSync(tempDir, { recursive: true, force: true });
  }
}

function inspectPackagedSidecar(options = {}) {
  const fsModule = options.fs || fs;
  const repoRoot = options.repoRoot || path.join(__dirname, "..");
  const pkg = options.packageJson || require(path.join(repoRoot, "package.json"));
  const target = targetByName(options.target);
  const resourcesRoot = resolveFrom(repoRoot, options.resourcesRoot);
  const resourcesLabel = options.resourcesLabel || relativeOrBasename(repoRoot, resourcesRoot);
  const artifactPaths = (options.artifacts || []).map((item) => resolveFrom(repoRoot, item));
  const checksums = options.checksums || PINNED_CHECKSUMS;
  const hostPlatform = options.hostPlatform || process.platform;
  const errors = [];

  if (!isDirectory(fsModule, resourcesRoot)) {
    errors.push(`Missing packaged resources directory: ${normalizePath(resourcesLabel)}`);
  }

  const resources = summarizeTree(resourcesRoot, resourcesLabel, fsModule);
  const sidecarRoot = path.join(resourcesRoot, SIDECAR_RESOURCE_ROOT);
  const sidecarFiles = walkRelativeFiles(sidecarRoot, fsModule);
  const expectedRelativePath = normalizePath(path.join(target.dir, target.exe));
  const expectedPath = path.join(sidecarRoot, ...expectedRelativePath.split("/"));
  const expectedFiles = [expectedRelativePath];

  if (!isDirectory(fsModule, sidecarRoot)) {
    errors.push(`Missing packaged sidecar directory: ${normalizePath(path.join(resourcesLabel, SIDECAR_RESOURCE_ROOT))}`);
  }
  if (JSON.stringify(sidecarFiles) !== JSON.stringify(expectedFiles)) {
    errors.push(
      `Packaged sidecar files for ${target.dir} must equal ${expectedFiles.join(", ")}; found ${sidecarFiles.join(", ") || "(none)"}`,
    );
  }

  const fileRecords = sidecarFiles.map((relativePath) => packagedFileRecord(sidecarRoot, relativePath, fsModule));
  const expectedRecord = fileRecords.find((item) => item.path === expectedRelativePath) || null;
  let native = null;
  let executable = null;
  let expectedSha256 = null;
  let checksumMode = null;
  let normalizedSha256 = null;
  let sourceSigned = null;
  let packagedSigned = null;
  const executableRequired = target.platform !== "windows";
  const executableChecked = executableRequired && hostPlatform !== "win32";

  if (expectedRecord && isFile(fsModule, expectedPath)) {
    expectedSha256 = String(checksums[binaryChecksumName(target)] || "").toLowerCase() || null;
    if (!expectedSha256) {
      errors.push(`Missing pinned checksum for ${binaryChecksumName(target)}`);
    } else if (expectedRecord.sha256 === expectedSha256) {
      checksumMode = "exact";
    } else if (target.platform === "darwin"
      && (hostPlatform === "darwin" || typeof options.normalizeDarwinBinary === "function")) {
      const sourcePath = targetBinaryPath(repoRoot, target);
      if (!isFile(fsModule, sourcePath)) {
        errors.push(`Missing pinned source sidecar for signature comparison: ${target.dir}/${target.exe}`);
      } else {
        const sourceBuffer = fsModule.readFileSync(sourcePath);
        const sourceSha256 = sha256(sourceBuffer);
        if (sourceSha256 !== expectedSha256) {
          errors.push(
            `Source sidecar checksum mismatch for ${target.dir}: got ${sourceSha256}, expected ${expectedSha256}`,
          );
        } else {
          const normalize = options.normalizeDarwinBinary || normalizeDarwinCodeSignature;
          const sourceNormalized = normalize(sourcePath, {
            fs: fsModule,
            role: "source",
            requireSignature: false,
            spawnSync: options.spawnSync,
          });
          const packagedNormalized = normalize(expectedPath, {
            fs: fsModule,
            role: "packaged",
            requireSignature: true,
            spawnSync: options.spawnSync,
          });
          sourceSigned = sourceNormalized.ok ? sourceNormalized.signed : null;
          packagedSigned = packagedNormalized.ok ? packagedNormalized.signed : null;
          if (!sourceNormalized.ok) {
            errors.push(`Could not normalize source ${target.dir} signature: ${sourceNormalized.error}`);
          }
          if (!packagedNormalized.ok) {
            errors.push(`Could not normalize packaged ${target.dir} signature: ${packagedNormalized.error}`);
          }
          if (sourceNormalized.ok && packagedNormalized.ok) {
            const sourceNormalizedSha256 = sha256(sourceNormalized.buffer);
            const packagedNormalizedSha256 = sha256(packagedNormalized.buffer);
            normalizedSha256 = packagedNormalizedSha256;
            if (sourceNormalizedSha256 === packagedNormalizedSha256) {
              checksumMode = "codesign-normalized";
            } else {
              errors.push(
                `Packaged sidecar normalized checksum mismatch for ${target.dir}: `
                + `got ${packagedNormalizedSha256}, expected ${sourceNormalizedSha256}`,
              );
            }
          }
        }
      }
    } else {
      errors.push(
        `Packaged sidecar checksum mismatch for ${target.dir}: got ${expectedRecord.sha256}, expected ${expectedSha256}`,
      );
    }

    native = inspectNativeBuffer(fsModule.readFileSync(expectedPath));
    if (!native) {
      errors.push(`Packaged sidecar for ${target.dir} is not a recognized native executable`);
    } else if (`${native.os}-${native.arch}` !== target.dir) {
      errors.push(
        `Packaged sidecar native target mismatch: expected ${target.dir}, detected ${native.os}-${native.arch}`,
      );
    }

    if (executableChecked) {
      executable = (fsModule.statSync(expectedPath).mode & 0o111) !== 0;
      if (!executable) {
        errors.push(`Packaged sidecar for ${target.dir} is missing an executable mode bit`);
      }
    }
  }

  const artifacts = [];
  for (const artifactPath of artifactPaths) {
    const label = relativeOrBasename(repoRoot, artifactPath);
    if (!isFile(fsModule, artifactPath)) {
      errors.push(`Missing built artifact: ${label}`);
      continue;
    }
    artifacts.push({
      path: label,
      bytes: fsModule.statSync(artifactPath).size,
    });
  }

  errors.sort(compareText);
  return {
    ok: errors.length === 0,
    errors,
    manifest: {
      schemaVersion: 1,
      target: target.dir,
      packageVersion: String(pkg.version),
      resources,
      artifacts: artifacts.sort((a, b) => compareText(a.path, b.path)),
      sidecar: {
        root: normalizePath(SIDECAR_RESOURCE_ROOT),
        expectedPath: expectedRelativePath,
        files: fileRecords,
        bytes: fileRecords.reduce((total, item) => total + item.bytes, 0),
        native,
        expectedSha256,
        checksumMode,
        normalizedSha256,
        sourceSigned,
        packagedSigned,
        executableRequired,
        executableChecked,
        executable,
      },
      errors,
    },
  };
}

function parseArgs(argv) {
  const out = {
    target: "",
    resourcesRoot: "",
    artifacts: [],
    output: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") out.target = argv[++index];
    else if (arg === "--resources-root") out.resourcesRoot = argv[++index];
    else if (arg === "--artifact") out.artifacts.push(argv[++index]);
    else if (arg === "--output") out.output = argv[++index];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.help && !out.target) throw new Error("--target is required");
  return out;
}

function printHelp(stdout = process.stdout) {
  stdout.write(
    `Usage: ${ASSERT_COMMAND} --target <platform-arch> `
    + "[--resources-root DIR] [--artifact FILE ...] [--output FILE]\n",
  );
}

function runAssertion(options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, "..");
  const pkg = options.packageJson || require(path.join(repoRoot, "package.json"));
  const layout = defaultLayout(options.target, pkg);
  const resourcesRoot = options.resourcesRoot || layout.resourcesRoot;
  const artifacts = options.artifacts && options.artifacts.length
    ? options.artifacts
    : layout.artifacts;
  const output = options.output
    || path.join("dist", "sidecar-package-manifests", `${options.target}.json`);
  const result = inspectPackagedSidecar({
    ...options,
    repoRoot,
    packageJson: pkg,
    resourcesRoot,
    artifacts,
  });
  const outputPath = resolveFrom(repoRoot, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, stableJson(result.manifest), "utf8");
  return { ...result, outputPath };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = runAssertion(args);
  process.stdout.write([
    `Packaged sidecar ${result.manifest.target}: ${result.ok ? "PASS" : "FAIL"}`,
    `Resources: ${result.manifest.resources.files} files, ${result.manifest.resources.bytes} bytes`,
    `Sidecar: ${result.manifest.sidecar.files.length} file(s), ${result.manifest.sidecar.bytes} bytes`,
    `Artifacts: ${result.manifest.artifacts.map((item) => `${item.path} (${item.bytes} bytes)`).join(", ")}`,
    ...result.errors.map((message) => `ERROR ${message}`),
    `Manifest: ${normalizePath(path.relative(path.join(__dirname, ".."), result.outputPath))}`,
    "",
  ].join("\n"));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Packaged sidecar assertion failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ASSERT_COMMAND,
  SIDECAR_RESOURCE_ROOT,
  defaultLayout,
  inspectPackagedSidecar,
  normalizeDarwinCodeSignature,
  parseArgs,
  runAssertion,
  summarizeTree,
  targetByName,
  walkRelativeFiles,
};

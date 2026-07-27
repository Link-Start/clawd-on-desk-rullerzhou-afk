"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  defaultLayout,
  inspectPackagedSidecar,
  normalizeDarwinCodeSignature,
  normalizeMachOSignaturePayload,
  parseArgs,
} = require("../scripts/assert-packaged-sidecar");
const {
  binaryChecksumName,
  TARGETS,
} = require("../scripts/fetch-sidecar-binaries");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function peBuffer(machine) {
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "ascii");
  buffer.writeUInt16LE(machine, 68);
  return buffer;
}

function elfBuffer(machine) {
  const buffer = Buffer.alloc(128);
  buffer[0] = 0x7f;
  buffer.write("ELF", 1, "ascii");
  buffer[5] = 1;
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

function machoBuffer(cpuType, marker = 0) {
  const buffer = Buffer.alloc(128);
  buffer.writeUInt32BE(0xfeedfacf, 0);
  buffer.writeUInt32BE(cpuType, 4);
  buffer.writeUInt8(marker, 127);
  return buffer;
}

function signedMachoBuffer(cpuType, signatureBytes, signatureMarker) {
  const buffer = Buffer.alloc(128 + signatureBytes, signatureMarker);
  buffer.fill(0, 0, 128);
  buffer.writeUInt32BE(0xfeedfacf, 0);
  buffer.writeUInt32BE(cpuType, 4);
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(16, 20);
  buffer.writeUInt32BE(0x1d, 32);
  buffer.writeUInt32BE(16, 36);
  buffer.writeUInt32BE(128, 40);
  buffer.writeUInt32BE(signatureBytes, 44);
  buffer.writeUInt8(7, 100);
  return buffer;
}

function fixture(targetName, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-packaged-sidecar-"));
  const resourcesRoot = path.join(root, "resources");
  const target = TARGETS.find((item) => item.dir === targetName);
  const binaryPath = path.join(
    resourcesRoot,
    "sidecars",
    "cc-connect-clawd",
    target.dir,
    target.exe,
  );
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, contents);
  return {
    root,
    resourcesRoot,
    target,
    binaryPath,
    checksums: {
      [binaryChecksumName(target)]: sha256(contents),
    },
  };
}

function removeFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

test("default layouts cover all five release targets with target-specific unpacked roots", () => {
  const pkg = require("../package.json");
  const targets = [
    "windows-x64",
    "windows-arm64",
    "darwin-x64",
    "darwin-arm64",
    "linux-x64",
  ];
  assert.deepStrictEqual(
    targets.map((target) => [target, defaultLayout(target, pkg).resourcesRoot]),
    [
      ["windows-x64", path.join("dist", "win-unpacked", "resources")],
      ["windows-arm64", path.join("dist", "win-arm64-unpacked", "resources")],
      ["darwin-x64", path.join("dist", "mac", "Clawd on Desk.app", "Contents", "Resources")],
      ["darwin-arm64", path.join("dist", "mac-arm64", "Clawd on Desk.app", "Contents", "Resources")],
      ["linux-x64", path.join("dist", "linux-unpacked", "resources")],
    ],
  );
  assert.deepStrictEqual(defaultLayout("linux-x64", pkg).artifacts, [
    path.join("dist", `Clawd-on-Desk-${pkg.version}-x86_64.AppImage`),
    path.join("dist", `Clawd-on-Desk-${pkg.version}-amd64.deb`),
  ]);
});

test("packaged sidecar assertion emits a deterministic manifest for the one expected target", () => {
  const item = fixture("windows-x64", peBuffer(0x8664));
  try {
    const options = {
      target: item.target.dir,
      repoRoot: item.root,
      packageJson: { version: "test" },
      resourcesRoot: item.resourcesRoot,
      resourcesLabel: "package/resources",
      artifacts: [],
      checksums: item.checksums,
      hostPlatform: "win32",
    };
    const first = inspectPackagedSidecar(options);
    const second = inspectPackagedSidecar(options);
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first.manifest.sidecar.files.map((file) => file.path), [
      "windows-x64/cc-connect-clawd.exe",
    ]);
    assert.deepStrictEqual(first.manifest.sidecar.native, {
      os: "windows",
      arch: "x64",
      format: "pe",
    });
    assert.strictEqual(first.manifest.sidecar.expectedSha256, item.checksums[binaryChecksumName(item.target)]);
    assert.strictEqual(first.manifest.sidecar.checksumMode, "exact");
  } finally {
    removeFixture(item);
  }
});

test("packaged sidecar assertion rejects additional target payloads", () => {
  const item = fixture("windows-x64", peBuffer(0x8664));
  try {
    const foreignPath = path.join(
      item.resourcesRoot,
      "sidecars",
      "cc-connect-clawd",
      "windows-arm64",
      "cc-connect-clawd.exe",
    );
    fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
    fs.writeFileSync(foreignPath, peBuffer(0xaa64));
    const result = inspectPackagedSidecar({
      target: item.target.dir,
      repoRoot: item.root,
      packageJson: { version: "test" },
      resourcesRoot: item.resourcesRoot,
      resourcesLabel: "package/resources",
      artifacts: [],
      checksums: item.checksums,
      hostPlatform: "win32",
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((message) => message.includes("must equal")));
    assert.deepStrictEqual(result.manifest.sidecar.files.map((file) => file.path), [
      "windows-arm64/cc-connect-clawd.exe",
      "windows-x64/cc-connect-clawd.exe",
    ]);
  } finally {
    removeFixture(item);
  }
});

test("packaged sidecar assertion rejects checksum and native architecture mismatches", () => {
  const item = fixture("windows-x64", peBuffer(0xaa64));
  try {
    const result = inspectPackagedSidecar({
      target: item.target.dir,
      repoRoot: item.root,
      packageJson: { version: "test" },
      resourcesRoot: item.resourcesRoot,
      resourcesLabel: "package/resources",
      artifacts: [],
      checksums: {
        [binaryChecksumName(item.target)]: "0".repeat(64),
      },
      hostPlatform: "win32",
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((message) => message.includes("checksum mismatch")));
    assert.ok(result.errors.some((message) => message.includes("native target mismatch")));
  } finally {
    removeFixture(item);
  }
});

test("Darwin packages accept only a signed copy matching the pinned source outside the bounded signature payload", () => {
  const packagedContents = signedMachoBuffer(0x0100000c, 33, 2);
  const sourceContents = signedMachoBuffer(0x0100000c, 56, 1);
  const item = fixture("darwin-arm64", packagedContents);
  const sourcePath = path.join(
    item.root,
    "bin",
    "cc-connect-clawd",
    item.target.dir,
    item.target.exe,
  );
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, sourceContents);
  try {
    const result = inspectPackagedSidecar({
      target: item.target.dir,
      repoRoot: item.root,
      packageJson: { version: "test" },
      resourcesRoot: item.resourcesRoot,
      resourcesLabel: "package/resources",
      artifacts: [],
      checksums: {
        [binaryChecksumName(item.target)]: sha256(sourceContents),
      },
      hostPlatform: "win32",
      normalizeDarwinBinary: normalizeDarwinCodeSignature,
      spawnSync() {
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.manifest.sidecar.expectedSha256, sha256(sourceContents));
    assert.strictEqual(result.manifest.sidecar.checksumMode, "codesign-normalized");
    assert.strictEqual(
      result.manifest.sidecar.normalizedSha256,
      sha256(normalizeMachOSignaturePayload(sourceContents).buffer),
    );
    assert.strictEqual(result.manifest.sidecar.sourceSigned, true);
    assert.strictEqual(result.manifest.sidecar.packagedSigned, true);
    assert.strictEqual(result.manifest.sidecar.sourceSignatureBytes, 56);
    assert.strictEqual(result.manifest.sidecar.packagedSignatureBytes, 33);
  } finally {
    removeFixture(item);
  }
});

test("Darwin signature normalization verifies before excluding signature bytes and rejects an unsigned package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codesign-normalize-"));
  const signedPath = path.join(root, "cc-connect-clawd");
  const signedContents = signedMachoBuffer(0x0100000c, 33, 2);
  fs.writeFileSync(signedPath, signedContents);
  const calls = [];
  try {
    const normalized = normalizeDarwinCodeSignature(signedPath, {
      spawnSync(command, args) {
        calls.push([command, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      requireSignature: true,
    });
    assert.strictEqual(normalized.ok, true);
    assert.strictEqual(normalized.signed, true);
    assert.strictEqual(normalized.signatureBytes, 33);
    assert.strictEqual(normalized.buffer.length, 128);
    assert.deepStrictEqual(calls, [["codesign", "--verify", "--strict", signedPath]]);

    const rejected = normalizeDarwinCodeSignature(signedPath, {
      spawnSync() {
        return { status: 1, stdout: "", stderr: "code object is not signed at all" };
      },
      requireSignature: true,
    });
    assert.strictEqual(rejected.ok, false);
    assert.match(rejected.error, /codesign verification failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mach-O normalization excludes only the declared final signature payload", () => {
  const first = signedMachoBuffer(0x0100000c, 56, 1);
  const resigned = signedMachoBuffer(0x0100000c, 33, 2);
  const firstNormalized = normalizeMachOSignaturePayload(first);
  const resignedNormalized = normalizeMachOSignaturePayload(resigned);
  assert.strictEqual(firstNormalized.ok, true);
  assert.strictEqual(resignedNormalized.ok, true);
  assert.deepStrictEqual(firstNormalized.buffer, resignedNormalized.buffer);

  const changedPayload = Buffer.from(resigned);
  changedPayload.writeUInt8(8, 100);
  assert.notDeepStrictEqual(
    firstNormalized.buffer,
    normalizeMachOSignaturePayload(changedPayload).buffer,
    "non-signature payload changes must remain visible",
  );
  const trailingBytes = Buffer.concat([resigned, Buffer.from([0])]);
  assert.deepStrictEqual(normalizeMachOSignaturePayload(trailingBytes), {
    ok: false,
    error: "Mach-O code signature is not the final bounded payload",
  });
});

test("packaged sidecar assertion checks executable mode on POSIX package runners", () => {
  const item = fixture("linux-x64", elfBuffer(62));
  try {
    const fsWithoutExecutableBit = {
      existsSync: fs.existsSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      readdirSync: fs.readdirSync.bind(fs),
      statSync(filePath) {
        const stat = fs.statSync(filePath);
        if (path.resolve(filePath) !== path.resolve(item.binaryPath)) return stat;
        return {
          ...stat,
          mode: stat.mode & ~0o111,
          isDirectory: () => stat.isDirectory(),
          isFile: () => stat.isFile(),
        };
      },
    };
    const result = inspectPackagedSidecar({
      target: item.target.dir,
      repoRoot: item.root,
      packageJson: { version: "test" },
      resourcesRoot: item.resourcesRoot,
      resourcesLabel: "package/resources",
      artifacts: [],
      checksums: item.checksums,
      hostPlatform: "linux",
      fs: fsWithoutExecutableBit,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.manifest.sidecar.executableChecked, true);
    assert.strictEqual(result.manifest.sidecar.executable, false);
    assert.ok(result.errors.some((message) => message.includes("executable mode bit")));
  } finally {
    removeFixture(item);
  }
});

test("CLI parser supports explicit package paths and rejects a missing target", () => {
  assert.deepStrictEqual(
    parseArgs([
      "--target", "windows-x64",
      "--resources-root", "dist/custom/resources",
      "--artifact", "dist/custom.exe",
      "--output", "dist/custom.json",
    ]),
    {
      target: "windows-x64",
      resourcesRoot: "dist/custom/resources",
      artifacts: ["dist/custom.exe"],
      output: "dist/custom.json",
    },
  );
  assert.throws(() => parseArgs([]), /--target is required/);
});

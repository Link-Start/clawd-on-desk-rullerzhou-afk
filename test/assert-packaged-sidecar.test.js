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

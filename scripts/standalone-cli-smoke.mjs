import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRealPath = await realpath(repositoryRoot);
const npmCliPath = process.platform === "win32"
  ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  : null;

function run(command, args, { cwd, shell = false } = {}) {
  const options = {
    cwd,
    encoding: "utf8",
    shell,
    windowsHide: true,
  };
  const result = shell && args.length === 0
    ? spawnSync(command, options)
    : spawnSync(command, args, options);
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runNpm(args, cwd) {
  return process.platform === "win32"
    ? run(process.execPath, [npmCliPath, ...args], { cwd })
    : run("npm", args, { cwd });
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}).\n${result.stdout}${result.stderr}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

function runInstalledCli(binPath, args, cwd) {
  if (process.platform === "win32") {
    const commandLine = [`"${binPath}"`, ...args].join(" ");
    return run(commandLine, [], { cwd, shell: true });
  }
  return run(binPath, args, { cwd });
}

const tempRoot = await mkdtemp(join(tmpdir(), "paypath-cli-standalone-smoke-"));
try {
  const tempRealPath = await realpath(tempRoot);
  assert(!isInside(repositoryRealPath, tempRealPath), "Temporary smoke-test directory must be outside the repository.");

  const build = runNpm(["run", "build", "--workspace", "@paypath/cli"], repositoryRoot);
  requireSuccess(build, "CLI bundle build");

  const pack = runNpm(["pack", "./packages/cli", "--pack-destination", tempRoot, "--json"], repositoryRoot);
  requireSuccess(pack, "CLI tarball creation");
  const [packed] = JSON.parse(pack.stdout);
  assert(packed?.name === "@paypath/cli", "npm pack did not produce the PayPath CLI package.");
  const expectedFiles = ["dist/paypath.js", "package.json"];
  const packedFiles = packed.files.map(({ path }) => path).sort();
  assert(
    JSON.stringify(packedFiles) === JSON.stringify(expectedFiles),
    `Unexpected tarball contents: ${packedFiles.join(", ")}`,
  );
  const tarballPath = join(tempRoot, packed.filename);

  const consumerRoot = join(tempRoot, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  const init = runNpm(["init", "-y"], consumerRoot);
  requireSuccess(init, "Standalone consumer initialization");
  const install = runNpm(["install", "--no-audit", "--no-fund", tarballPath], consumerRoot);
  requireSuccess(install, "Standalone tarball install");

  const consumerRealPath = await realpath(consumerRoot);
  const installedPackagePath = join(consumerRoot, "node_modules", "@paypath", "cli");
  const installedPackageRealPath = await realpath(installedPackagePath);
  assert(isInside(consumerRealPath, installedPackageRealPath), "Installed CLI resolved outside the temporary consumer project.");
  assert(!isInside(repositoryRealPath, installedPackageRealPath), "Installed CLI resolved into the Monorepo.");

  const installedPackage = JSON.parse(await readFile(join(installedPackagePath, "package.json"), "utf8"));
  const internalDependencies = Object.keys(installedPackage.dependencies ?? {}).filter((name) => name.startsWith("@paypath/"));
  assert(internalDependencies.length === 0, `Tarball has unpublished internal dependencies: ${internalDependencies.join(", ")}`);
  assert(installedPackage.bin?.paypath === "./dist/paypath.js", "Installed package does not expose the paypath bin.");

  const binPath = join(consumerRoot, "node_modules", ".bin", process.platform === "win32" ? "paypath.cmd" : "paypath");
  const help = runInstalledCli(binPath, ["--help"], consumerRoot);
  requireSuccess(help, "paypath --help");
  assert(help.stdout.includes("Usage:") && help.stdout.includes("paypath test"), "Help output is incomplete.");

  const version = runInstalledCli(binPath, ["--version"], consumerRoot);
  requireSuccess(version, "paypath --version");
  assert(version.stdout.trim() === installedPackage.version, "CLI version does not match package.json.");

  const fixedReportPath = join(consumerRoot, "fixed-report.json");
  const fixed = runInstalledCli(
    binPath,
    ["test", "--mode", "fixed", "--scenario", "successful-payment", "--report", fixedReportPath],
    consumerRoot,
  );
  requireSuccess(fixed, "Fixed local fixture");
  const fixedReport = JSON.parse(await readFile(fixedReportPath, "utf8"));
  assert(
    fixedReport.source === "local-fixture" &&
      fixedReport.results?.length === 1 &&
      fixedReport.results[0].scenario === "successful-payment" &&
      fixedReport.results[0].status === "PASS" &&
      fixedReport.results[0].errorCode === null,
    "Fixed fixture JSON report did not contain the expected PASS result.",
  );

  const buggyReportPath = join(consumerRoot, "buggy-report.json");
  const buggy = runInstalledCli(
    binPath,
    ["test", "--mode", "buggy", "--scenario", "successful-payment", "--report", buggyReportPath],
    consumerRoot,
  );
  const buggyReport = JSON.parse(await readFile(buggyReportPath, "utf8"));
  assert(
    buggy.status === 1 &&
      buggyReport.source === "local-fixture" &&
      buggyReport.results?.length === 1 &&
      buggyReport.results[0].scenario === "successful-payment" &&
      buggyReport.results[0].status === "FAIL" &&
      buggyReport.results[0].errorCode === "ENTITLEMENT_NOT_GRANTED",
    "Buggy fixture did not exit 1 with ENTITLEMENT_NOT_GRANTED in its JSON report.",
  );

  console.log(`Standalone CLI smoke test: PASS (${packed.name}@${packed.version})`);
  console.log("Tarball install: PASS; no @paypath/* runtime dependencies or workspace links.");
  console.log("--help: PASS; --version: PASS.");
  console.log("Fixed successful-payment fixture: PASS, exit 0.");
  console.log("Buggy successful-payment fixture: ENTITLEMENT_NOT_GRANTED, exit 1.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

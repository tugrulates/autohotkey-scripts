import { Command } from "@cliffy/command";
import { Table } from "@cliffy/table";
import { assert } from "@std/assert";
import { distinctBy } from "@std/collections";
import { expandGlob } from "@std/fs";
import { basename, dirname, fromFileUrl, join, normalize } from "@std/path";
import { canParse, format, increment, parse } from "@std/semver";
import { pool } from "@tugrulates/internal/async";
import { compile, compileTargets } from "@tugrulates/internal/compile";
import {
  conventional,
  type ConventionalCommit,
  git,
  GitError,
  type Tag,
} from "@tugrulates/internal/git";
import { github, type Repository } from "@tugrulates/internal/github";

/** An error while working with packages. */
export class PackageError extends Error {
  /**
   * Construct PackageError.
   *
   * @param message The error message to be associated with this error.
   * @param options.cause The cause of the error.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PackageError";
  }
}

/** Information about a Deno package. */
export interface Package {
  /** Package directory. */
  directory: string;
  /** Package module name. */
  module: string;
  /** Package config from `deno.json`. */
  config: Config;
  /** Calculated package version, might be different than config version. */
  version?: string;
  /** Latest release of this package. */
  release?: Release;
  /** Changes over the last release. */
  update?: Update;
}

/** Configuration for compiling the package. */
export interface CompileConfig {
  /** Entry module for the package. */
  main?: string;
  /** Include patterns for the package. */
  include?: string[];
  /** Enable unstable KV feature. */
  kv?: boolean;
  /** Deno runtime permissions. */
  permissions?: Deno.PermissionDescriptor[];
}

/** Configuration from `deno.json`. */
export interface Config {
  /** Package name. */
  name?: string;
  /** Package version. */
  version?: string | undefined;
  /** Workspace packages. */
  workspace?: string[];
  /** Configuration for compiling the package. */
  compile?: CompileConfig;
}

/** Information about a package release. */
export interface Release {
  /** Release version. */
  version: string;
  /** Release tag. */
  tag: Tag;
}

/** Information about a package update. */
export interface Update {
  /** Type of the update. */
  type: "major" | "minor" | "patch" | undefined;
  /** Updated version, if the package would be released at this state. */
  version: string;
  /** Tag name to use for this update. */
  tag: string;
  /** Changes in this update. */
  changelog: ConventionalCommit[];
}

/** Options for package retrieval. */
export interface PackageOptions {
  /**
   * Package directory.
   * @default {dirname(Deno.mainModule())}
   */
  directory?: string;
  /** Options for determining package versions.  */
  version?: VersionOptions;
}

/** Options for workspace retrieval. */
export interface WorkspaceOptions {
  /**
   * List of directories to fetch packages from.
   * @default {["."]}
   */
  directories?: string[];
  /**
   * Options for determinining package versions.
   *
   * If not provided, config version is used.
   */
  version?: VersionOptions;
}

/** Options for determining package versions. */
export interface VersionOptions {
  /**
   * Use config version as package version.
   *
   * If true, version is copied from `deno.json`. If false, version is
   * calculated using git release tags and conventional commits.
   *
   * @default {false}
   */
  config?: boolean;
  /** Commit to compare against. */
  commit?: string;
}

/**
 * Returns the version of the current package.
 *
 * Useful for providing a version number to the user of a tool or application.
 *
 * The version is determined from whichever is available first:
 *  - release tags and conventional commits (local development)
 *  - config version from `deno.json` (deno run)
 *  - config version from `deno.json` in the dist directory (deno compile)
 *  - "(unknown)" if none of the above are available
 */
export async function version(): Promise<string> {
  try {
    const pkg = await getPackage();
    if (pkg.version) return pkg.version;
  } catch (e: unknown) {
    if (
      !(e instanceof PackageError || e instanceof GitError ||
        e instanceof Deno.errors.NotCapable)
    ) {
      throw e;
    }
  }
  try {
    const pkg = await getPackage({ version: { config: true } });
    if (pkg.version) return pkg.version;
  } catch (e: unknown) {
    if (!(e instanceof PackageError)) throw e;
  }
  if (import.meta.dirname) {
    for await (
      const path of expandGlob("**/deno.json", {
        root: join(import.meta.dirname, "..", "dist"),
        includeDirs: false,
      })
    ) {
      try {
        const pkg = await getPackage({
          directory: dirname(path.path),
          version: { config: true },
        });
        if (pkg.version) return pkg.version;
      } catch (e: unknown) {
        if (!(e instanceof PackageError)) throw e;
      }
    }
  }
  return "(unknown)";
}

/**
 * Version details of current package, Deno, V8 and TypeScript.
 *
 * @todo Move this to a CLI package.
 */
export async function displayVersion(): Promise<string> {
  return [
    `${await version()} (${Deno.build.target})`,
    `deno ${Deno.version.deno}`,
    `v8 ${Deno.version.v8}`,
    `typescript ${Deno.version.typescript}`,
  ].join("\n");
}

/** Returns information about a package. */
export async function getPackage(options?: PackageOptions): Promise<Package> {
  const directory = normalize(
    options?.directory ?? dirname(fromFileUrl(Deno.mainModule)),
  );
  const config = await getConfig(directory);
  const pkg: Package = {
    directory,
    module: basename(config.name ?? directory),
    config: config,
  };
  if (!config.version) return pkg;
  pkg.version = config.version;
  if (options?.version?.config !== true) {
    const release = await getRelease(pkg, options?.version);
    if (release) {
      pkg.release = release;
      pkg.version = release.version;
    }
    const update = await getUpdate(pkg, options?.version);
    if (update) {
      pkg.update = update;
      pkg.version = format({
        ...parse(pkg.update.version),
        ...update.changelog[0] && {
          prerelease: [`pre.${update.changelog.length}`],
          build: [update.changelog[0].short],
        },
      });
    }
  }
  return pkg;
}

/** Returns all packages, recursively traversing workspaces. */
export async function getWorkspace(
  options?: WorkspaceOptions,
): Promise<Package[]> {
  const directories = options?.directories ?? ["."];
  const packages = await Promise.all(
    directories?.map((directory) => getPackage({ directory, ...options })),
  );
  const all = (await Promise.all(
    packages.map(async (pkg) => [
      pkg,
      ...await getWorkspace({
        ...options,
        directories: pkg.config.workspace?.map((child) =>
          join(pkg.directory, child)
        ) ??
          [],
      }),
    ]),
  )).flat();
  return distinctBy(all, (pkg) => pkg.directory);
}

async function getConfig(directory: string): Promise<Config> {
  const configFile = join(directory, "deno.json");
  try {
    const data = await Deno.readTextFile(configFile);
    return (JSON.parse(data)) as Config;
  } catch (e: unknown) {
    throw new PackageError(`Cannot read package config: ${configFile}`, {
      cause: e,
    });
  }
}

async function getRelease(
  pkg: Package,
  options?: VersionOptions,
): Promise<Release | undefined> {
  const repo = git({ cwd: pkg.directory });
  const name = `${pkg.module}@*`;
  const sort = "version";
  const [tag] = options?.commit
    ? [
      ...await repo.tagList({ name, sort, pointsAt: options.commit }),
      ...await repo.tagList({ name, sort, noContains: options.commit }),
    ]
    : (await repo.tagList({ name, sort }));
  if (tag === undefined) return undefined;
  const version = tag.name?.split("@")[1];
  if (!version || !canParse(version)) {
    throw new PackageError(
      `Cannot parse semantic version from tag: ${tag.name}`,
    );
  }
  return { version, tag };
}

async function getUpdate(
  pkg: Package,
  options?: VersionOptions,
): Promise<Update | undefined> {
  const log = await git({ cwd: pkg.directory }).log({
    range: {
      ...pkg.release?.tag !== undefined && { from: pkg.release.tag },
      ...options?.commit !== undefined && { to: options.commit },
    },
    ...pkg.release?.tag === undefined && { paths: ["."] },
  });
  const changelog = log.map((c) => conventional(c)).filter((c) =>
    c.modules.includes(pkg.module) || c.modules.includes("*")
  );
  if (!changelog.length) return undefined;
  const type = (changelog.some((c) => c.breaking) &&
      parse(pkg?.version ?? "0.0.0").major > 0)
    ? "major"
    : (changelog.some((c) => c.type === "feat") ||
        changelog.some((c) => c.breaking))
    ? "minor"
    : "patch";
  const version = format(
    increment(parse(pkg.release?.version ?? "0.0.0"), type),
  );
  const tag = `${pkg.module}@${version}`;
  return { type, version, tag, changelog };
}

async function releaseBody(pkg: Package): Promise<string> {
  const title = pkg.release ? "Changelog" : "Initial release";
  const changelog = pkg.update?.changelog?.map((c) => ` * ${c.summary}`).join(
    "\n",
  );
  const repo = await github().repo();
  const fullChangelogUrl = pkg?.release
    ? `compare/${pkg.release.tag.name}...${pkg.update?.tag}}`
    : `commits/${pkg.update?.tag}/${pkg.directory}`;
  return [
    `## ${title}`,
    "",
    changelog,
    "",
    "## Details",
    "",
    ` * [Full changelog](${repo.url}/${fullChangelogUrl})`,
    ` * [Documentation](https://jsr.io/${pkg.update?.tag})`,
  ]
    .join("\n");
}

async function writeConfig(pkg: Package): Promise<void> {
  await Deno.mkdir(pkg.directory, { recursive: true });
  await Deno.writeTextFile(
    join(pkg.directory, "deno.json"),
    JSON.stringify(pkg.config, undefined, 2) + "\n",
  );
}

async function bumpVersions(
  repo: Repository,
  packages: Package[],
) {
  packages = packages.filter((pkg) => pkg.update);
  if (!packages.length) {
    console.log("🚫 No packages to bump.");
    return;
  }
  const title = "chore: release";
  const body = (await Promise.all(packages.map(async (pkg) => {
    return [
      `# ${pkg.module}@${pkg.update?.version}`,
      "",
      await releaseBody(pkg) ?? "",
    ];
  }))).flat().join("\n\n");
  /** @todo change release branch name */
  await repo.git.checkout({ newBranch: "test" });
  await Promise.all(packages.map(async (pkg) => {
    pkg.config.version = pkg.update?.version;
    await writeConfig(pkg);
  }));
  await repo.git.commit(title, { body, all: true });
  const [pr] = await repo.pulls.list({ title, isClosed: false });
  if (pr) {
    await repo.git.push({ force: true, branch: "test" }); // can this be done without force?
    pr.update({ body });
    console.log(`🤖 Updated release PR ${pr.number} (${pr.url})`);
  } else {
    await repo.git.push();
    const pr = await repo.pulls.create({ title, body, isDraft: true });
    console.log(`🤖 Created release PR ${pr.number} (${pr.url})`);
  }
}

async function createReleases(
  repo: Repository,
  commit: string,
  packages: Package[],
) {
  packages = packages.filter((pkg) => pkg.update);
  if (!packages.length) {
    console.log("🚫 No packages to release.");
    return;
  }
  const targets = await compileTargets();
  await pool(packages, async (pkg) => {
    assert(pkg.update, "Cannot release a package that has not been updated");
    const version = parse(pkg.update.version);
    const name = pkg.update.tag;
    const data = {
      name,
      body: await releaseBody(pkg),
      isDraft: true,
      isPreRelease: !!version.prerelease?.length,
      commit,
    };
    let [release] = await repo.releases.list({ name, isDraft: true });
    if (release) {
      release = await release.update(data);
      console.log(`🚀 Updated release ${release.name} (${release.url})`);
    } else {
      release = await repo.releases.create(name, { ...data });
      console.log(`🚀 Created release ${release.name} (${release.url})`);
    }
    if (pkg.config.compile) {
      const assets = await release.assets();
      await Promise.all(assets.map((asset) => asset.delete()));
      await Promise.all(targets.map(async (target) => {
        const artifacts = await compile(pkg, {
          target,
          update: true,
          bundle: true,
        });
        await Promise.all(artifacts.map(async (artifact) => {
          await release.upload(artifact);
          console.log(
            `🏺 Uploaded ${basename(artifact)} to release ${release.name}`,
          );
          return artifact;
        }));
      }));
    }
  });
}

function output(packages: Package[], changelog: boolean) {
  new Table().body(
    packages.map((pkg) => [
      "📦",
      pkg.directory,
      pkg.config.name,
      pkg.config.version,
      ...pkg.update ? ["👉", pkg.update?.version, `[${pkg.update?.type}]`] : [],
    ]),
  ).render();
  if (changelog) {
    if (packages.some((pkg) => pkg.update)) console.log();
    for (const pkg of packages) {
      if (pkg.update) {
        console.log(`📝 ${pkg.config.name} [${pkg.version}]`);
        console.log();
        for (const commit of pkg.update.changelog ?? []) {
          console.log(`     ${commit.short} ${commit.summary}`);
        }
        console.log();
      }
    }
  }
}

async function main(args: string[]) {
  const [head] = await git().log();
  if (!head) throw new PackageError("Cannot determine current commit");
  const command = new Command()
    .name("packages")
    .description("Manage workspace packages.")
    .version(await displayVersion())
    .arguments("[directories...:file]")
    .option(
      "--commit=<string>",
      "Calculate changes over given commit or symbolic ref.",
      { default: head.hash },
    )
    .option("--changelog", "Prints changelog for updated packages.", {
      default: false,
    })
    .option("--bump", "Updates packages versions, and creates a release PR.", {
      default: false,
    })
    .option("--release", "Creates draft releases for updated packages.", {
      default: false,
    })
    .env(
      "GITHUB_ACTOR=<actor:string>",
      "GitHub user that triggered the bump or release.",
      { prefix: "GITHUB_" },
    )
    .env(
      "GITHUB_EMAIL=<email:string>",
      "E-mail of GitHub user that triggered the bump or release.",
      { prefix: "GITHUB_" },
    )
    .env(
      "GITHUB_TOKEN=<token:string>",
      "GitHub personal token for GitHub actions.",
      { required: true, prefix: "GITHUB_" },
    )
    .action(
      async (
        { commit, changelog, bump, release, target, actor, email, token },
        ...directories
      ) => {
        if (directories.length === 0) directories = ["."];
        const packages = await getWorkspace({
          directories,
          version: { commit },
        });
        const repo = await github({ token }).repo();
        await repo.git.config({
          user: {
            ...actor && { name: actor },
            ...email && { email },
          },
        });
        output(packages, changelog);
        if (bump) await bumpVersions(repo, packages);
        if (release) await createReleases(repo, commit, packages);
      },
    );
  await command.parse(args);
}

if (import.meta.main) await main(Deno.args);

import { Command, EnumType } from "@cliffy/command";
import { assert } from "@std/assert/assert";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding";
import { basename, join, relative } from "@std/path";
import { pool } from "@tugrulates/internal/async";
import {
  displayVersion,
  getWorkspace,
  type Package,
  PackageError,
} from "@tugrulates/internal/package";

/** Options for compiling a package. */
export interface CompileOptions {
  /** Print detailed command output. */
  verbose?: boolean;
  /** Target OS architecture. */
  target?: string;
  /** Use update version. */
  update?: boolean;
  /** Bundle artifacts. */
  bundle?: boolean;
  /** Install artifacts at given directory. */
  install?: string;
}

/** Return all compile targets support by `deno compile`. */
export async function compileTargets(): Promise<string[]> {
  const command = new Deno.Command("deno", { args: ["compile", "--target"] });
  const { code, stderr } = await command.output();
  assert(code !== 0, "Expected the command to fail");
  const match = new TextDecoder().decode(stderr).match(
    /\[possible values: (?<targets>.+)\]/,
  );
  assert(match?.groups?.targets, "Expected targets in stderr");
  return match.groups.targets.split(", ");
}

/** Compile a package using the given options. */
export async function compile(
  pkg: Package,
  options?: CompileOptions,
): Promise<string[]> {
  assert(pkg.config.compile, "Compile configuration is required");
  const { target = Deno.build.target } = options ?? {};
  const version = options?.update ? pkg.update?.version : pkg.version;
  if (!version) {
    throw new PackageError(`Cannot determine version for ${pkg.config.name}`);
  }
  const directory = join("dist", pkg.module, version, target);
  const output = join(directory, pkg.module);
  try {
    await Deno.remove(directory, { recursive: true });
  } catch (e: unknown) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  await Deno.mkdir(directory, { recursive: true });
  const config = join(directory, "deno.json");
  pkg.config.version = version;
  await Deno.writeTextFile(config, JSON.stringify(pkg.config, null, 2));
  const { main, include = [], kv = false, permissions = [] } =
    pkg.config.compile ?? {};
  assert(main, "Compile entrypoint is required");
  const read = permissions.filter((p) => p.name === "read") ?? [];
  const write = permissions.filter((p) => p.name === "write") ?? [];
  const net = permissions.filter((p) => p.name === "net") ?? [];
  const env = permissions.filter((p) => p.name === "env") ?? [];
  const run = permissions.filter((p) => p.name === "run") ?? [];
  const sys = permissions.filter((p) => p.name === "sys") ?? [];
  const ffi = permissions.filter((p) => p.name === "ffi") ?? [];
  const args = [
    "compile",
    `--target=${target}`,
    permissionArgs("read", read.map((p) => p.path), false),
    permissionArgs("write", write.map((p) => p.path), false),
    permissionArgs("net", net.map((p) => p.host), false),
    permissionArgs("env", env.map((p) => p.variable), true),
    permissionArgs("run", run.map((p) => p.command), true),
    permissionArgs("sys", sys.map((p) => p.kind), true),
    permissionArgs("ffi", ffi.map((p) => p.path), false),
    "--no-prompt",
    kv ? "--unstable-kv" : [],
    `--include=${config}`,
    include.map((path) => `--include=${join(pkg.directory, path)}`),
    `--output=${output}`,
    join(pkg.directory, main),
  ].flat();
  const command = new Deno.Command("deno", {
    args,
    stdout: options?.verbose ? "inherit" : "null",
    stderr: options?.verbose ? "inherit" : "null",
  });
  const { code } = await command.output();
  if (code !== 0) {
    throw new PackageError(`Compile failed for ${pkg.config.name}`);
  }
  if (options?.install) {
    await Deno.mkdir(options.install, { recursive: true });
    await Deno.copyFile(
      output,
      join(options.install, relative(directory, output)),
    );
  }
  if (!options?.bundle) return [output];
  const isWindows = target.includes("windows");
  const bundle = `${directory}.${isWindows ? "zip" : "tar.gz"}`;
  await (isWindows ? zip : tar)(directory, bundle);
  const checksum = encodeHex(
    await crypto.subtle.digest("SHA-256", await Deno.readFile(bundle)),
  );
  const checksumFile = `${bundle}.sha256sum`;
  await Deno.writeTextFile(checksumFile, `${checksum}  ${basename(bundle)}`);
  return [bundle, `${bundle}.sha256sum`];
}

function permissionArgs(
  name: string,
  values: (string | URL | undefined)[],
  merge: boolean,
): string[] {
  if (values.length === 0) return [];
  if (values.some((v) => v === undefined)) return [`--allow-${name}`];
  if (merge) return [`--allow-${name}=${values.join(",")}`];
  return values.map((v) => `--allow-${name}=${v}`);
}

async function tar(directory: string, output: string) {
  const command = new Deno.Command("tar", {
    args: ["-czf", output, "-C", directory, "."],
  });
  const { code } = await command.output();
  if (code !== 0) throw new PackageError(`Bundle failed for ${output}`);
}

async function zip(directory: string, output: string) {
  const command = new Deno.Command("zip", {
    cwd: directory,
    args: ["-r", relative(directory, output), "."],
  });
  const { code } = await command.output();
  if (code !== 0) throw new PackageError(`Bundle failed for ${output}`);
}

async function main(args: string[]) {
  const command = new Command()
    .name("compile")
    .description("Compile packages.")
    .version(await displayVersion())
    .arguments("[directories...:file]")
    .type("target", new EnumType(await compileTargets()))
    .option("--verbose", "Print detailed command output.", { default: false })
    .option("--target=<target:target>", "Target OS architecture.")
    .option("--update", "Use update version.", { default: false })
    .option("--bundle", "Zip and bundle artfifacts.", { default: false })
    .option("--install=<string>", "Install artifacts at given directory.")
    .action(
      async (options, ...directories) => {
        if (directories.length === 0) directories = ["."];
        const packages = await getWorkspace({ directories });
        // await Promise.all(
        //   packages
        //     .filter((pkg) => pkg.config.compile)
        //     .map(async (pkg) => {
        //       const artifact = await compile(pkg, options);
        //       console.log(
        //         `🏺 Compiled ${pkg.module}${
        //           options.target ? ` for ${options.target}` : ""
        //         } (${artifact})`,
        //       );
        //     }),
        // );
        await pool(
          packages.filter((pkg) => pkg.config.compile),
          async (pkg) => {
            if (pkg.config.compile) {
              const artifact = await compile(pkg, options);
              console.log(`🏺 Compiled ${pkg.module} (${artifact})`);
            }
          },
        );
      },
    );
  await command.parse(args);
}

if (import.meta.main) await main(Deno.args);

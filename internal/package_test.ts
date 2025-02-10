import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path/join";
import { conventional, type Git, git } from "@tugrulates/internal/git";
import {
  type Config,
  getPackage,
  getWorkspace,
} from "@tugrulates/internal/package";

async function tempRepo(
  { bare, clone, remote }: { bare?: boolean; clone?: Git; remote?: string } =
    {},
): Promise<Git & AsyncDisposable> {
  const cwd = await Deno.makeTempDir();
  const config = {
    user: { name: "A U Thor", email: "author@example.com" },
    commit: { gpgsign: false },
    tag: { gpgsign: false },
  };
  bare ??= false;
  const repo = git({ cwd });
  if (clone) {
    await git({ cwd }).clone(clone.directory, {
      bare,
      config,
      ...remote && { remote },
    });
  } else {
    await repo.init({ bare });
    await repo.config(config);
  }
  Object.assign(repo, {
    [Symbol.asyncDispose]: () =>
      Deno.remove(repo.directory, { recursive: true }),
  });
  return repo as Git & AsyncDisposable;
}

async function createPackage(
  directory: string,
  options?: Partial<Config>,
): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "deno.json"),
    JSON.stringify({ ...options }),
  );
}

Deno.test("getPackage() fails on non-Deno package", async () => {
  await using repo = await tempRepo();
  await assertRejects(() => getPackage({ directory: repo.directory }));
});

Deno.test("getPackage() returns current package", async () => {
  const pkg = await getPackage();
  assertEquals(pkg.config.name, "@tugrulates/internal");
});

Deno.test("getPackage() returns given package", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module" });
  assertEquals(await getPackage({ directory: repo.directory }), {
    directory: repo.directory,
    module: "module",
    config: { name: "@scope/module" },
  });
});

Deno.test("getPackage() returns release version at release commit", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module", version: "1.2.3" });
  await repo.commit("initial", { allowEmpty: true });
  await repo.tag("module@1.2.4");
  const pkg = await getPackage({ directory: repo.directory });
  assertEquals(pkg.version, "1.2.4");
  assertEquals(pkg.release?.version, "1.2.4");
  assertEquals(pkg.release?.tag?.name, "module@1.2.4");
  assertEquals(pkg.update, undefined);
});

Deno.test("getPackage() can return config version", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module", version: "1.2.3" });
  const pkg = await getPackage({
    directory: repo.directory,
    version: { config: true },
  });
  assertEquals(pkg.version, "1.2.3");
  assertEquals(pkg.release, undefined);
  assertEquals(pkg.update, undefined);
});

Deno.test("getPackage() calculates patch version update", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module", version: "1.2.3" });
  await repo.commit("initial", { allowEmpty: true });
  await repo.tag("module@1.2.3");
  const commit = await repo.commit("fix(module): patch", { allowEmpty: true });
  const pkg = await getPackage({ directory: repo.directory });
  assertEquals(pkg.version, `1.2.4-pre.1+${commit.short}`);
  assertEquals(pkg.release?.version, "1.2.3");
  assertEquals(pkg.update?.type, "patch");
  assertEquals(pkg.update?.version, "1.2.4");
  assertEquals(pkg.update?.tag, "module@1.2.4");
  assertEquals(pkg.update?.changelog, [conventional(commit)]);
});

Deno.test("getPackage() calculates minor version update", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module", version: "1.2.3" });
  await repo.commit("initial", { allowEmpty: true });
  await repo.tag("module@1.2.3");
  const commit = await repo.commit("feat(module): minor", { allowEmpty: true });
  const pkg = await getPackage({ directory: repo.directory });
  assertEquals(pkg.version, `1.3.0-pre.1+${commit.short}`);
  assertEquals(pkg.release?.version, "1.2.3");
  assertEquals(pkg.update?.type, "minor");
  assertEquals(pkg.update?.version, "1.3.0");
  assertEquals(pkg.update?.tag, "module@1.3.0");
  assertEquals(pkg.update?.changelog, [conventional(commit)]);
});

Deno.test("getPackage() calculates major version update", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module", version: "1.2.3" });
  await repo.commit("initial", { allowEmpty: true });
  await repo.tag("module@1.2.3");
  const commit = await repo.commit("feat(module)!: major", {
    allowEmpty: true,
  });
  const pkg = await getPackage({ directory: repo.directory });
  assertEquals(pkg.version, `2.0.0-pre.1+${commit.short}`);
  assertEquals(pkg.release?.version, "1.2.3");
  assertEquals(pkg.update?.type, "major");
  assertEquals(pkg.update?.version, "2.0.0");
  assertEquals(pkg.update?.tag, "module@2.0.0");
  assertEquals(pkg.update?.changelog, [conventional(commit)]);
});

Deno.test("getPackage() handle multiple commits in changelog", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module", version: "1.2.3" });
  await repo.commit("initial", { allowEmpty: true });
  await repo.tag("module@1.2.3");
  const commit1 = await repo.commit("fix(module): 1", { allowEmpty: true });
  const commit2 = await repo.commit("feat(module): 2", { allowEmpty: true });
  const commit3 = await repo.commit("fix(module): 3", { allowEmpty: true });
  const pkg = await getPackage({ directory: repo.directory });
  assertEquals(pkg.version, `1.3.0-pre.3+${commit3.short}`);
  assertEquals(pkg.release?.version, "1.2.3");
  assertEquals(pkg.update?.type, "minor");
  assertEquals(pkg.update?.version, "1.3.0");
  assertEquals(pkg.update?.tag, "module@1.3.0");
  assertEquals(pkg.update?.changelog, [
    conventional(commit3),
    conventional(commit2),
    conventional(commit1),
  ]);
});

Deno.test("getPackage() can calculate version for a commit", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "@scope/module", version: "1.2.3" });
  await repo.commit("initial", { allowEmpty: true });
  await repo.tag("module@1.2.3");
  const commit = await repo.commit("feat(module): minor", { allowEmpty: true });
  await repo.commit("feat(module)!: major", { allowEmpty: true });
  await repo.tag("module@2.0.0");
  await repo.commit("fix(module): description", { allowEmpty: true });
  const pkg = await getPackage({
    directory: repo.directory,
    version: { commit: commit.hash },
  });
  assertEquals(pkg.version, `1.3.0-pre.1+${commit.short}`);
  assertEquals(pkg.release?.version, "1.2.3");
  assertEquals(pkg.update?.version, "1.3.0");
  assertEquals(pkg.update?.tag, "module@1.3.0");
  assertEquals(pkg.update?.changelog, [conventional(commit)]);
});

Deno.test("getWorkspace() returns non-workspace package", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "name", version: "version" });
  const packages = await getWorkspace({
    directories: [repo.directory],
    version: { config: true },
  });
  assertEquals(packages, [{
    directory: repo.directory,
    module: "name",
    version: "version",
    config: { name: "name", version: "version" },
  }]);
});

Deno.test("getWorkspace() returns workspace packages", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), {
    name: "root",
    workspace: ["./first", "./second"],
  });
  await createPackage(repo.path("first"), {
    name: "first",
    version: "first_version",
  });
  await createPackage(repo.path("second"), {
    name: "second",
    version: "second_version",
  });
  const packages = await getWorkspace({
    directories: [repo.directory],
    version: { config: true },
  });
  assertEquals(packages, [{
    directory: repo.directory,
    module: "root",
    config: { name: "root", workspace: ["./first", "./second"] },
  }, {
    directory: repo.path("first"),
    module: "first",
    version: "first_version",
    config: { name: "first", version: "first_version" },
  }, {
    directory: repo.path("second"),
    module: "second",
    version: "second_version",
    config: { name: "second", version: "second_version" },
  }]);
});

Deno.test("getWorkspace() returns nested workspace packages", async () => {
  await using repo = await tempRepo();
  await createPackage(repo.path(), { name: "root", workspace: ["./first"] });
  await createPackage(repo.path("first"), {
    name: "first",
    version: "first_version",
    workspace: ["./second"],
  });
  await createPackage(repo.path("first/second"), {
    name: "second",
    version: "second_version",
  });
  const packages = await getWorkspace({
    directories: [repo.directory],
    version: { config: true },
  });
  assertEquals(packages, [{
    directory: repo.directory,
    module: "root",
    config: { name: "root", workspace: ["./first"] },
  }, {
    directory: repo.path("first"),
    module: "first",
    version: "first_version",
    config: {
      name: "first",
      version: "first_version",
      workspace: ["./second"],
    },
  }, {
    directory: repo.path("first/second"),
    module: "second",
    version: "second_version",
    config: { name: "second", version: "second_version" },
  }]);
});

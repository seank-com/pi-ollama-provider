import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { loadOllamaProviderConfig, MAX_CONFIG_BYTES } from "../src/config.ts";

// The real POSIX filesystem through the production loader, in disposable
// test-owned projects. Ownership by another account needs privileges a test
// cannot assume; the injected-inspection unit tests cover that branch.

const CONFIG = JSON.stringify({
	schemaVersion: 1,
	baseUrl: "http://127.0.0.1:11434",
	models: { "qwen-test:latest": { displayName: "Q", contextWindow: 8192, maxOutputTokens: 1024, reasoning: false } },
});

async function project(t: TestContext, contents: string | Uint8Array = CONFIG) {
	const root = await mkdtemp(join(tmpdir(), "pi-ollama-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, ".pi", "ollama-provider");
	await mkdir(directory, { recursive: true });
	await chmod(root, 0o700);
	await chmod(join(root, ".pi"), 0o755);
	await chmod(directory, 0o700);
	const file = join(directory, "config.json");
	await writeFile(file, contents);
	await chmod(file, 0o600);
	return { root, directory, file };
}

const load = (root: string) => loadOllamaProviderConfig(root, { configDirName: ".pi" });

async function rejectsWith(root: string, code: string, detail?: RegExp) {
	await assert.rejects(load(root), (error: any) => {
		assert.equal(error.code, code);
		if (detail) assert.match(error.message, detail);
		return true;
	});
}

test("a protected real configuration loads; 0400 is stricter and accepted", { skip: process.platform === "win32" }, async (t) => {
	const { root, file } = await project(t);
	const config = await load(root);
	assert.equal(config.configPath, join(await realpath(root), ".pi", "ollama-provider", "config.json"));
	assert.equal(config.baseUrl, "http://127.0.0.1:11434");
	await chmod(file, 0o400);
	assert.equal((await load(root)).models.size, 1);
});

test("missing directories or file are CONFIG_MISSING", { skip: process.platform === "win32" }, async (t) => {
	const { root, file, directory } = await project(t);
	await rm(file);
	await rejectsWith(root, "CONFIG_MISSING");
	await rm(directory, { recursive: true });
	await rejectsWith(root, "CONFIG_MISSING");
});

test("group or world access on the file or directories fails closed", { skip: process.platform === "win32" }, async (t) => {
	for (const mode of [0o640, 0o604, 0o644, 0o660]) {
		const { root, file } = await project(t);
		await chmod(file, mode);
		await rejectsWith(root, "CONFIG_INVALID", /mode 0600 or stricter/);
	}
	for (const mode of [0o750, 0o705, 0o755]) {
		const { root, directory } = await project(t);
		await chmod(directory, mode);
		await rejectsWith(root, "CONFIG_INVALID", /protected modes/);
	}
	const writableParent = await project(t);
	await chmod(join(writableParent.root, ".pi"), 0o775);
	await rejectsWith(writableParent.root, "CONFIG_INVALID", /protected modes/);
	const writableRoot = await project(t);
	await chmod(writableRoot.root, 0o777);
	await rejectsWith(writableRoot.root, "CONFIG_INVALID", /protected modes/);
});

test("symlinked configuration files and directories are refused", { skip: process.platform === "win32" }, async (t) => {
	const linkedFile = await project(t);
	const elsewhere = join(linkedFile.root, "real-config.json");
	await writeFile(elsewhere, CONFIG, { mode: 0o600 });
	await rm(linkedFile.file);
	await symlink(elsewhere, linkedFile.file);
	await rejectsWith(linkedFile.root, "CONFIG_INVALID");

	const linkedDirectory = await project(t);
	const realDirectory = join(linkedDirectory.root, "real-provider-dir");
	await mkdir(realDirectory, { mode: 0o700 });
	await writeFile(join(realDirectory, "config.json"), CONFIG, { mode: 0o600 });
	await rm(linkedDirectory.directory, { recursive: true });
	await symlink(realDirectory, linkedDirectory.directory);
	await rejectsWith(linkedDirectory.root, "CONFIG_INVALID", /protected modes/);
});

test("oversized and non-UTF-8 files fail closed; strict JSON rules still apply", { skip: process.platform === "win32" }, async (t) => {
	const oversized = await project(t, `${CONFIG}${" ".repeat(MAX_CONFIG_BYTES)}`);
	await rejectsWith(oversized.root, "CONFIG_INVALID", /at most 64 KiB/);
	const invalidUtf8 = await project(t, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
	await rejectsWith(invalidUtf8.root, "CONFIG_INVALID", /UTF-8/);
	const duplicate = await project(t, "{\"schemaVersion\":1,\"schemaVersion\":1}");
	await rejectsWith(duplicate.root, "CONFIG_INVALID", /duplicate JSON key/);
});

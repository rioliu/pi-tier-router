import assert from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Isolated install dir: the extension file and its config must travel together,
// so the test copies the extension into a temp "extensions" dir and imports it
// from there. PI_CODING_AGENT_DIR points at the temp agent dir because the
// module snapshots the default model at import (LOAD_DEFAULT).
const root = mkdtempSync(path.join(os.tmpdir(), "auto-router-root-"));
mkdirSync(path.join(root, "extensions"));
const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "auto-router.ts");
const COPY = path.join(root, "extensions", "auto-router.ts");
copyFileSync(REAL, COPY);
writeFileSync(path.join(root, "settings.json"), JSON.stringify({ defaultProvider: "router", defaultModel: "auto" }));
process.env.PI_CODING_AGENT_DIR = root;

const { chooseRating, parseRole, parseSelfRating, checkConfig, writeOwnConfig } = await import(
	pathToFileURL(COPY).href
);

const CONFIG = path.join(root, "extensions", "auto-router.json");
const FALLBACK = { provider: "cc-switch-xiaomi-mi-mo-token-plan-china", id: "mimo-v2.6-flash" };
const MIMO = FALLBACK.provider;

const ownConfig = (value: Record<string, unknown> | null) =>
	value === null ? rmSync(CONFIG, { force: true }) : writeFileSync(CONFIG, JSON.stringify(value));

function registry(models: { provider: string; id: string }[]) {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
	} as never;
}
const noModels = registry([]);
const mimoPair = registry([
	{ provider: MIMO, id: "mimo-v2.6-flash" },
	{ provider: MIMO, id: "mimo-v2.6-pro" },
]);
const deepseekPair = registry([
	{ provider: "deepseek", id: "deepseek-v4-flash" },
	{ provider: "deepseek", id: "deepseek-v4-pro" },
]);

function collector(reg: unknown) {
	const calls: [string, string | undefined][] = [];
	return {
		calls,
		ctx: { modelRegistry: reg, hasUI: true, ui: { notify: (m: string, t?: string) => calls.push([m, t]) } },
	};
}
const writeSettings = (value: Record<string, unknown>) =>
	writeFileSync(path.join(root, "settings.json"), JSON.stringify(value));

async function run() {
	let calls, ctx;

	// A. default is router/auto but the pair is missing -> error, once
	({ calls, ctx } = collector(noModels));
	checkConfig(ctx);
	assert.equal(calls.length, 1, "expected exactly one notification");
	assert.equal(calls[0][1], "error");
	assert.match(calls[0][0], /cannot route/);
	checkConfig(ctx);
	assert.equal(calls.length, 1, "repeated checks must not re-announce the same issue");

	// B. user changes the default away from the router -> info only, and no
	//    pair warning while the extension has no config of its own
	writeSettings({ defaultProvider: "mimo-v2.6-flash", defaultModel: "mimo-v2.6-flash" });
	({ calls, ctx } = collector(noModels));
	checkConfig(ctx);
	assert.equal(calls.length, 1, "unconfigured install stays quiet about the pair");
	assert.equal(calls[0][1], "info");
	assert.match(calls[0][0], /no longer the default/);

	// C. own config present and pair resolvable -> silent; roles re-read from
	//    the extension dir without a restart
	ownConfig({ "flash-model": "deepseek/deepseek-v4-flash", "pro-model": "deepseek/deepseek-v4-pro" });
	({ calls, ctx } = collector(deepseekPair));
	checkConfig(ctx);
	assert.equal(calls.length, 0, "configured pair found -> no warnings");

	// D. provider config rewritten so the configured pair is gone -> warning
	({ calls, ctx } = collector(noModels));
	checkConfig(ctx);
	assert.equal(calls.length, 1, "configured-but-missing pair must be reported");
	assert.equal(calls[0][1], "warning");
	assert.match(calls[0][0], /pair not found/);

	// E. pair returns -> clears; vanishes again -> re-announced
	({ calls, ctx } = collector(deepseekPair));
	checkConfig(ctx);
	assert.equal(calls.length, 0, "restored pair -> no notification");
	({ calls, ctx } = collector(noModels));
	checkConfig(ctx);
	assert.equal(calls.length, 1, "issue re-announced after being cleared");

	// writeOwnConfig: wizard persistence, in the extension dir only
	ownConfig(null);
	const written = writeOwnConfig("provB/flashB", "provB/proB");
	assert.ok(written, "config is written next to the extension file");
	// /var is a symlink to /private/var on macOS; compare real paths.
	assert.equal(realpathSync(written), realpathSync(CONFIG), "config path must be the extension dir");
	assert.deepEqual(JSON.parse(readFileSync(CONFIG, "utf8")), {
		"flash-model": "provB/flashB",
		"pro-model": "provB/proB",
	});
	// roles refresh immediately (no restart): the provB pair now resolves
	const provBPair = registry([
		{ provider: "provB", id: "flashB" },
		{ provider: "provB", id: "proB" },
	]);
	({ calls, ctx } = collector(provBPair));
	checkConfig(ctx);
	assert.equal(calls.length, 0, "new roles resolve without restarting Pi");
	// the previously configured pair is gone under the new roles -> reported
	({ calls, ctx } = collector(mimoPair));
	checkConfig(ctx);
	assert.equal(calls.length, 1, "stale pair reported after the roles changed");
	assert.equal(calls[0][1], "warning");
	// and pi's settings were never written
	assert.deepEqual(JSON.parse(readFileSync(path.join(root, "settings.json"), "utf8")), {
		defaultProvider: "mimo-v2.6-flash",
		defaultModel: "mimo-v2.6-flash",
	});

	// chooseRating chain ------------------------------------------------------
	let counter = { self: 0, jev: 0 };
	const reset = () => (counter = { self: 0, jev: 0 });
	const selfDep = (rated: "flash" | "pro", confidence: number) => async () => (counter.self++, { rated, confidence });
	const jevDep = (value: "flash" | "pro" | undefined) => async () => (counter.jev++, value);

	reset();
	let r = await chooseRating({ self: selfDep("pro", 0.95), jev: jevDep("flash") });
	assert.deepEqual(r, { rated: "pro", source: "self" });
	assert.equal(counter.jev, 0, "Jev must not be called when the flash model is confident");

	reset();
	r = await chooseRating({ self: selfDep("flash", 0.99), jev: jevDep("pro") });
	assert.deepEqual(r, { rated: "flash", source: "self" });
	assert.equal(counter.jev, 0);

	reset();
	r = await chooseRating({ self: selfDep("flash", 0.55), jev: jevDep("pro") });
	assert.deepEqual(r, { rated: "pro", source: "jev" });
	assert.equal(counter.jev, 1, "Jev consulted exactly once when unsure");

	reset();
	r = await chooseRating({ self: selfDep("pro", 0.6) });
	assert.deepEqual(r, { rated: "pro", source: "self" });

	reset();
	r = await chooseRating({ self: selfDep("pro", 0.6), jev: jevDep(undefined) });
	assert.deepEqual(r, { rated: "pro", source: "self" });

	reset();
	r = await chooseRating({ keep: "pro", self: undefined, jev: jevDep(undefined) });
	assert.deepEqual(r, { rated: "pro", source: "keep" });
	assert.equal(counter.jev, 1, "Jev still tried once before giving up");

	reset();
	r = await chooseRating({ self: undefined, jev: jevDep(undefined) });
	assert.deepEqual(r, { rated: "flash", source: "keep" });

	reset();
	r = await chooseRating({ keep: "flash", self: undefined, jev: jevDep("pro") });
	assert.deepEqual(r, { rated: "pro", source: "jev" });

	reset();
	r = await chooseRating({ keep: "pro", self: async () => (counter.self++, undefined) });
	assert.deepEqual(r, { rated: "pro", source: "keep" });
	assert.equal(counter.jev, 0, "Jev not attempted when its dependency is absent");

	reset();
	r = await chooseRating({ self: selfDep("flash", 0.8), jev: jevDep("pro") });
	assert.equal(counter.jev, 0, "confidence exactly at the bar counts as confident");

	reset();
	r = await chooseRating({ self: selfDep("flash", 0.79), jev: jevDep("pro") });
	assert.equal(counter.jev, 1);

	const lines: string[] = [];
	await chooseRating({ keep: "flash", trace: (line) => lines.push(line) });
	assert.deepEqual(lines, ["self unavailable", "jev=unavailable", "no rater available, keeping flash"]);

	// parseSelfRating ---------------------------------------------------------
	assert.deepEqual(parseSelfRating('{"rating":"pro","confidence":0.9}'), { rated: "pro", confidence: 0.9 });
	assert.deepEqual(parseSelfRating('Here:\n```json\n{"rating":"flash","confidence":0.7}\n```'), {
		rated: "flash",
		confidence: 0.7,
	});
	assert.deepEqual(parseSelfRating('{"rating":"pro","confidence":3}'), { rated: "pro", confidence: 1 });
	assert.deepEqual(parseSelfRating('{"rating":"pro"}'), { rated: "pro", confidence: 0 });
	assert.equal(parseSelfRating("not json at all"), undefined);
	assert.equal(parseSelfRating('{"rating":"medium","confidence":0.9}'), undefined);
	assert.equal(parseSelfRating(""), undefined);

	// parseRole ---------------------------------------------------------------
	assert.deepEqual(parseRole("deepseek/deepseek-v4-flash", FALLBACK), {
		provider: "deepseek",
		id: "deepseek-v4-flash",
	});
	assert.deepEqual(parseRole("openrouter/typesafe/jev-1.13", FALLBACK), {
		provider: "openrouter",
		id: "typesafe/jev-1.13",
	});
	assert.equal(parseRole("bare-model-id", FALLBACK), FALLBACK);
	assert.equal(parseRole("", FALLBACK), FALLBACK);
	assert.equal(parseRole("prov/", FALLBACK), FALLBACK);
	assert.equal(parseRole("/id", FALLBACK), FALLBACK);
	assert.equal(parseRole(null, FALLBACK), FALLBACK);
	assert.equal(parseRole(42, FALLBACK), FALLBACK);
	assert.equal(parseRole(undefined, FALLBACK), FALLBACK);

	console.log("all checkConfig + writeOwnConfig + chooseRating + parseRole + parseSelfRating assertions passed");
}

run()
	.catch((e) => {
		console.error("FAILED:", e);
		process.exitCode = 1;
	})
	.finally(() => rmSync(root, { recursive: true, force: true }));

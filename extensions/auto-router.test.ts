import assert from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const { default: factory, chooseRating, decideLocally, stats, parseRole, parseSelfRating, checkConfig, writeOwnConfig } =
	await import(pathToFileURL(COPY).href);

// Package installs keep their config next to their own extension file, with an
// older <agent-dir>/extensions copy read as a fallback until it is superseded.
const PKG_EXTENSIONS = path.join(root, "git", "github.com", "rioliu", "pi-tier-router", "extensions");
mkdirSync(PKG_EXTENSIONS, { recursive: true });
const PKG_COPY = path.join(PKG_EXTENSIONS, "auto-router.ts");
copyFileSync(COPY, PKG_COPY);
const pkgMod = await import(pathToFileURL(PKG_COPY).href);

const CONFIG = path.join(root, "extensions", "auto-router.json");
const FALLBACK = { provider: "cc-switch-xiaomi-mi-mo-token-plan-china", id: "mimo-v2.6-flash" };
const MIMO = FALLBACK.provider;

const ownConfig = (value: Record<string, unknown> | null) =>
	value === null ? rmSync(CONFIG, { force: true }) : writeFileSync(CONFIG, JSON.stringify(value));

function registry(models: { provider: string; id: string }[]) {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
		// Nothing in these tests may reach a model: the rating chain must
		// treat this as "rater unavailable" and fall through.
		complete: async () => {
			throw new Error("no completion in tests");
		},
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
	// pi's settings were never written
	assert.deepEqual(JSON.parse(readFileSync(path.join(root, "settings.json"), "utf8")), {
		defaultProvider: "mimo-v2.6-flash",
		defaultModel: "mimo-v2.6-flash",
	});

	// a package install keeps its config next to its own code, so uninstalling
	// the extension takes the config with it
	const pkgWritten = pkgMod.writeOwnConfig("provC/flashC", "provC/proC");
	assert.equal(
		realpathSync(pkgWritten),
		realpathSync(path.join(PKG_EXTENSIONS, "auto-router.json")),
		"package installs keep config next to the extension file",
	);
	assert.ok(
		pkgWritten.includes(`${path.sep}git${path.sep}`),
		"config lives inside the package directory",
	);
	assert.ok(!existsSync(CONFIG), "an older <agent-dir>/extensions copy is superseded, not stranded");

	// ...and when only that older copy exists, the package install still reads it
	// (restore the default first so no unrelated default-change info muddies this)
	rmSync(path.join(PKG_EXTENSIONS, "auto-router.json"), { force: true });
	writeSettings({ defaultProvider: "router", defaultModel: "auto" });
	writeFileSync(CONFIG, JSON.stringify({ "flash-model": "provL/flashL", "pro-model": "provL/proL" }));
	const provLPair = registry([
		{ provider: "provL", id: "flashL" },
		{ provider: "provL", id: "proL" },
	]);
	({ calls, ctx } = collector(provLPair));
	pkgMod.checkConfig(ctx);
	assert.equal(calls.length, 0, "legacy config is read when the package config is absent");
	({ calls, ctx } = collector(noModels));
	pkgMod.checkConfig(ctx);
	assert.equal(calls.length, 1, "and it is the legacy roles that get resolved");
	assert.equal(calls[0][1], "error", "default is router/auto, so a pair that cannot resolve is an error");

	// load-time migration moves that older copy next to the code, so an
	// uninstall takes the config with it even if the wizard never ran
	const moved = pkgMod.migrateLegacyConfig();
	assert.ok(moved, "migration reports the new location");
	assert.equal(
		realpathSync(moved),
		realpathSync(path.join(PKG_EXTENSIONS, "auto-router.json")),
		"legacy config moved next to the extension file",
	);
	assert.ok(!existsSync(CONFIG), "and the old copy is gone");
	assert.deepEqual(JSON.parse(readFileSync(path.join(PKG_EXTENSIONS, "auto-router.json"), "utf8")), {
		"flash-model": "provL/flashL",
		"pro-model": "provL/proL",
	}, "the moved config keeps its contents");

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
	await chooseRating({ keep: "flash", trace: (line: string) => lines.push(line) });
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

	// decideLocally: layer 0 decides from the prompt alone ----------------------
	const localCases: [string, "flash" | "pro" | undefined, string?][] = [
		["hi", "flash", "trivial"],
		["explain what this function does", "flash", "lookup"],
		["fix the typo in the README", "flash", "small-edit"],
		["TypeError: x is not a function\n    at run (/app/src/index.ts:42:11)", "pro", "stack-trace"],
		["eliminate the race condition in the worker pool", "pro", "concurrency"],
		["refactor authentication across all services", "pro", "architecture"],
		["fix the failing test", undefined], // medium work: abstain, chain decides
		["add a button to the header", undefined],
		["", undefined],
		["fix the race condition in the task queue right now, or is this just a typo in the comment?", undefined],
		// Chinese: same table, no \b anchors, full-width ？ counts as a question
		["这个死锁很难复现，帮我排查一下", "pro", "cn-concurrency"],
		["把文档里的错别字改一下", "flash", "cn-small-edit"],
		["你好", "flash", "cn-trivial"],
		// a "what is ..." question is an explanation: flash wins over the hard topic
		["什么是竞态条件？", "flash", "cn-lookup"],
		["修复一下，现在还是有报错", undefined], // medium: abstain, chain decides
	];
	for (const [prompt, expected, signal] of localCases) {
		const decision = decideLocally(prompt);
		assert.equal(
			decision?.rated,
			expected,
			`decideLocally(${JSON.stringify(prompt)}) -> ${decision?.rated ?? "abstain"}`,
		);
		if (decision) {
			assert.ok(decision.confidence >= 0.85 && decision.confidence <= 0.97, "confidence stays in band");
			if (signal) assert.ok(decision.signals.includes(signal), `expected ${signal} in ${decision.signals.join("+")}`);
		}
	}
	// shape features: two code blocks, 1000+ chars, several file paths
	const big =
		"```ts\n" +
		"export const a = 1; // src/app.ts\n".repeat(40) +
		"```\n```js\n" +
		"export const b = 2; // lib/util.js\n".repeat(30) +
		"```\ncoordinate this across all services: config.yaml, main.tf and Makefile must change together";
	const bigDecision = decideLocally(big);
	assert.equal(bigDecision?.rated, "pro", "large multi-file change goes to pro");
	assert.ok(bigDecision.signals.includes("big-context") && bigDecision.signals.includes("multi-file"));

	// before_agent_start -> route(): one prompt, one decision -------------------
	ownConfig({ "flash-model": `${MIMO}/mimo-v2.6-flash`, "pro-model": `${MIMO}/mimo-v2.6-pro` });
	const handlers = new Map<string, any>();
	let routed: any;
	factory({
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerVirtualModel: (spec: any) => {
			routed = spec.route;
		},
		unregisterVirtualModel: () => {},
		registerCommand: () => {},
	});
	assert.equal(typeof routed, "function", "router registers when config exists");

	const mimoReg = registry([
		{ provider: MIMO, id: "mimo-v2.6-flash" },
		{ provider: MIMO, id: "mimo-v2.6-pro" },
	]);
	const wireCtx: any = { modelRegistry: mimoReg, model: { provider: "router", id: "auto" }, hasUI: false };
	const userReq = (prompt: string, reason = "user") => ({
		reason,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		thinkingLevel: "medium",
		state: undefined,
		previous: undefined,
		signal: undefined,
	});
	const fire = (event: string, payload?: unknown, ctx: unknown = wireCtx) => handlers.get(event)!(payload, ctx);
	const modelOf = (r: any) => `${r.model.provider}/${r.model.id}`;
	const savedJevKey = process.env.JEVMODEL_API_KEY;
	delete process.env.JEVMODEL_API_KEY;

	fire("session_start", {}); // resets the tally and re-checks config
	assert.equal(stats.prompts, 0, "session_start resets the tally");

	// trivial prompt: decided locally, no rater ever called
	fire("before_agent_start", { prompt: "hi" });
	assert.equal(stats.prompts, 1);
	assert.equal(stats.local, 1);
	const localFlash = await routed(userReq("hi"), wireCtx);
	assert.equal(modelOf(localFlash), `${MIMO}/mimo-v2.6-flash`, "trivial prompt routes to flash");
	assert.equal(localFlash.state.source, "local");
	// a tool-loop continuation inside the same run reuses that decision
	const continuation = await routed(userReq("tool result", "tool"), wireCtx);
	assert.equal(modelOf(continuation), `${MIMO}/mimo-v2.6-flash`, "continuation keeps the turn's decision");
	assert.equal(stats.self, 0, "no rating call when the local layer decided");

	// stack trace: pro, still decided locally
	fire("agent_end");
	const stackPrompt = "TypeError: boom\n    at run (/app/x.ts:1:1)";
	fire("before_agent_start", { prompt: stackPrompt });
	const localPro = await routed(userReq(stackPrompt), wireCtx);
	assert.equal(modelOf(localPro), `${MIMO}/mimo-v2.6-pro`, "stack trace routes to pro");
	assert.equal(stats.local, 2);

	// ambiguous prompt: local abstains, the chain decides (no rater reachable
	// here and no Jev key, so the branch keeps its current model)
	fire("agent_end");
	fire("before_agent_start", { prompt: "add a button to the header" });
	assert.equal(stats.abstain, 1, "ambiguous prompt is counted as an abstain");
	const chained = await routed(userReq("add a button to the header"), wireCtx);
	assert.equal(modelOf(chained), `${MIMO}/mimo-v2.6-flash`, "chain keeps flash with no rater available");
	assert.equal(chained.state.source, "keep");
	assert.equal(stats.keep, 1);
	assert.equal(stats.jev, 0, "Jev stays untouched without its key");

	// another model selected: the router does not claim the prompt
	fire("agent_end");
	fire("before_agent_start", { prompt: "hi" }, { ...wireCtx, model: { provider: MIMO, id: "mimo-v2.6-flash" } });
	assert.equal(stats.prompts, 3, "prompts for another model are not counted");

	if (savedJevKey === undefined) delete process.env.JEVMODEL_API_KEY;
	else process.env.JEVMODEL_API_KEY = savedJevKey;

	console.log(
		"all checkConfig + writeOwnConfig + chooseRating + parseRole + parseSelfRating + decideLocally + hook/route assertions passed",
	);
}

run()
	.catch((e) => {
		console.error("FAILED:", e);
		process.exitCode = 1;
	})
	.finally(() => rmSync(root, { recursive: true, force: true }));

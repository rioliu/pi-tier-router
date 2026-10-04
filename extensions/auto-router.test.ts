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
const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const COPY = path.join(root, "extensions", "index.ts");
copyFileSync(REAL, COPY);
writeFileSync(path.join(root, "settings.json"), JSON.stringify({ defaultProvider: "router", defaultModel: "auto" }));
process.env.PI_CODING_AGENT_DIR = root;

const { default: factory, chooseRating, rateWithJev, decideLocally, analyzePrompt, textSketch, queryMemory, resetMemoryCache, reloadMemory, memoryEntries, MEMORY_RING, MEMORY_KEEP_LINES, stats, parseRole, parseSelfRating, checkConfig, writeOwnConfig } =
	await import(pathToFileURL(COPY).href);

// Package installs keep their config next to their own extension file, with an
// older <agent-dir>/extensions copy read as a fallback until it is superseded.
const PKG_EXTENSIONS = path.join(root, "git", "github.com", "rioliu", "pi-tier-router", "extensions");
mkdirSync(PKG_EXTENSIONS, { recursive: true });
const PKG_COPY = path.join(PKG_EXTENSIONS, "index.ts");
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

	// rateWithJev: the chain's Jev step, through Pi's classifier API ----------
	const liveSignal = new AbortController().signal; // never aborted
	const jevCtx = (reg: unknown) => ({ modelRegistry: reg }) as any;
	const classifierReg = (
		classify: (model: unknown, context: any, options?: any) => Promise<any>,
		available: unknown[] = [{ provider: "typesafe", id: "jev-latest" }],
	) => ({
		getAvailableOfType: async (type: string) => {
			assert.equal(type, "classifier", "the Jev step resolves a classifier model");
			return available;
		},
		classify,
	});
	const choiceResult = (choice: "flash" | "pro", pPro: number) => ({
		stopReason: "stop",
		answers: {
			difficulty: {
				type: "choice",
				choice,
				probabilities: { flash: 1 - pPro, pro: pPro },
				confidence: Math.max(pPro, 1 - pPro),
			},
		},
	});

	// confident pro over the bar -> pro, and the wire shape stays intact
	let seen: any;
	let rj = await rateWithJev(
		"fix the failing test",
		jevCtx(classifierReg(async (_m: unknown, context: any) => {
			seen = context;
			return choiceResult("pro", 0.9);
		})),
		liveSignal,
	);
	assert.equal(rj, "pro");
	assert.equal(seen.state.prompt, "fix the failing test", "prompt travels as classifier state");
	assert.equal(seen.questions.difficulty.type, "choice", "same typed question as before");

	// a Jev lean below the bar must not escalate
	rj = await rateWithJev("x", jevCtx(classifierReg(async () => choiceResult("pro", 0.6))), liveSignal);
	assert.equal(rj, "flash", `P(pro) must beat ${0.8} to escalate`);

	rj = await rateWithJev("x", jevCtx(classifierReg(async () => choiceResult("flash", 0.7))), liveSignal);
	assert.equal(rj, "flash");

	// no credentialed classifier -> Jev unavailable, classify never reached
	let classifyCalls = 0;
	rj = await rateWithJev(
		"x",
		jevCtx(classifierReg(async () => {
			classifyCalls++;
			return choiceResult("pro", 0.95);
		}, [])),
		liveSignal,
	);
	assert.equal(rj, undefined);
	assert.equal(classifyCalls, 0, "no classifier model -> no classify call");

	// provider error -> unavailable, the chain steps to the next rung
	rj = await rateWithJev(
		"x",
		jevCtx(classifierReg(async () => ({ stopReason: "error", errorMessage: "boom" }))),
		liveSignal,
	);
	assert.equal(rj, undefined);

	// our deadline fired (aborted while the caller is live) -> unavailable
	rj = await rateWithJev(
		"x",
		jevCtx(classifierReg(async () => ({ stopReason: "aborted" }))),
		liveSignal,
	);
	assert.equal(rj, undefined);

	// caller cancelled -> propagate; the chain must not swallow cancellation
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(
		rateWithJev(
			"x",
			jevCtx(classifierReg(async () => ({ stopReason: "aborted" }))),
			cancelled.signal,
		),
		(e: any) => e?.name === "AbortError",
	);

	// a Pi host without the classifier API steps over Jev entirely
	rj = await rateWithJev("x", jevCtx({}), liveSignal);
	assert.equal(rj, undefined);

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
	const commands = new Map<string, any>();
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
		registerCommand: (name: string, spec: any) => {
			commands.set(name, spec);
		},
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
	// here and no classifier configured, so the branch keeps its current model)
	fire("agent_end");
	fire("before_agent_start", { prompt: "add a button to the header" });
	assert.equal(stats.abstain, 1, "ambiguous prompt is counted as an abstain");
	const chained = await routed(userReq("add a button to the header"), wireCtx);
	assert.equal(modelOf(chained), `${MIMO}/mimo-v2.6-flash`, "chain keeps flash with no rater available");
	assert.equal(chained.state.source, "keep");
	assert.equal(stats.keep, 1);
	assert.equal(stats.jev, 0, "Jev never decides without a credentialed classifier");

	// another model selected: the router does not claim the prompt
	fire("agent_end");
	fire("before_agent_start", { prompt: "hi" }, { ...wireCtx, model: { provider: MIMO, id: "mimo-v2.6-flash" } });
	assert.equal(stats.prompts, 3, "prompts for another model are not counted");

	// ---- the decision store: chain verdicts become reusable examples ----
	const MEMORY_PATH = path.join(root, "extensions", "auto-router-memory.jsonl");
	rmSync(MEMORY_PATH, { force: true });
	resetMemoryCache();
	// a registry whose flash model answers the rating chain immediately
	const ratingReg: any = {
		find: (provider: string, id: string) =>
			[
				{ provider: MIMO, id: "mimo-v2.6-flash" },
				{ provider: MIMO, id: "mimo-v2.6-pro" },
			].find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
		complete: async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: '{"rating":"pro","confidence":0.95}' }],
		}),
	};
	wireCtx.modelRegistry = ratingReg;

	// profile fingerprint: language-neutral classes + one-hot margin band
	const en = analyzePrompt("fix the race condition in the queue");
	const zh = analyzePrompt("队列有竞态条件");
	assert.ok((en.profile & zh.profile & 0xffff) > 0, "en/zh deadlock prompts share a class bit");
	const enBand = (en.profile >>> 16) & 0x1f;
	assert.ok(enBand > 0 && (enBand & (enBand - 1)) === 0, "margin band is one-hot");
	assert.equal(analyzePrompt("").profile & 0xffff, 0, "no signals -> no classes to match on");

	// text sketch: deterministic, bounded, closer to rewording than to unrelated text
	const t1 = textSketch("fix the race condition in the worker pool queue");
	assert.deepEqual(
		Array.from(t1),
		Array.from(textSketch("fix the race condition in the worker pool queue")),
		"sketch is deterministic",
	);
	assert.ok(t1.length > 0 && t1.length <= 32, "sketch is bounded to 32 slots");
	const sharedSlots = (a: Uint32Array, b: Uint32Array) => {
		let i = 0;
		let j = 0;
		let s = 0;
		while (i < a.length && j < b.length) {
			if (a[i] === b[j]) {
				s++;
				i++;
				j++;
			} else if (a[i] < b[j]) i++;
			else j++;
		}
		return s;
	};
	const near = textSketch("race condition in the worker pool queue - the fix");
	const far = textSketch("summarize the quarterly newsletter draft");
	assert.ok(sharedSlots(t1, near) > sharedSlots(t1, far), "rewording shares more slots than unrelated text");

	// 1) abstain -> chain rates it -> verdict lands in the ring AND the journal
	const abstainPrompt = "fix the failing test in the queue"; // pro 2 / flash 1: abstain
	assert.equal(decideLocally(abstainPrompt), undefined, "prompt abstains locally");
	for (let i = 0; i < 3; i++) {
		fire("agent_end");
		fire("before_agent_start", { prompt: abstainPrompt });
		const run = await routed(userReq(abstainPrompt), wireCtx);
		assert.equal(modelOf(run), `${MIMO}/mimo-v2.6-pro`, "chain rated pro");
		assert.equal(run.state.source, "self");
	}
	assert.ok(existsSync(MEMORY_PATH), "journal created on the first abstain-zone verdict");
	const journal = readFileSync(MEMORY_PATH, "utf8").trim().split("\n");
	assert.equal(journal.length, 3, "one line per stored verdict");
	assert.equal(JSON.parse(journal[0]).label, "pro");
	assert.equal(stats.self, 3, "three rating calls, one per verdict");

	// 2) next session: the journal loads and the same prompt hits memory
	fire("agent_end");
	resetMemoryCache();
	const lookupsBefore = stats.memoryLookups;
	fire("before_agent_start", { prompt: abstainPrompt });
	assert.equal(stats.memoryLookups, lookupsBefore + 1, "abstain consults the store");
	assert.equal(stats.memoryReused, 1, "identical prompt reuses the stored verdict");
	const reused = await routed(userReq(abstainPrompt), wireCtx);
	assert.equal(modelOf(reused), `${MIMO}/mimo-v2.6-pro`, "memory serves pro");
	assert.equal(reused.state.source, "memory");
	assert.equal(stats.self, 3, "no extra rating call - memory decided");
	assert.ok(memoryEntries() >= 3, "ring loaded from the journal");

	// 3) a torn line is skipped, the store still serves
	writeFileSync(MEMORY_PATH, '{"t":1727800000,"cls":["debug"', { flag: "a" });
	fire("agent_end");
	resetMemoryCache();
	fire("before_agent_start", { prompt: abstainPrompt });
	assert.equal(stats.memoryReused, 2, "torn line skipped, store still serves");

	// 4) disagreeing neighbours: similarity proposes, the vote decides -> no reuse
	const otherPrompt = "refactor the pipeline across all services";
	const otherAnalysis = analyzePrompt(otherPrompt);
	const otherSketch = textSketch(otherPrompt);
	const sketchB64 = (() => {
		const buf = Buffer.allocUnsafe(otherSketch.length * 4);
		for (let i = 0; i < otherSketch.length; i++) buf.writeUInt32LE(otherSketch[i], i * 4);
		return buf.toString("base64");
	})();
	const mixed = [
		...Array.from({ length: 3 }, () => ({ label: "pro" })),
		...Array.from({ length: 2 }, () => ({ label: "flash" })),
	].map((entry) =>
		JSON.stringify({ t: 1727800000, cls: ["architecture", "wide-scope"], band: 2, sk: sketchB64, ...entry }),
	);
	writeFileSync(MEMORY_PATH, `${mixed.join("\n")}\n`);
	fire("agent_end");
	resetMemoryCache();
	assert.equal(
		queryMemory(otherAnalysis.profile, otherSketch),
		undefined,
		"3-2 split is below the agreement gate: abstain, never guess",
	);

	// 5) over-cap journal: the ring stays fixed and the journal is trimmed
	const goodLine = mixed[0];
	writeFileSync(MEMORY_PATH, `${Array.from({ length: MEMORY_KEEP_LINES + 1 }, () => goodLine).join("\n")}\n`);
	fire("agent_end");
	resetMemoryCache();
	fire("before_agent_start", { prompt: abstainPrompt }); // triggers the load
	assert.equal(memoryEntries(), MEMORY_RING, "ring keeps at most MEMORY_RING entries");
	const trimmed = readFileSync(MEMORY_PATH, "utf8").trim().split("\n");
	assert.ok(trimmed.length <= MEMORY_KEEP_LINES, `journal trimmed to ${trimmed.length} lines`);

	// /auto-router memory: report the store, then wipe it
	const cmdLines: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => {
		cmdLines.push(args.map(String).join(" "));
	};
	const cmdCtx: any = { hasUI: false, mode: "headless", modelRegistry: ratingReg, reload: async () => {} };
	try {
		assert.ok(commands.has("auto-router"), "wizard command registered");
		await commands.get("auto-router").handler("memory", cmdCtx);
		assert.ok(cmdLines.some((line) => line.includes(MEMORY_PATH)), "memory prints the journal path");
		assert.ok(cmdLines.some((line) => line.includes(`entries: ${MEMORY_RING}`)), "memory prints the ring fill");
		cmdLines.length = 0;
		await commands.get("auto-router").handler("memory reset", cmdCtx);
		assert.ok(cmdLines.some((line) => line.includes("cleared")), "reset confirms the wipe");
		assert.ok(!existsSync(MEMORY_PATH), "journal removed by reset");
		assert.equal(memoryEntries(), 0, "ring empty after reset");
		cmdLines.length = 0;
		await commands.get("auto-router").handler("memory", cmdCtx);
		assert.ok(cmdLines.some((line) => line.includes("absent")), "reports an empty store");
	} finally {
		console.log = origLog;
	}

	console.log(
		"all checkConfig + writeOwnConfig + chooseRating + parseRole + parseSelfRating + decideLocally + hook/route + memory-store assertions passed",
	);
}

run()
	.catch((e) => {
		console.error("FAILED:", e);
		process.exitCode = 1;
	})
	.finally(() => rmSync(root, { recursive: true, force: true }));

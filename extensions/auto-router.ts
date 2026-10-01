/**
 * auto-router - a virtual model that routes between a configured flash model
 * (cheap default) and pro model (strong escalation) by the difficulty of the
 * issue. Family-agnostic: both roles come from settings.json.
 *
 * Decision chain (mirrors Claude Code's haiku/sonnet/opus tiering, with a
 * local layer first and the decision taken per prompt):
 *
 *   0. When the prompt arrives (before_agent_start) a local feature router
 *      reads it and decides at once when the signals are clear: 0 ms, no
 *      tokens, deterministic. Mixed or missing signals make it abstain.
 *   1. On abstain the flash model rates the issue and reports a confidence.
 *      At or above the confidence bar the decision is final and Jev is never
 *      contacted.
 *   2. Only when the flash model is unsure is Jev consulted, and only if
 *      JEVMODEL_API_KEY is configured. Jev is an optional fallback, not a
 *      dependency.
 *   3. With no Jev available, that lean is kept.
 *   4. If neither rater produced anything (self n/a and Jev n/a), routing
 *      stops: the branch keeps the model it is already on, and a brand-new
 *      session keeps flash. Nothing is guessed.
 *
 * The pair is checked before anything else. When the configured flash and pro
 * models are not both registered the router disables itself: the model
 * is not registered at load time (so Pi silently falls back to its own default
 * model), and a session that still has it selected degrades instead of failing.
 *
 * With Pi's default model set to the pro model, routing needs no extra guard:
 * route() only runs for requests made with this virtual model, so a physical
 * pro default is never intercepted. The model stays listed in /model, so
 * picking it explicitly opts back into routing for that session.
 *
 * route() serves the decision taken at prompt time to every request of that
 * agent run - tool-loop continuations included - so one prompt is one
 * decision, and the next prompt re-decides. Requests outside the agent loop
 * (compaction summaries) go to flash. Set AUTO_ROUTER_DEBUG=1 for a one-line
 * trace of which layer decided; /auto-router status reports how often the
 * local layer decided on its own.
 *
 * Select with /model -> router/auto; Ctrl+S saves it as the default.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

/**
 * Which registered model plays each role. The extension owns its config and it
 * lives next to the extension file - created and edited with /auto-router,
 * removed together with the extension, read lazily while it is loaded and
 * ignored when it is not:
 *
 *   ~/.pi/agent/extensions/auto-router.json
 *   { "flash-model": "deepseek/deepseek-v4-flash",
 *     "pro-model":   "deepseek/deepseek-v4-pro" }
 *
 * Pi's files stay Pi's: the only value read from settings.json is the default
 * model id (to warn when it changes), and models.json is never touched -
 * availability comes from the live model registry. Missing or malformed keys
 * keep the MiMo defaults, and the two roles may live on different providers.
 */
interface Role {
	provider: string;
	id: string;
}

const DEFAULT_FLASH: Role = { provider: "cc-switch-xiaomi-mi-mo-token-plan-china", id: "mimo-v2.6-flash" };
const DEFAULT_PRO: Role = { provider: "cc-switch-xiaomi-mi-mo-token-plan-china", id: "mimo-v2.6-pro" };

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Accept "provider/model-id"; anything else keeps the default for that role.
 * Splits on the first slash, because model ids may themselves contain slashes
 * (e.g. "openrouter/typesafe/jev-1.13").
 */
export function parseRole(value: unknown, fallback: Role): Role {
	if (typeof value !== "string") return fallback;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return fallback;
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** Extension-owned config file; Pi's settings.json is only ever read. */
const CONFIG_FILE = "auto-router.json";

/** Directory holding this extension file. */
const EXTENSION_DIR = ((): string | undefined => {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return undefined;
	}
})();

/**
 * The config lives next to the extension file, so uninstalling the extension
 * takes its config with it - the rule this extension was designed around.
 * Verified safe for updates: `pi update` preserves files inside the package
 * directory for both npm and git sources. If the config is missing here, an
 * older copy in <agent-dir>/extensions is still read, and the next save
 * supersedes it so nothing is stranded after an uninstall.
 */
function configDir(): string {
	return EXTENSION_DIR ?? path.join(agentDir(), "extensions");
}

/** Compare two paths, resolving symlinks: import.meta.url is a realpath while
 * agentDir() may sit behind one (macOS /var -> /private/var), so equal files
 * can compare unequal as strings. */
function samePath(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return path.resolve(a) === path.resolve(b);
	}
}

/** Where builds before this fix kept the config for package installs. */
function legacyConfigFile(): string {
	return path.join(agentDir(), "extensions", CONFIG_FILE);
}

function configFile(): string {
	return path.join(configDir(), CONFIG_FILE);
}

function readOwnConfig(): Record<string, unknown> | undefined {
	const own = readJson(configFile());
	if (own) return own;
	const legacy = legacyConfigFile();
	return samePath(legacy, configFile()) ? undefined : readJson(legacy);
}

/** Write the extension's config; returns the path written. */
export function writeOwnConfig(flashModel: string, proModel: string): string {
	mkdirSync(configDir(), { recursive: true });
	const file = configFile();
	writeFileSync(file, `${JSON.stringify({ "flash-model": flashModel, "pro-model": proModel }, null, 2)}\n`);
	// Supersede an older copy so uninstalling never leaves it stranded - but only
	// when it really is a different file, never when a symlink makes the paths
	// look different while pointing at the same file.
	const legacy = legacyConfigFile();
	if (existsSync(legacy) && !samePath(legacy, file)) rmSync(legacy);
	refreshRoles();
	return file;
}

function readRoles(): { flash: Role; pro: Role } {
	const own = readOwnConfig();
	return {
		flash: parseRole(own?.["flash-model"], DEFAULT_FLASH),
		pro: parseRole(own?.["pro-model"], DEFAULT_PRO),
	};
}

/**
 * Move an older <agent-dir>/extensions config next to the extension file as
 * soon as this extension loads, so that uninstalling the extension leaves
 * nothing behind. Idempotent; for a file install both paths are the same file,
 * so there is nothing to move. Exported for tests.
 */
export function migrateLegacyConfig(): string | undefined {
	const legacy = legacyConfigFile();
	if (!existsSync(legacy)) return undefined;
	const target = configFile();
	if (samePath(legacy, target)) return undefined;
	mkdirSync(configDir(), { recursive: true });
	if (!existsSync(target)) writeFileSync(target, readFileSync(legacy, "utf8"));
	rmSync(legacy);
	debugRating(`config ready at ${target}`);
	return target;
}

// Migrate before the roles are read, so the moved config is the one in effect.
migrateLegacyConfig();

/** Roles are re-read at session and prompt boundaries, so editing the config
 * changes routing behavior without restarting Pi. */
let ROLES = readRoles();

function refreshRoles(): boolean {
	const next = readRoles();
	const changed =
		next.flash.provider !== ROLES.flash.provider ||
		next.flash.id !== ROLES.flash.id ||
		next.pro.provider !== ROLES.pro.provider ||
		next.pro.id !== ROLES.pro.id;
	if (changed) ROLES = next;
	return changed;
}

/** Pi's configured default model as "provider/model-id", when there is one. */
function readDefaultModel(): string | undefined {
	const settings = readJson(path.join(agentDir(), "settings.json"));
	const model = typeof settings?.["defaultModel"] === "string" ? settings["defaultModel"] : "";
	if (!model) return undefined;
	if (model.includes("/")) return model;
	const provider = typeof settings?.["defaultProvider"] === "string" ? settings["defaultProvider"] : "";
	return provider ? `${provider}/${model}` : model;
}

/** The default as captured at extension load, for detecting later changes. */
const LOAD_DEFAULT = readDefaultModel();

function isRouterDefault(value: string | undefined): boolean {
	if (!value) return false;
	const slash = value.lastIndexOf("/");
	return slash !== -1 && value.slice(0, slash) === VIRTUAL_PROVIDER && value.slice(slash + 1) === VIRTUAL_ID;
}

function isRole(model: { provider: string; id: string } | undefined, role: Role): boolean {
	return model?.provider === role.provider && model.id === role.id;
}

/** Where the virtual model is offered; unrelated to the physical providers. */
const VIRTUAL_PROVIDER = "router";
const VIRTUAL_ID = "auto";

const JEV_URL = process.env.JEV_URL ?? process.env.JEVMODEL_URL ?? "https://jevmodel.org/v1/systemone";
/** Hard bound on the self-rating call: a stalled rating must not hold the turn. */
const SELF_RATING_TIMEOUT_MS = 10_000;
const RATING_TIMEOUT_MS = 8_000;
/** mimo's own confidence must reach this before Jev is skipped. */
const SELF_CONF_THRESHOLD = 0.8;
/** Jev's P(pro) must exceed this to pick pro. */
const PRO_THRESHOLD = 0.8;
/** Only the head of a long issue is needed to judge its difficulty. */
const RATING_PROMPT_CHARS = 6_000;

type Difficulty = "flash" | "pro";
type RatingSource = "local" | "self" | "jev" | "keep";
/** What the prompt-time hook recorded: a local decision, or "chain" when the
 * local layer abstained and the model-based chain must decide at request time. */

interface SelfRating {
	rated: Difficulty;
	confidence: number;
}

interface AutoState {
	rated: Difficulty;
	/** Which layer decided; absent when inherited from a previous turn. */
	source?: RatingSource;
}

type AutoRequest = ModelRouteRequest<AutoState>;

const RATING_SYSTEM_PROMPT = `You rate one software engineering task so it can be routed between a fast model and a strong model.

Reply with ONLY a JSON object and nothing else:
{"rating":"flash","confidence":0.95}

Fields:
- rating: "flash" when a fast model handles the task reliably (questions, small fixes, feature edits, standard debugging, routine refactors, scripts, docs). "pro" when a fast model is likely to fail (deep architecture, subtle cross-cutting design, hard-to-reproduce root cause analysis, multi-service migrations).
- confidence: your certainty in that rating, from 0 to 1.

When the task is routine or ambiguous, answer "flash".`;

/**
 * Layer 0: the local router. Pure feature matching over the prompt - no model
 * call, no network, deterministic, instant. Each signal adds weight to one
 * side; a side wins only when it clears its own bar AND is ahead of the other,
 * so mixed or absent signals abstain and the prompt falls through to the flash
 * model. Abstaining is the safety valve: local coverage is grown by adding
 * signals (from logged data later), never by forcing a decision.
 */
export interface LocalDecision {
	rated: Difficulty;
	/** Margin-derived; reported in the trace and status only. */
	confidence: number;
	/** Which signals fired, for the trace. */
	signals: string[];
}

interface LocalSignal {
	name: string;
	side: Difficulty;
	weight: number;
	re: RegExp;
}

const LOCAL_SIGNALS: LocalSignal[] = [
	// pro: work a fast model tends to get wrong (must total >= 3 to decide).
	{
		name: "stack-trace",
		side: "pro",
		weight: 3,
		re: /traceback \(most recent call last\)|\bpanic:|segmentation fault|\bcore dumped\b|\bat \S[^\n]*:\d+:\d+/,
	},
	{
		name: "concurrency",
		side: "pro",
		weight: 3,
		re: /\b(race condition|data race|deadlock|livelock|thread[- ]safe|mutex|atomic(?:ity)?|memory leak|use[- ]after[- ]free|double[- ]free)\b/i,
	},
	{
		name: "architecture",
		side: "pro",
		weight: 3,
		re: /\b(architect(?:ure|ural)?|redesign|refactor(?:ing)?|migrat(?:ion|e|ing)|backward[- ]compat(?:ible|ibility)?|breaking change|cross[- ]cutting|decoupl(?:e|ed|ing))\b/i,
	},
	{
		name: "security",
		side: "pro",
		weight: 3,
		re: /\b(vulnerabilit(?:y|ies)|CVE-\d{4}-\d+|inject(?:ion)?|XSS|CSRF|auth(?:entication|orization)? bypass|encrypt(?:ion|ed)?)\b/i,
	},
	{
		name: "hard-debug",
		side: "pro",
		weight: 2,
		re: /\b(root[- ]cause|not working|broken|crash(?:es|ed|ing)?|segfault|flaky|reproduc(?:e|ible)|fail(?:ing|ed|s)?)\b/i,
	},
	{
		name: "performance",
		side: "pro",
		weight: 2,
		re: /\b(optimi[sz](?:e|ed|ing|ation)|latency|bottleneck|scal(?:e|ing|ability)|N\+1)\b/i,
	},
	{
		name: "wide-scope",
		side: "pro",
		weight: 2,
		re: /\b(across (?:all|the) (?:files|modules|services|repos)|whole (?:codebase|project)|end[- ]to[- ]end|all (?:of )?the (?:files|modules|repos))\b/i,
	},
	// flash: work a fast model handles reliably (must total >= 2 to decide).
	{
		name: "trivial",
		side: "flash",
		weight: 3,
		re: /^\s*(?:hi+|hello|hey|thanks|thank you|ok(?:ay)?|yes|no|continue|go ahead|please proceed|lgtm|done)[.!\s]*$/i,
	},
	{
		name: "lookup",
		side: "flash",
		weight: 2,
		re: /\b(?:what (?:is|does|are|was)|where (?:is|are|can)|explain|describe|summar(?:y|ize|ise)|which (?:one|file|function)|show me|read (?:the|this)|list)\b/i,
	},
	{
		name: "small-edit",
		side: "flash",
		weight: 2,
		re: /\b(?:typo|comments?|readme|docs?|documentation|whitespace|indent(?:ation)?|cosmetic|rename|spelling|grammar|format(?:ting)?)\b/i,
	},
];

function localConfidence(margin: number): number {
	return Math.min(0.97, 0.85 + 0.04 * margin);
}

/** Decide from the prompt alone; undefined means "abstain, ask the flash model". */
export function decideLocally(prompt: string): LocalDecision | undefined {
	if (!prompt.trim()) return undefined;
	let proScore = 0;
	let flashScore = 0;
	const pro: string[] = [];
	const flash: string[] = [];
	for (const signal of LOCAL_SIGNALS) {
		if (!signal.re.test(prompt)) continue;
		if (signal.side === "pro") {
			proScore += signal.weight;
			pro.push(signal.name);
		} else {
			flashScore += signal.weight;
			flash.push(signal.name);
		}
	}
	// Structural features that are about shape rather than wording.
	if ((prompt.match(/```/g)?.length ?? 0) >= 4 && prompt.length >= 1_000) {
		proScore += 1;
		pro.push("big-context");
	}
	if (new Set(prompt.match(/[\w./-]+\.[A-Za-z]{1,6}\b/g) ?? []).size >= 3) {
		proScore += 1;
		pro.push("multi-file");
	}
	if (prompt.length < 80) {
		flashScore += 1;
		flash.push("short");
	}
	if (prompt.length < 400 && prompt.includes("?")) {
		flashScore += 1;
		flash.push("question");
	}

	if (proScore >= 3 && proScore > flashScore) {
		return { rated: "pro", confidence: localConfidence(proScore - flashScore), signals: pro };
	}
	if (flashScore >= 2 && flashScore > proScore) {
		return { rated: "flash", confidence: localConfidence(flashScore - proScore), signals: flash };
	}
	return undefined;
}

/** Per-session counters for /auto-router status: which layer decided what. */
export const stats = {
	prompts: 0,
	local: 0,
	abstain: 0,
	self: 0,
	jev: 0,
	keep: 0,
	direct: 0,
	inherited: 0,
};

function resetStats(): void {
	Object.keys(stats).forEach((key) => ((stats as Record<string, number>)[key] = 0));
}

/** The decision taken when the prompt arrived; read by route() for every
 * request of that agent run and cleared when the run ends. */
type TurnDecision =
	| { source: "chain" } // local layer abstained: the chain decides at request time
	| { rated: Difficulty; source: RatingSource }; // some layer already decided

let PENDING: TurnDecision | undefined;

function routeTo(request: AutoRequest, ctx: ExtensionContext, rated: Difficulty, state?: AutoState): ModelRoute<AutoState> {
	const role = rated === "pro" ? ROLES.pro : ROLES.flash;
	const model = ctx.modelRegistry.find(role.provider, role.id);
	if (!model) throw new Error(`Model ${role.provider}/${role.id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

type Registry = ExtensionContext["modelRegistry"];

/** Resolve the routable pair; undefined when either model is missing or unauthenticated. */
function resolvePair(registry: Registry) {
	// Both roles on one model means there is nothing to switch between.
	if (ROLES.flash.provider === ROLES.pro.provider && ROLES.flash.id === ROLES.pro.id) return undefined;
	const flash = registry.find(ROLES.flash.provider, ROLES.flash.id);
	const pro = registry.find(ROLES.pro.provider, ROLES.pro.id);
	if (!flash || !pro) return undefined;
	if (!registry.hasConfiguredAuth(flash) || !registry.hasConfiguredAuth(pro)) return undefined;
	return { flash, pro };
}

/**
 * The pair is gone: keep the model this branch is already on, and for a
 * brand-new session degrade the way Pi does when a configured default model is
 * missing, rather than failing the request. No rating is attempted, so a
 * disabled router never spends a Jev or mimo call.
 */
async function disabledRoute(request: AutoRequest, ctx: ExtensionContext): Promise<ModelRoute<AutoState>> {
	// request.previous is { model, thinkingLevel }, not the model itself.
	const previous = request.previous?.model;
	if (previous && ctx.modelRegistry.hasConfiguredAuth(previous)) {
		return { model: previous, thinkingLevel: request.thinkingLevel };
	}
	const fallback = (await ctx.modelRegistry.getAvailableOfType("chat")).find(
		(model) => !(model.provider === VIRTUAL_PROVIDER && model.id === VIRTUAL_ID),
	);
	if (!fallback) throw new Error("auto-router: flash/pro pair unavailable and no fallback model is configured");
	debugRating(`pair unavailable, routing disabled -> ${fallback.provider}/${fallback.id}`);
	return { model: fallback, thinkingLevel: request.thinkingLevel };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * The decision chain. Each dependency returns undefined when it cannot answer,
 * so a failure simply drops to the next step. Exported for tests.
 */
export async function chooseRating(
	deps: {
		/** Model this branch is already using; kept when no rater can answer. */
		keep?: Difficulty;
		self?: () => Promise<SelfRating | undefined>;
		jev?: () => Promise<Difficulty | undefined>;
		/** Optional audit hook: one line per step taken. */
		trace?: (line: string) => void;
	},
): Promise<{ rated: Difficulty; source: RatingSource }> {
	// 1. mimo decides for itself when confident: no Jev traffic at all.
	const self = deps.self ? await deps.self() : undefined;
	deps.trace?.(self ? `self rated=${self.rated} conf=${self.confidence}` : "self unavailable");
	if (self && self.confidence >= SELF_CONF_THRESHOLD) return { rated: self.rated, source: "self" };

	// 2. Unsure -> consult Jev, but only if it is configured and answers.
	const jev = deps.jev ? await deps.jev() : undefined;
	deps.trace?.(`jev=${jev ?? "unavailable"}`);
	if (jev) return { rated: jev, source: "jev" };

	// 3. No Jev: keep mimo's lean when it did answer, however unsure.
	if (self) return { rated: self.rated, source: "self" };

	// 4. Self n/a and Jev n/a: stop routing and keep the current model.
	const keep = deps.keep ?? "flash";
	deps.trace?.(`no rater available, keeping ${keep}`);
	return { rated: keep, source: "keep" };
}

/** Parse the JSON rating out of mimo's reply; anything unreadable is "no rating". */
export function parseSelfRating(text: string): SelfRating | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { rating, confidence } = parsed as { rating?: unknown; confidence?: unknown };
	if (rating !== "flash" && rating !== "pro") return undefined;
	const conf = typeof confidence === "number" && Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0;
	return { rated: rating, confidence: conf };
}

/** Have mimo rate its own task. Returns undefined when it cannot answer. */
async function rateWithSelf(
	prompt: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<SelfRating | undefined> {
	const model = ctx.modelRegistry.find(ROLES.flash.provider, ROLES.flash.id);
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), SELF_RATING_TIMEOUT_MS);
	const onAbort = () => ctrl.abort();
	signal.addEventListener("abort", onAbort);
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: RATING_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt.slice(0, RATING_PROMPT_CHARS) }],
						timestamp: Date.now(),
					},
				],
			},
			{ signal: ctrl.signal, reasoning: "minimal" },
		);
		if (response.stopReason !== "stop") return undefined;
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return parseSelfRating(text);
	} catch (e) {
		// The caller cancelled: propagate. Our deadline fired: try the next step.
		if (signal.aborted) throw e;
		return undefined;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Ask Jev to rate the issue. Returns undefined on any failure (no key, timeout,
 * unreachable, unexpected answer) so the caller falls back to the next step.
 * A caller-initiated abort is rethrown so cancellation still propagates.
 */
async function rateWithJev(prompt: string, signal: AbortSignal): Promise<Difficulty | undefined> {
	const key = process.env.JEVMODEL_API_KEY;
	if (!key) return undefined;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), RATING_TIMEOUT_MS);
	const onAbort = () => ctrl.abort();
	signal.addEventListener("abort", onAbort);
	try {
		const res = await fetch(JEV_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "jev-latest",
				state: { prompt: prompt.slice(0, 12_000) },
				questions: {
					difficulty: {
						type: "choice",
						instructions:
							"How demanding is the software engineering work requested in `prompt`? " +
							"Choose `pro` only when it needs deep reasoning: subtle design, cross-cutting " +
							"changes, hard debugging, or architecture. Choose `flash` for routine work.",
						criteria: {
							flash: "Routine: quick questions, small fixes, straightforward edits, docs",
							pro: "Hard: subtle design, cross-cutting changes, hard debugging, architecture",
						},
					},
				},
			}),
			signal: ctrl.signal,
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as {
			answers?: { difficulty?: { choice?: string; probabilities?: Record<string, number> } };
		};
		const answer = data.answers?.difficulty;
		if (answer?.choice !== "flash" && answer?.choice !== "pro") return undefined;
		// A missing probability must not silently coerce to 0 (that would bias
		// every unknown answer to flash); fall back to the choice itself.
		const pPro =
			typeof answer.probabilities?.pro === "number"
				? answer.probabilities.pro
				: answer.choice === "pro"
					? 1
					: 0;
		return pPro > PRO_THRESHOLD ? "pro" : "flash";
	} catch (e) {
		if (signal.aborted) throw e;
		return undefined;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

function debugRating(message: string): void {
	if (process.env.AUTO_ROUTER_DEBUG) console.error(`[auto-router] ${message}`);
}

let lastReported: string[] = [];

function report(ctx: ConfigCheckContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, type);
	else console.error(`[auto-router] ${type}: ${message}`);
}

/** Minimal slice of the extension context checkConfig() needs; kept small so
 * it is testable without a live Pi session. */
export interface ConfigCheckContext {
	modelRegistry: ExtensionContext["modelRegistry"];
	hasUI?: boolean;
	ui?: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

/**
 * Re-evaluate configuration at session and prompt boundaries so the extension
 * follows the user's model settings instead of going silently dead:
 *
 * - default is router/auto but the pair is gone  -> error (routing cannot work)
 * - explicitly configured pair is gone           -> warning (provider rewritten,
 *   e.g. by cc-switch, or the pro model removed); router stays disabled
 * - default model changed during this run        -> info (routing moved to /model)
 *
 * Stock installs with no configured pair and no router default stay silent,
 * and an issue is announced when it appears, not on every prompt.
 */
export function checkConfig(ctx: ConfigCheckContext): void {
	refreshRoles();
	const current = readDefaultModel();
	const issues: { message: string; type: "info" | "warning" | "error" }[] = [];

	if (!resolvePair(ctx.modelRegistry)) {
		const explicit = readOwnConfig() !== undefined;
		if (isRouterDefault(current)) {
			issues.push({
				type: "error",
				message: `default model ${VIRTUAL_PROVIDER}/${VIRTUAL_ID} cannot route: the configured flash/pro pair is not in the catalog. Fix ${CONFIG_FILE} or the default model.`,
			});
		} else if (explicit) {
			issues.push({
				type: "warning",
				message: `flash/pro pair not found in the catalog - provider config changed? Router stays disabled until ${CONFIG_FILE} matches your models.`,
			});
		}
	}

	if (current !== LOAD_DEFAULT) {
		issues.push({
			type: "info",
			message: `default model is now ${current ?? "(unset)"}; ${VIRTUAL_PROVIDER}/${VIRTUAL_ID} is no longer the default. Pick it in /model to route this session.`,
		});
	}

	for (const issue of issues) {
		if (lastReported.includes(issue.message)) continue;
		report(ctx, issue.message, issue.type);
	}
	lastReported = issues.map((issue) => issue.message);
}

let registered = false;

function registerAuto(pi: ExtensionAPI): void {
	pi.registerVirtualModel<AutoState>({
		provider: VIRTUAL_PROVIDER,
		id: VIRTUAL_ID,
		name: "Auto (by difficulty)",
		thinkingLevels: ["off", "low", "medium", "high"],
		// Shared by both physical models; shown before the first response.
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		route: routeVirtual,
	});
	registered = true;
}

async function routeVirtual(request: AutoRequest, ctx: ExtensionContext): Promise<ModelRoute<AutoState>> {
	// Both physical models must exist, or the router stays out of the way.
	if (!resolvePair(ctx.modelRegistry)) return disabledRoute(request, ctx);

	// Compaction summaries and other out-of-loop calls stay cheap.
	if (request.reason === "direct") {
		stats.direct++;
		return routeTo(request, ctx, "flash");
	}

	// The decision taken when this prompt arrived. Every request of the run -
	// tool-loop continuations included - is served by it, so one prompt is one
	// decision and the cache stays warm inside the run.
	if (PENDING && PENDING.source !== "chain") {
		return routeTo(request, ctx, PENDING.rated, { rated: PENDING.rated, source: PENDING.source });
	}

	// The hook did not run for this request (resume, late extension load):
	// reuse what the branch already decided instead of re-rating blindly.
	if (!PENDING) {
		const state = request.state;
		if (state?.rated) {
			stats.inherited++;
			return routeTo(request, ctx, state.rated, state);
		}
		const previousRole: Difficulty | undefined = isRole(request.previous?.model, ROLES.pro)
			? "pro"
			: isRole(request.previous?.model, ROLES.flash)
				? "flash"
				: undefined;
		if (request.reason !== "user" && previousRole) {
			stats.inherited++;
			return routeTo(request, ctx, previousRole, { rated: previousRole });
		}
	}

	// The local layer abstained (or the hook never ran): rate the issue here.
	const prompt = lastUserText(request.messages);
	const started = Date.now();
	// "Current model" for step 4: pro when this branch is already on pro,
	// otherwise flash (a brand-new session has no current model yet).
	const keep: Difficulty = isRole(request.previous?.model, ROLES.pro) ? "pro" : "flash";
	// request.signal is optional; with none, the raters' own deadlines apply.
	const signal = request.signal ?? new AbortController().signal;
	const { rated, source } = await chooseRating({
		keep,
		self: () => rateWithSelf(prompt, ctx, signal),
		jev: () => rateWithJev(prompt, signal),
		trace: (line) => debugRating(line),
	});
	debugRating(`decided ${source}/${rated} in ${Date.now() - started}ms`);
	if (source === "self" || source === "jev" || source === "keep") stats[source]++;
	// Remember it for the rest of this run so continuations do not re-rate.
	PENDING = { rated, source };
	return routeTo(request, ctx, rated, { rated, source });
}

export default function (pi: ExtensionAPI) {
	debugRating(
		`roles flash=${ROLES.flash.provider}/${ROLES.flash.id} pro=${ROLES.pro.provider}/${ROLES.pro.id}`,
	);

	// Register at load only when the extension has its own config: that is what
	// makes router/auto resolvable as Pi's default model, since selection happens
	// before session_start. Without config the router still activates at
	// session_start when the pair is present, but it cannot be a startup default.
	if (readOwnConfig()) {
		registerAuto(pi);
		debugRating(`config ${configFile()} loaded`);
	} else {
		debugRating("no extension config yet; run /auto-router to configure");
	}

	// The wizard: read status, or write this extension's own config file.
	pi.registerCommand("auto-router", {
		description: "Show or set the flash/pro models auto-router switches between",
		handler: async (args, ctx) => {
			const say = (message: string, type: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
				else console.log(message);
			};
			const status = (): string[] => {
				const roles = readRoles();
				const pair = resolvePair(ctx.modelRegistry);
				const coverage = stats.prompts ? Math.round((stats.local / stats.prompts) * 100) : 0;
				return [
					`config:  ${configFile()}${readOwnConfig() ? "" : "  (missing - run /auto-router to create it)"}`,
					`flash:   ${roles.flash.provider}/${roles.flash.id}`,
					`pro:     ${roles.pro.provider}/${roles.pro.id}`,
					`pair:    ${pair ? "resolved in catalog" : "NOT available"}`,
					`default: ${readDefaultModel() ?? "(unset)"}`,
					`local:   ${stats.local}/${stats.prompts} prompts decided locally (${coverage}%), ${stats.abstain} sent to the chain`,
					`chain:   self ${stats.self}, jev ${stats.jev}, keep ${stats.keep}, direct ${stats.direct}, inherited ${stats.inherited}`,
				];
			};
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			if (sub === "status" || (!sub && !ctx.hasUI)) {
				for (const line of status()) say(line);
				return;
			}

			const save = (flashModel: string, proModel: string): boolean => {
				if (flashModel === proModel) {
					say("flash and pro must be different models.", "warning");
					return false;
				}
				const file = writeOwnConfig(flashModel, proModel);
				say(`Saved ${file}\n  flash = ${flashModel}\n  pro   = ${proModel}`);
				return true;
			};

			if (sub === "set") {
				const flashModel = parts.find((part) => part.startsWith("flash="))?.slice("flash=".length);
				const proModel = parts.find((part) => part.startsWith("pro="))?.slice("pro=".length);
				if (!parseRole(flashModel, { provider: "", id: "" }).provider || !parseRole(proModel, { provider: "", id: "" }).provider) {
					say("usage: /auto-router set flash=<provider/model-id> pro=<provider/model-id>", "warning");
					return;
				}
				if (save(flashModel!, proModel!)) await ctx.reload();
				return;
			}

			if (sub) {
				say("usage: /auto-router | /auto-router status | /auto-router set flash=<id> pro=<id>", "warning");
				return;
			}

			// Interactive wizard: pick both roles from the models Pi can reach.
			if (!ctx.hasUI || ctx.mode !== "tui") {
				for (const line of status()) say(line);
				say("usage: /auto-router status | /auto-router set flash=<provider/model-id> pro=<provider/model-id>");
				return;
			}
			const candidates = (await ctx.modelRegistry.getAvailableOfType("chat"))
				.filter((model) => !(model.provider === VIRTUAL_PROVIDER && model.id === VIRTUAL_ID))
				.map((model) => `${model.provider}/${model.id}`);
			if (candidates.length === 0) {
				say("No authenticated chat models available to choose from.", "warning");
				return;
			}
			const flashModel = await ctx.ui.select("flash model (cheap default; also rates each issue)", candidates);
			if (!flashModel) return;
			const proModel = await ctx.ui.select("pro model (strong escalation target)", candidates);
			if (!proModel) return;
			if (save(flashModel, proModel)) await ctx.reload();
		},
	});

	// Reconcile against the live catalog - never models.json, which stays Pi's:
	// availability comes from the registry, and other extensions can register
	// providers after this one loads.
	pi.on("session_start", (_event, ctx) => {
		// A session (or branch) switch starts this session's tally over.
		PENDING = undefined;
		resetStats();
		const available = Boolean(resolvePair(ctx.modelRegistry));
		const selected = ctx.model?.provider === VIRTUAL_PROVIDER && ctx.model?.id === VIRTUAL_ID;
		if (available && !registered) {
			registerAuto(pi);
			debugRating("pair available, router enabled");
		} else if (!available && registered && !selected) {
			pi.unregisterVirtualModel(VIRTUAL_PROVIDER, VIRTUAL_ID);
			registered = false;
			debugRating("pair missing, router disabled");
		}
		checkConfig(ctx);
	});

	// Settings edits land between prompts: re-check so a changed default or a
	// removed pro model is reported (and roles re-read) without a restart.
	pi.on("ui_prompt_start", (_event, ctx) => {
		checkConfig(ctx);
	});

	// Read the prompt the moment it arrives and settle the decision for the
	// whole agent run before it starts; route() then serves that decision to
	// every request in the loop.
	pi.on("before_agent_start", (event, ctx) => {
		if (!registered) return;
		// Nothing to do when another model is explicitly selected for this run.
		if (ctx.model && (ctx.model.provider !== VIRTUAL_PROVIDER || ctx.model.id !== VIRTUAL_ID)) return;
		if (!resolvePair(ctx.modelRegistry)) return;
		stats.prompts++;
		const local = decideLocally(event.prompt ?? "");
		if (local) {
			stats.local++;
			PENDING = { rated: local.rated, source: "local" };
			debugRating(`local ${local.rated} conf=${local.confidence.toFixed(2)} via ${local.signals.join("+")}`);
			return;
		}
		stats.abstain++;
		PENDING = { source: "chain" };
		debugRating("local abstain; flash rating chain decides");
	});

	// One prompt is one decision: drop it when the run ends so the next prompt
	// re-decides instead of inheriting this one.
	pi.on("agent_end", () => {
		PENDING = undefined;
	});
}

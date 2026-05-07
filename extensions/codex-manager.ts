import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PROVIDER_ID = "openai-codex";
const STATUS_KEY = "codex-manager";
const SETTINGS_KEY = "codex-manager";
const LEGACY_FAST_SETTINGS_KEY = "pi-codex-fast";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROFILE_DIR = join(AGENT_DIR, "codex-profiles");
const ACTIVE_PROFILE_PATH = join(PROFILE_DIR, "active");
const GLOBAL_SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const LIVE_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_CACHE_TTL_MS = 60_000;
const USAGE_ERROR_CACHE_TTL_MS = 15_000;
const STATUS_REFRESH_INTERVAL_MS = 60_000;
const USAGE_BAR_WIDTH = 8;

const SERVICE_TIERS = ["scale", "priority"] as const;
type ServiceTier = (typeof SERVICE_TIERS)[number];

type JsonRecord = Record<string, unknown>;
type CodexCredential = JsonRecord & {
	type: "oauth";
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
};

type TierState = {
	enabled: boolean;
	value: ServiceTier;
};

type UsageLimit = {
	label: string;
	remainingPercent: number;
	resetAtMs?: number;
	source: string;
};

type UsageSummary = {
	planType?: string;
	limits: UsageLimit[];
	fetchedAt: number;
};

type UsageCacheEntry = {
	expiresAt: number;
	summary?: UsageSummary;
	error?: string;
	promise?: Promise<UsageSummary>;
};

type ResolvedUsageToken = {
	key: string;
	token: string;
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexCredential(value: unknown): value is CodexCredential {
	return isRecord(value) && value.type === "oauth";
}

function isServiceTier(value: unknown): value is ServiceTier {
	return typeof value === "string" && SERVICE_TIERS.includes(value as ServiceTier);
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function sanitizeProfileName(raw: string): string {
	const name = raw.trim();
	if (!name) throw new Error("Profile name is required. Example: /codex profile switch b");
	if (name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
		throw new Error("Profile name may only contain letters, numbers, dot, underscore, and dash.");
	}
	return name;
}

function profilePath(name: string): string {
	return join(PROFILE_DIR, `${name}.json`);
}

function accountLabel(credential: CodexCredential | undefined): string {
	const accountId = typeof credential?.accountId === "string" ? credential.accountId : undefined;
	if (!accountId) return "account unknown";
	return `account …${accountId.slice(-8)}`;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function parseNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const normalized = value.trim().replace(/%$/, "");
		if (!normalized) return undefined;
		const parsed = Number(normalized);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function normalizePercent(value: unknown): number | undefined {
	const number = parseNumber(value);
	if (number === undefined) return undefined;
	return clampPercent(number);
}

function firstPercent(record: JsonRecord, keys: string[]): number | undefined {
	for (const key of keys) {
		const percent = normalizePercent(record[key]);
		if (percent !== undefined) return percent;
	}
	return undefined;
}

function firstNumber(record: JsonRecord, keys: string[]): number | undefined {
	for (const key of keys) {
		const number = parseNumber(record[key]);
		if (number !== undefined) return number;
	}
	return undefined;
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 10_000_000_000 ? value * 1000 : value;
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function firstTimestampMs(record: JsonRecord, keys: string[]): number | undefined {
	for (const key of keys) {
		const timestamp = parseTimestampMs(record[key]);
		if (timestamp !== undefined) return timestamp;
	}
	return undefined;
}

type DurationUnit = "milliseconds" | "seconds" | "minutes" | "hours" | "days";

function durationUnitMs(unit: DurationUnit): number {
	switch (unit) {
		case "milliseconds":
			return 1;
		case "seconds":
			return 1000;
		case "minutes":
			return 60_000;
		case "hours":
			return 3_600_000;
		case "days":
			return 86_400_000;
	}
}

function parseDurationMs(value: unknown, defaultUnit: DurationUnit): number | undefined {
	const number = parseNumber(value);
	if (number !== undefined && number >= 0) return number * durationUnitMs(defaultUnit);
	if (typeof value !== "string") return undefined;
	const text = value.trim().toLowerCase();
	if (!text) return undefined;

	let total = 0;
	let matched = false;
	const pattern = /(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/g;
	for (const match of text.matchAll(pattern)) {
		const amount = Number(match[1]);
		if (!Number.isFinite(amount)) continue;
		matched = true;
		const unit = match[2];
		if (unit === "ms" || unit.startsWith("millisecond")) total += amount;
		else if (unit === "s" || unit.startsWith("sec")) total += amount * 1000;
		else if (unit === "m" || unit.startsWith("min")) total += amount * 60_000;
		else if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) total += amount * 3_600_000;
		else if (unit === "d" || unit.startsWith("day")) total += amount * 86_400_000;
	}
	return matched ? total : undefined;
}

function firstDurationMs(record: JsonRecord, candidates: Array<[string, DurationUnit]>): number | undefined {
	for (const [key, unit] of candidates) {
		const duration = parseDurationMs(record[key], unit);
		if (duration !== undefined) return duration;
	}
	return undefined;
}

function extractAccessToken(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const direct = firstString(value, ["access_token", "accessToken", "access"]);
	if (direct) return direct;

	const tokens = value.tokens;
	if (isRecord(tokens)) {
		const token = firstString(tokens, ["access_token", "accessToken", "access"]);
		if (token) return token;
	}

	const providerCredential = value[PROVIDER_ID];
	if (providerCredential && providerCredential !== value) return extractAccessToken(providerCredential);
	return undefined;
}

function usageCacheKey(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function usageErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function usageAnsiColor(remainingPercent: number): string {
	// Use a restrained 256-color palette instead of theme warning/success/error;
	// some themes render warning as very bright yellow, which makes low quota look louder than high quota.
	if (remainingPercent < 20) return "\x1b[38;5;167m"; // soft red
	if (remainingPercent < 50) return "\x1b[38;5;179m"; // muted amber
	return "\x1b[38;5;150m"; // muted green
}

function colorAnsi(color: string, text: string): string {
	return `${color}${text}\x1b[39m`;
}

function usageBar(remainingPercent: number): { filled: string; empty: string } {
	const filledCount = Math.round((clampPercent(remainingPercent) / 100) * USAGE_BAR_WIDTH);
	return {
		filled: "▰".repeat(filledCount),
		empty: "▱".repeat(USAGE_BAR_WIDTH - filledCount),
	};
}

function formatDurationCompact(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

function resetText(resetAtMs: number | undefined): string | undefined {
	return resetAtMs === undefined ? undefined : formatDurationCompact(resetAtMs - Date.now());
}

function formatUsageLimit(ctx: ExtensionContext, limit: UsageLimit, options?: { compact?: boolean }): string {
	const percent = Math.round(clampPercent(limit.remainingPercent));
	const bar = usageBar(percent);
	const reset = resetText(limit.resetAtMs);
	const prefix = options?.compact
		? ctx.ui.theme.fg("muted", `${reset ?? limit.label} `)
		: `${ctx.ui.theme.fg("muted", limit.label)}${reset ? ` ${ctx.ui.theme.fg("dim", `↻ ${reset}`)}` : ""}${ctx.ui.theme.fg("muted", " ")}`;
	return `${prefix}${colorAnsi(usageAnsiColor(percent), bar.filled)}${ctx.ui.theme.fg("dim", bar.empty)} ${ctx.ui.theme.fg("muted", `${percent}%`)}`;
}

function formatUsageLimits(ctx: ExtensionContext, summary: UsageSummary | undefined, options?: { compact?: boolean }): string {
	if (!summary || summary.limits.length === 0) return ctx.ui.theme.fg("dim", "usage ?");
	return summary.limits.map((limit) => formatUsageLimit(ctx, limit, options)).join(options?.compact ? "  " : "    ");
}

function normalizeWindowLabel(text: string): string | undefined {
	const lower = text.trim().toLowerCase().replace(/[_-]+/g, " ");
	const hourMatch = lower.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/);
	if (hourMatch) return `${hourMatch[1]}h`;
	const dayMatch = lower.match(/(\d+)\s*(?:d|day|days)\b/);
	if (dayMatch) return `${dayMatch[1]}d`;
	if (/\bweek(?:ly)?\b/.test(lower)) return "7d";
	return undefined;
}

function inferUsageLabel(key: string, raw: unknown): string {
	if (isRecord(raw)) {
		const labelText = firstString(raw, ["window", "window_size", "windowSize", "period", "duration", "label", "name", "title", "type"]);
		if (labelText) {
			const normalized = normalizeWindowLabel(labelText);
			if (normalized) return normalized;
		}
		const windowMinutes = firstNumber(raw, ["window_minutes", "windowMinutes", "window_mins", "windowMins"]);
		if (windowMinutes !== undefined && windowMinutes > 0) {
			if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
			if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
			return `${windowMinutes}m`;
		}
	}

	const normalizedKey = key.toLowerCase();
	const labelFromKey = normalizeWindowLabel(normalizedKey);
	if (labelFromKey) return labelFromKey;
	if (normalizedKey.includes("secondary") || normalizedKey.includes("weekly")) return "7d";
	if (normalizedKey.includes("primary")) return "5h";
	return key.replace(/[_-]+/g, " ");
}

function resetAtFromUsage(raw: unknown, now = Date.now()): number | undefined {
	if (!isRecord(raw)) return undefined;

	const explicitResetAt = firstTimestampMs(raw, [
		"reset_at",
		"resetAt",
		"resets_at",
		"resetsAt",
		"next_reset_at",
		"nextResetAt",
		"reset_time",
		"resetTime",
		"reset_date",
		"resetDate",
		"expires_at",
		"expiresAt",
		"end_time",
		"endTime",
		"window_end",
		"windowEnd",
	]);
	if (explicitResetAt !== undefined) return explicitResetAt;

	const resetAfterMs = firstDurationMs(raw, [
		["reset_after_ms", "milliseconds"],
		["resetAfterMs", "milliseconds"],
		["reset_in_ms", "milliseconds"],
		["resetInMs", "milliseconds"],
		["reset_after_seconds", "seconds"],
		["resetAfterSeconds", "seconds"],
		["reset_in_seconds", "seconds"],
		["resetInSeconds", "seconds"],
		["resets_in_seconds", "seconds"],
		["resetsInSeconds", "seconds"],
		["seconds_until_reset", "seconds"],
		["secondsUntilReset", "seconds"],
		["time_until_reset", "seconds"],
		["timeUntilReset", "seconds"],
		["remaining_seconds", "seconds"],
		["remainingSeconds", "seconds"],
		["reset_after", "seconds"],
		["resetAfter", "seconds"],
		["reset_in", "seconds"],
		["resetIn", "seconds"],
		["resets_in", "seconds"],
		["resetsIn", "seconds"],
	]);
	if (resetAfterMs !== undefined) return now + resetAfterMs;

	const windowStart = firstTimestampMs(raw, ["window_start", "windowStart", "start_time", "startTime", "started_at", "startedAt"]);
	const windowDurationMs = firstDurationMs(raw, [
		["window_ms", "milliseconds"],
		["windowMs", "milliseconds"],
		["window_seconds", "seconds"],
		["windowSeconds", "seconds"],
		["window_minutes", "minutes"],
		["windowMinutes", "minutes"],
		["window_hours", "hours"],
		["windowHours", "hours"],
		["window_days", "days"],
		["windowDays", "days"],
	]);
	return windowStart !== undefined && windowDurationMs !== undefined ? windowStart + windowDurationMs : undefined;
}

function remainingPercentFromUsage(raw: unknown): number | undefined {
	if (typeof raw === "number" || typeof raw === "string") {
		const usedPercent = normalizePercent(raw);
		return usedPercent === undefined ? undefined : clampPercent(100 - usedPercent);
	}
	if (!isRecord(raw)) return undefined;

	const explicitRemaining = firstPercent(raw, ["remaining_percent", "remainingPercentage", "percentage_remaining", "percent_remaining", "remaining_pct", "pct_remaining"]);
	if (explicitRemaining !== undefined) return explicitRemaining;

	const explicitUsed = firstPercent(raw, ["used_percent", "usedPercentage", "usage_percent", "usagePercentage", "percentage_used", "percent_used", "used_pct", "usage_pct", "pct_used"]);
	if (explicitUsed !== undefined) return clampPercent(100 - explicitUsed);

	const limit = firstNumber(raw, ["limit", "max", "quota", "total"]);
	if (limit !== undefined && limit > 0) {
		const remaining = firstNumber(raw, ["remaining", "available", "left"]);
		if (remaining !== undefined) return clampPercent((remaining / limit) * 100);
		const used = firstNumber(raw, ["used", "current", "consumed", "usage", "count"]);
		if (used !== undefined) return clampPercent(100 - (used / limit) * 100);
	}

	const fallbackRemaining = firstPercent(raw, ["remaining", "available", "left"]);
	if (fallbackRemaining !== undefined) return fallbackRemaining;

	const fallbackUsed = firstPercent(raw, ["usage", "used", "current", "percentage", "percent", "pct", "value"]);
	return fallbackUsed === undefined ? undefined : clampPercent(100 - fallbackUsed);
}

function pushUsageLimit(limits: UsageLimit[], key: string, raw: unknown): void {
	const remainingPercent = remainingPercentFromUsage(raw);
	if (remainingPercent === undefined) return;
	const label = inferUsageLabel(key, raw);
	const resetAtMs = resetAtFromUsage(raw);
	const existing = limits.find((limit) => limit.label === label);
	if (existing) {
		if (existing.resetAtMs === undefined && resetAtMs !== undefined) existing.resetAtMs = resetAtMs;
		return;
	}
	limits.push({ label, remainingPercent, resetAtMs, source: key });
}

function normalizeUsagePayload(payload: unknown): UsageSummary {
	const root = isRecord(payload) ? payload : {};
	const rateLimit = isRecord(root.rate_limit) ? root.rate_limit : isRecord(root.rate_limits) ? root.rate_limits : isRecord(root.rateLimit) ? root.rateLimit : root;
	const planType = firstString(root, ["plan_type", "planType", "plan"]) ?? firstString(rateLimit, ["plan_type", "planType", "plan"]);
	const limits: UsageLimit[] = [];

	pushUsageLimit(limits, "primary", rateLimit.primary ?? rateLimit.primary_window ?? rateLimit.primaryWindow);
	pushUsageLimit(limits, "secondary", rateLimit.secondary ?? rateLimit.secondary_window ?? rateLimit.secondaryWindow);

	const additional = root.additional_rate_limits ?? root.additionalRateLimits ?? rateLimit.additional_rate_limits ?? rateLimit.additionalRateLimits;
	if (Array.isArray(additional)) {
		additional.forEach((limit, index) => pushUsageLimit(limits, `additional ${index + 1}`, limit));
	} else if (isRecord(additional)) {
		for (const [key, limit] of Object.entries(additional)) pushUsageLimit(limits, key, limit);
	}

	return { planType, limits, fetchedAt: Date.now() };
}

async function readCodexAuthAccessToken(): Promise<string | undefined> {
	return extractAccessToken(await readJsonObject(CODEX_AUTH_PATH));
}

async function fetchUsageSummary(token: string, signal?: AbortSignal): Promise<UsageSummary> {
	const response = await fetch(LIVE_USAGE_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
		signal,
	});
	if (!response.ok) throw new Error(`usage endpoint returned HTTP ${response.status}`);
	return normalizeUsagePayload(await response.json());
}

function tierIcon(tier: ServiceTier): string {
	switch (tier) {
		case "priority":
			return "⚡";
		case "scale":
			return "▣";
	}
}

function supportsServiceTier(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex";
}

async function ensureProfileDir(): Promise<void> {
	await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
}

async function readTextIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, content, { encoding: "utf8", mode });
	await chmod(tmp, mode).catch(() => undefined);
	await rename(tmp, path);
	await chmod(path, mode).catch(() => undefined);
}

async function readJsonObject(path: string): Promise<JsonRecord> {
	const text = await readTextIfExists(path);
	if (!text) return {};
	const parsed = JSON.parse(text) as unknown;
	return isRecord(parsed) ? parsed : {};
}

function mergeSettings(base: JsonRecord, overrides: JsonRecord): JsonRecord {
	const merged: JsonRecord = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		const baseValue = merged[key];
		if (isRecord(baseValue) && isRecord(overrideValue)) {
			merged[key] = mergeSettings(baseValue, overrideValue);
		} else {
			merged[key] = overrideValue;
		}
	}
	return merged;
}

function parseManagerTierSettings(settings: JsonRecord): TierState | undefined {
	const manager = settings[SETTINGS_KEY];
	if (isRecord(manager)) {
		const tier = manager.tier;
		if (isRecord(tier)) {
			return {
				enabled: typeof tier.enabled === "boolean" ? tier.enabled : false,
				value: isServiceTier(tier.value) ? tier.value : "priority",
			};
		}
	}

	const legacy = settings[LEGACY_FAST_SETTINGS_KEY];
	if (!isRecord(legacy)) return undefined;
	return {
		enabled: typeof legacy.enabled === "boolean" ? legacy.enabled : false,
		value: isServiceTier(legacy.tier) ? legacy.tier : "priority",
	};
}

async function loadTierState(cwd: string): Promise<TierState> {
	const globalSettings = await readJsonObject(GLOBAL_SETTINGS_PATH);
	const projectSettings = await readJsonObject(join(cwd, ".pi", "settings.json"));
	const effectiveSettings = mergeSettings(globalSettings, projectSettings);
	return parseManagerTierSettings(effectiveSettings) ?? { enabled: false, value: "priority" };
}

async function saveGlobalTierState(state: TierState): Promise<void> {
	const globalSettings = await readJsonObject(GLOBAL_SETTINGS_PATH);
	const existing = isRecord(globalSettings[SETTINGS_KEY]) ? globalSettings[SETTINGS_KEY] : {};
	globalSettings[SETTINGS_KEY] = {
		...existing,
		tier: {
			enabled: state.enabled,
			value: state.value,
		},
	};
	delete globalSettings[LEGACY_FAST_SETTINGS_KEY];
	await writeFileAtomic(GLOBAL_SETTINGS_PATH, `${JSON.stringify(globalSettings, null, 2)}\n`);
}

async function readActiveProfile(): Promise<string | undefined> {
	const text = await readTextIfExists(ACTIVE_PROFILE_PATH);
	if (!text) return undefined;
	const name = text.trim();
	return name ? sanitizeProfileName(name) : undefined;
}

async function writeActiveProfile(name: string): Promise<void> {
	await writeFileAtomic(ACTIVE_PROFILE_PATH, `${name}\n`);
}

async function readProfile(name: string): Promise<CodexCredential> {
	const text = await readTextIfExists(profilePath(name));
	if (!text) throw new Error(`Codex profile '${name}' does not exist. Create it with /codex profile save ${name}.`);
	const parsed = JSON.parse(text) as unknown;
	const credential = isRecord(parsed) && PROVIDER_ID in parsed ? parsed[PROVIDER_ID] : parsed;
	if (!isCodexCredential(credential)) {
		throw new Error(`Codex profile '${name}' is invalid: expected an OAuth credential for ${PROVIDER_ID}.`);
	}
	return credential;
}

async function writeProfile(name: string, credential: CodexCredential): Promise<void> {
	await ensureProfileDir();
	await writeFileAtomic(profilePath(name), `${JSON.stringify({ [PROVIDER_ID]: credential }, null, 2)}\n`);
}

function listProfileNames(): string[] {
	if (!existsSync(PROFILE_DIR)) return [];
	return readdirSync(PROFILE_DIR)
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.slice(0, -".json".length))
		.filter((name) => {
			try {
				sanitizeProfileName(name);
				return true;
			} catch {
				return false;
			}
		})
		.sort();
}

function getAuthStorage(ctx: ExtensionContext): any {
	const authStorage = (ctx.modelRegistry as any)?.authStorage;
	if (!authStorage || typeof authStorage.get !== "function" || typeof authStorage.set !== "function") {
		throw new Error("Could not access ctx.modelRegistry.authStorage.");
	}
	return authStorage;
}

function getCurrentCredential(ctx: ExtensionContext): CodexCredential | undefined {
	const credential = getAuthStorage(ctx).get(PROVIDER_ID);
	return isCodexCredential(credential) ? credential : undefined;
}

function getCurrentCredentialSafe(ctx: ExtensionContext): CodexCredential | undefined {
	try {
		return getCurrentCredential(ctx);
	} catch {
		return undefined;
	}
}

function sameKnownAccount(a: CodexCredential | undefined, b: CodexCredential | undefined): boolean {
	return Boolean(a?.accountId && b?.accountId && a.accountId === b.accountId);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

async function waitUntilIdle(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.isIdle()) return;
	notify(ctx, "codex-manager: waiting for current turn to finish before changing Codex auth…", "warning");
	await ctx.waitForIdle();
}

async function syncActiveProfileIfSafe(ctx: ExtensionContext): Promise<string | undefined> {
	const active = await readActiveProfile();
	if (!active) return undefined;

	const current = getCurrentCredential(ctx);
	if (!current) return undefined;

	try {
		const existing = await readProfile(active);
		if (existing.accountId && current.accountId && existing.accountId !== current.accountId) {
			notify(
				ctx,
				`Skipped auto-sync of profile '${active}' because current ${accountLabel(current)} differs from saved ${accountLabel(existing)}.`,
				"warning",
			);
			return undefined;
		}
	} catch {
		// If the active marker exists but the profile file is missing/invalid, recreate it from current auth.
	}

	await writeProfile(active, current);
	return active;
}

function helpText(): string {
	return [
		"/codex commands:",
		"  /codex status",
		"  /codex profile save <name>",
		"  /codex profile switch <name>",
		"  /codex profile list",
		"  /codex profile current",
		"  /codex tier              # toggle priority on/off",
		"  /codex fast              # same as /codex tier",
		"  /codex tier priority|scale|off",
	].join("\n");
}

function tokenize(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function completionItems(candidates: string[], prefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = prefix.trimStart().toLowerCase();
	const items = candidates
		.filter((candidate) => candidate.toLowerCase().startsWith(normalizedPrefix))
		.map((candidate) => ({ value: candidate, label: candidate }));
	return items.length > 0 ? items : null;
}

export default function codexManager(pi: ExtensionAPI): void {
	let tierState: TierState = { enabled: false, value: "priority" };
	let writeQueue: Promise<void> = Promise.resolve();
	let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let latestStatusCtx: ExtensionContext | undefined;
	const usageCache = new Map<string, UsageCacheEntry>();

	async function resolveUsageToken(credential: CodexCredential | undefined, allowAuthFileFallback: boolean): Promise<ResolvedUsageToken | undefined> {
		const token = extractAccessToken(credential) ?? (allowAuthFileFallback ? await readCodexAuthAccessToken().catch(() => undefined) : undefined);
		return token ? { token, key: usageCacheKey(token) } : undefined;
	}

	function fetchUsageWithCache(resolved: ResolvedUsageToken, options?: { refresh?: boolean; signal?: AbortSignal }): Promise<UsageSummary> {
		const now = Date.now();
		const cached = usageCache.get(resolved.key);
		if (!options?.refresh && cached?.summary && cached.expiresAt > now) return Promise.resolve(cached.summary);
		if (!options?.refresh && cached?.promise) return cached.promise;

		const promise = fetchUsageSummary(resolved.token, options?.signal).then(
			(summary) => {
				usageCache.set(resolved.key, { summary, expiresAt: Date.now() + USAGE_CACHE_TTL_MS });
				return summary;
			},
			(error) => {
				usageCache.set(resolved.key, { error: usageErrorMessage(error), expiresAt: Date.now() + USAGE_ERROR_CACHE_TTL_MS });
				throw error;
			},
		);

		usageCache.set(resolved.key, { ...cached, promise, expiresAt: now + USAGE_CACHE_TTL_MS });
		return promise;
	}

	async function getUsageSummary(credential: CodexCredential | undefined, options?: { allowAuthFileFallback?: boolean; refresh?: boolean; signal?: AbortSignal }): Promise<UsageSummary> {
		const resolved = await resolveUsageToken(credential, options?.allowAuthFileFallback ?? false);
		if (!resolved) throw new Error("no Codex access token found");
		return fetchUsageWithCache(resolved, { refresh: options?.refresh, signal: options?.signal });
	}

	async function getUsageCacheEntry(credential: CodexCredential | undefined, allowAuthFileFallback: boolean): Promise<UsageCacheEntry | undefined> {
		const resolved = await resolveUsageToken(credential, allowAuthFileFallback);
		return resolved ? usageCache.get(resolved.key) : undefined;
	}

	function statusUsageText(ctx: ExtensionContext, entry: UsageCacheEntry | undefined): string | undefined {
		if (entry?.summary) return formatUsageLimits(ctx, entry.summary, { compact: true });
		if (entry?.promise) return ctx.ui.theme.fg("dim", "usage …");
		if (entry?.error) return ctx.ui.theme.fg("dim", "usage ?");
		return undefined;
	}

	function startStatusRefreshTimer(ctx: ExtensionContext): void {
		latestStatusCtx = ctx;
		if (statusRefreshTimer) return;
		statusRefreshTimer = setInterval(() => {
			if (!latestStatusCtx) return;
			void updateStatus(latestStatusCtx).catch(() => undefined);
		}, STATUS_REFRESH_INTERVAL_MS);
		(statusRefreshTimer as { unref?: () => void }).unref?.();
	}

	function stopStatusRefreshTimer(): void {
		if (statusRefreshTimer) clearInterval(statusRefreshTimer);
		statusRefreshTimer = undefined;
		latestStatusCtx = undefined;
	}

	async function refreshUsageInBackground(ctx: ExtensionContext, credential: CodexCredential | undefined, allowAuthFileFallback: boolean, options?: { refresh?: boolean }): Promise<void> {
		const resolved = await resolveUsageToken(credential, allowAuthFileFallback).catch(() => undefined);
		if (!resolved) return;
		const cached = usageCache.get(resolved.key);
		const now = Date.now();
		if (cached?.promise) return;
		if (!options?.refresh && cached && cached.expiresAt > now && (cached.summary || cached.error)) return;
		void fetchUsageWithCache(resolved, { refresh: options?.refresh })
			.catch(() => undefined)
			.then(() => updateStatus(ctx).catch(() => undefined));
	}

	async function updateStatus(ctx: ExtensionContext, options?: { refreshUsage?: boolean }): Promise<void> {
		if (!ctx.hasUI) return;
		startStatusRefreshTimer(ctx);
		const active = await readActiveProfile().catch(() => undefined);
		const current = getCurrentCredentialSafe(ctx);
		const profile = active ? `codex:${active}` : "codex:?";
		await refreshUsageInBackground(ctx, current, true, { refresh: options?.refreshUsage });
		const parts = [ctx.ui.theme.fg("accent", `${profile} (${accountLabel(current)})`)];

		const usageEntry = await getUsageCacheEntry(current, true).catch(() => undefined);
		const usageText = statusUsageText(ctx, usageEntry);
		if (usageText) parts.push(usageText);

		if (tierState.enabled) {
			const tier = `${tierIcon(tierState.value)}${tierState.value}`;
			parts.push(ctx.ui.theme.fg(supportsServiceTier(ctx) ? "accent" : "warning", supportsServiceTier(ctx) ? tier : `${tier}:inactive`));
		}

		ctx.ui.setStatus(STATUS_KEY, parts.join("  "));
	}

	function persistTierState(ctx: ExtensionContext): void {
		const stateToPersist = { ...tierState };
		writeQueue = writeQueue
			.catch(() => undefined)
			.then(() => saveGlobalTierState(stateToPersist));

		void writeQueue.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `codex-manager: failed to write settings: ${message}`, "warning");
		});
	}

	function describeTier(ctx: ExtensionContext): string {
		if (!tierState.enabled) return "Codex service tier disabled; requests use provider/project default.";
		const tier = `${tierIcon(tierState.value)} service_tier=${tierState.value}`;
		if (supportsServiceTier(ctx)) return `Codex service tier enabled: ${tier}.`;
		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
		return `Codex service tier enabled: ${tier}, but inactive for current model (${modelLabel}).`;
	}

	async function setTierState(next: Partial<TierState>, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): Promise<void> {
		tierState = { ...tierState, ...next };
		if (options?.persist !== false) persistTierState(ctx);
		await updateStatus(ctx);
		if (options?.notify !== false) notify(ctx, describeTier(ctx), "info");
	}

	async function reloadTierState(ctx: ExtensionContext): Promise<void> {
		await writeQueue.catch(() => undefined);
		try {
			tierState = await loadTierState(ctx.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `codex-manager: failed to load settings: ${message}`, "warning");
			tierState = { enabled: false, value: "priority" };
		}
		await updateStatus(ctx);
	}

	async function usageDescription(ctx: ExtensionContext, credential: CodexCredential | undefined, allowAuthFileFallback: boolean): Promise<string> {
		try {
			const summary = await getUsageSummary(credential, { allowAuthFileFallback, refresh: true, signal: ctx.signal });
			return formatUsageLimits(ctx, summary, { compact: true });
		} catch (error) {
			return ctx.ui.theme.fg("warning", `usage unavailable (${usageErrorMessage(error)})`);
		}
	}

	async function showStatus(ctx: ExtensionContext): Promise<void> {
		const active = await readActiveProfile().catch(() => undefined);
		const current = getCurrentCredentialSafe(ctx);
		const names = listProfileNames();
		const lines = [
			ctx.ui.theme.fg("accent", "Codex status"),
			`Current: ${active ? `'${active}'` : "no active profile marker"} (${accountLabel(current)}), ${names.length} saved`,
			`Tier: ${describeTier(ctx)}`,
		];

		if (names.length === 0) {
			lines.push("", `Usage: ${await usageDescription(ctx, current, true)}`);
			notify(ctx, lines.join("\n"), "info");
			await updateStatus(ctx);
			return;
		}

		lines.push("", "Profiles:");
		for (const name of names) {
			try {
				const credential = await readProfile(name);
				const markers = [name === active ? "active" : undefined, sameKnownAccount(credential, current) ? "current" : undefined]
					.filter(Boolean)
					.join(", ");
				const prefix = name === active ? ctx.ui.theme.fg("success", "*") : " ";
				const usage = await usageDescription(ctx, credential, sameKnownAccount(credential, current));
				lines.push(`${prefix} ${ctx.ui.theme.fg("accent", name)}: ${accountLabel(credential)}${markers ? ` [${markers}]` : ""}  ${usage}`);
			} catch (error) {
				lines.push(`  ${name}: ${ctx.ui.theme.fg("error", `invalid (${usageErrorMessage(error)})`)}`);
			}
		}

		notify(ctx, lines.join("\n"), "info");
		await updateStatus(ctx);
	}

	async function handleProfileCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
		const action = tokens[1]?.toLowerCase();

		if (action === "save") {
			await waitUntilIdle(ctx);
			const name = sanitizeProfileName(tokens[2] ?? "");
			const credential = getCurrentCredential(ctx);
			if (!credential) {
				throw new Error(`No ${PROVIDER_ID} OAuth credential is currently loaded. Run /login ${PROVIDER_ID} first.`);
			}
			await writeProfile(name, credential);
			await writeActiveProfile(name);
			await updateStatus(ctx);
			notify(ctx, `Saved Codex profile '${name}' (${accountLabel(credential)}).`, "info");
			return;
		}

		if (action === "switch") {
			await waitUntilIdle(ctx);
			const name = sanitizeProfileName(tokens[2] ?? "");
			const synced = await syncActiveProfileIfSafe(ctx);
			const nextCredential = await readProfile(name);

			const authStorage = getAuthStorage(ctx);
			authStorage.set(PROVIDER_ID, nextCredential);
			if (typeof authStorage.reload === "function") authStorage.reload();

			const current = getCurrentCredential(ctx);
			if (nextCredential.accountId && current?.accountId && nextCredential.accountId !== current.accountId) {
				throw new Error(`Switch failed: authStorage still has ${accountLabel(current)} instead of profile '${name}'.`);
			}

			await writeActiveProfile(name);
			await updateStatus(ctx);
			const syncNote = synced ? ` Synced previous profile '${synced}' first.` : "";
			notify(ctx, `Switched Codex profile to '${name}' (${accountLabel(current ?? nextCredential)}).${syncNote} Use /new if you want a fresh WebSocket-cached session.`, "info");
			return;
		}

		if (action === "list") {
			const active = await readActiveProfile().catch(() => undefined);
			const current = getCurrentCredentialSafe(ctx);
			const names = listProfileNames();
			if (names.length === 0) {
				notify(ctx, "No Codex profiles saved yet. Setup: /login openai-codex, then /codex profile save a.", "info");
				return;
			}
			const lines = await Promise.all(
				names.map(async (name) => {
					try {
						const credential = await readProfile(name);
						const markers = [name === active ? "active" : undefined, sameKnownAccount(credential, current) ? "current" : undefined]
							.filter(Boolean)
							.join(", ");
						return `${name}: ${accountLabel(credential)}${markers ? ` [${markers}]` : ""}`;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return `${name}: invalid (${message})`;
					}
				}),
			);
			notify(ctx, `Codex profiles:\n${lines.join("\n")}`, "info");
			return;
		}

		if (action === "current") {
			const active = await readActiveProfile().catch(() => undefined);
			const current = getCurrentCredentialSafe(ctx);
			notify(ctx, `Current Codex auth: ${accountLabel(current)}${active ? `; active profile '${active}'` : "; no active profile marker"}.`, "info");
			return;
		}

		throw new Error("Unknown /codex profile command. Use save, switch, list, or current.");
	}

	async function handleTierCommand(tokens: string[], ctx: ExtensionContext): Promise<void> {
		const arg = tokens[1]?.toLowerCase();

		if (!arg) {
			const priorityIsEnabled = tierState.enabled && tierState.value === "priority";
			await setTierState(priorityIsEnabled ? { enabled: false } : { enabled: true, value: "priority" }, ctx);
			return;
		}

		if (arg === "off") {
			await setTierState({ enabled: false }, ctx);
			return;
		}

		if (isServiceTier(arg)) {
			await setTierState({ enabled: true, value: arg }, ctx);
			return;
		}

		throw new Error(`Unknown /codex tier argument: ${tokens[1]}. Use priority, scale, or off.`);
	}

	function getCodexCompletions(prefix: string): AutocompleteItem[] | null {
		const profileNames = listProfileNames();
		const candidates = [
			"status",
			"help",
			"profile list",
			"profile current",
			"profile save ",
			...profileNames.map((name) => `profile switch ${name}`),
			"tier",
			"tier priority",
			"tier scale",
			"tier off",
			"fast",
			"fast priority",
			"fast scale",
			"fast off",
		];
		return completionItems(candidates, prefix);
	}

	pi.registerCommand("codex", {
		description: "Manage OpenAI Codex profiles and service_tier",
		getArgumentCompletions: getCodexCompletions,
		handler: async (args, ctx) => {
			const tokens = tokenize(args);
			const command = tokens[0]?.toLowerCase() ?? "status";

			if (command === "status") {
				await showStatus(ctx);
				return;
			}

			if (command === "help") {
				notify(ctx, helpText(), "info");
				return;
			}

			if (command === "profile") {
				await handleProfileCommand(tokens, ctx);
				return;
			}

			if (command === "tier") {
				await handleTierCommand(tokens, ctx);
				return;
			}

			if (command === "fast") {
				await handleTierCommand(["tier", ...tokens.slice(1)], ctx);
				return;
			}

			throw new Error("Unknown /codex command. Use /codex help.");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		startStatusRefreshTimer(ctx);
		await reloadTierState(ctx);
	});

	pi.on("session_shutdown", () => {
		stopStatusRefreshTimer();
	});

	pi.on("model_select", async (_event, ctx) => {
		await updateStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await updateStatus(ctx, { refreshUsage: true });
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!tierState.enabled || !supportsServiceTier(ctx) || !isRecord(event.payload)) return;
		if (Object.prototype.hasOwnProperty.call(event.payload, "service_tier")) return;
		return {
			...event.payload,
			service_tier: tierState.value,
		};
	});
}

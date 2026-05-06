import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
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

const SERVICE_TIERS = ["auto", "default", "flex", "scale", "priority"] as const;
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

function tierIcon(tier: ServiceTier): string {
	switch (tier) {
		case "priority":
			return "⚡";
		case "flex":
			return "🐢";
		case "default":
			return "○";
		case "auto":
			return "◇";
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
		"  /codex tier priority|flex|default|auto|scale|off|status",
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

	async function updateStatus(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const active = await readActiveProfile().catch(() => undefined);
		const current = getCurrentCredentialSafe(ctx);
		const profile = active ? `codex:${active}` : "codex:?";
		const parts = [profile, `(${accountLabel(current)})`];
		if (tierState.enabled) {
			const tier = `${tierIcon(tierState.value)}${tierState.value}`;
			parts.push(supportsServiceTier(ctx) ? tier : `${tier}:inactive`);
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", parts.join(" ")));
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

	async function showStatus(ctx: ExtensionContext): Promise<void> {
		const active = await readActiveProfile().catch(() => undefined);
		const current = getCurrentCredentialSafe(ctx);
		const profileCount = listProfileNames().length;
		const lines = [
			`Profile: ${active ? `'${active}'` : "no active profile marker"} (${accountLabel(current)}), ${profileCount} saved`,
			`Tier: ${describeTier(ctx)}`,
		];
		notify(ctx, lines.join("\n"), "info");
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
		const arg = tokens[1]?.toLowerCase() ?? "status";

		if (arg === "status") {
			notify(ctx, describeTier(ctx), "info");
			return;
		}

		if (["off", "disable", "disabled", "false", "0"].includes(arg)) {
			await setTierState({ enabled: false }, ctx);
			return;
		}

		if (["on", "enable", "enabled", "true", "1"].includes(arg)) {
			await setTierState({ enabled: true }, ctx);
			return;
		}

		if (arg === "toggle") {
			await setTierState({ enabled: !tierState.enabled }, ctx);
			return;
		}

		if (isServiceTier(arg)) {
			await setTierState({ enabled: true, value: arg }, ctx);
			return;
		}

		throw new Error(`Unknown /codex tier argument: ${tokens[1]}. Use priority, flex, default, auto, scale, off, or status.`);
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
			"tier priority",
			"tier flex",
			"tier default",
			"tier auto",
			"tier scale",
			"tier off",
			"tier status",
			"tier toggle",
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

			throw new Error("Unknown /codex command. Use /codex help.");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadTierState(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await updateStatus(ctx);
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

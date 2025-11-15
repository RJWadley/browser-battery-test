#!/usr/bin/env bun
import { $ } from "bun";
import { generate as generateRandomWords } from "random-words";
import { createInterface } from "node:readline";
import { startTrackingEnergy, type EnergyResult } from "./powermetrics";

// --- Configuration ---
const browsers = [
	// // fast testing subset
	// "Google Chrome",
	// "Safari",
	// "Firefox",

	// group 1: Test the browsers that misbehave first
	// Arc
	"Arc",
	// dia
	"Dia",
	// ChatGPT Atlas
	"ChatGPT Atlas",
	// deta surf
	"Surf",

	// group 2
	// Chrome
	"Google Chrome",
	// Edge
	"Microsoft Edge",
	// Helium
	"Helium",
	// Zen
	"Zen",

	// group 3
	// comet
	"Comet",

	// group 4
	// Vivaldi
	"Vivaldi",
	// Opera
	"Opera",
	// Safari
	"Safari",
	// Orion
	"Orion",

	// group 5
	// Brave
	"Brave Browser",
	// sigmaOS
	"SigmaOS",
	// firefox
	"Firefox",
	// ladybird (future)
	// "Ladybird",
	// // nook (future)
	// "Nook",
];

const urls = [
	// // quick testing subset
	// "https://x.com/taylorswift13",
	// "https://www.reddit.com/r/popular/",
	// "https://www.tiktok.com/foryou",
	// social sites
	"https://x.com/taylorswift13",
	"https://www.reddit.com/r/popular/",
	"https://www.tumblr.com/taylorswift",
	"https://www.facebook.com/TaylorSwift/",
	"https://www.threads.com/@taylorswift",
	// streaming sites
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	"https://www.twitch.tv/",
	"https://vimeo.com/1084537?autoplay=true",
	"https://open.spotify.com/browse",
	"https://www.tiktok.com/foryou",
	// news sites
	"https://www.cnn.com/",
	"https://www.theverge.com/",
	"https://www.dailymail.co.uk/",
	"https://www.espn.com/",
	"https://www.foxnews.com/",
	// shopping sites
	"https://www.amazon.com/",
	"https://www.google.com/maps",
	"https://www.airbnb.com/",
	"https://www.apple.com/iphone/",
	"https://www.ebay.com/",
	// other sites
	"https://en.wikipedia.org/wiki/Main_Page",
	"https://github.com/torvalds/linux",
	"https://stackoverflow.com/questions",
	"https://docs.google.com/document/create",
	"https://threejs.org/examples/#webgl_animation_keyframes",
];

/**
 * how long to wait on each page
 */
const waitTimeSeconds = 2;
/**
 * how often to sample power metrics
 */
const sampleIntervalMs = 500;

// files and such
const LOG_DIR = "logs";
const RESULTS_FILE = "results.json";
const SCREENSHOTS_ROOT_DIR = "screenshots";

// sleep delays (ms); centralize here to tune timings in one place
const ETC_DRIFT_WARNING_SECONDS = 3; // warn when recalculated deadline shifts by more than this
const BROWSER_LAUNCH_DELAY_MS = 5000;
const WINDOW_CLOSE_DELAY_MS = 500;
const BROWSER_QUIT_DELAY_MS = 2000;
const PREFLIGHT_COOLDOWN_SECONDS = 20;

const POWER_SAMPLE_INTERVAL_MS = sampleIntervalMs;

async function openUrlInBrowser(browser: string, url: string) {
	await $`open -a "/Applications/${browser}.app" "${url}"`.quiet();
}

async function osaInBrowser(browser: string, script: string) {
	await $`open -a "/Applications/${browser}.app" && osascript -e '${script}'`.quiet();
}

async function closeTab(browser: string) {
	await osaInBrowser(
		browser,
		`tell application "System Events" to keystroke "w" using {command down}`,
	);
	await osaInBrowser(
		browser,
		`tell application "System Events" to keystroke "w" using {command down}`,
	);
}

async function launchBrowser(browser: string) {
	await $`open -a "/Applications/${browser}.app"`;
	if (browser === "Arc") {
		// arc has a tendency to open the tab in the background without focusing it, this is a workaround
		await osaInBrowser(
			browser,
			`tell application "System Events" to keystroke "t" using {command down}`,
		);
		await osaInBrowser(
			browser,
			`tell application "System Events" to key code 53`,
		);
	}
}

async function quitBrowser(browser: string) {
	await $`osascript -e 'tell application "${browser}" to quit'`
		.quiet()
		.catch(() => {});
	await $`killall "${browser}"`.quiet().catch(() => {});
}

function sanitizeForPath(value: string): string {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return "unknown";
	const cleaned = trimmed
		.replace(/[^a-z0-9\-_.]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned || "unknown";
}

async function captureScreenshot(options: {
	browser: string;
	url?: string;
	phase?: string;
}) {
	const { browser, url, phase } = options;
	const browserSlug = sanitizeForPath(browser);

	let urlPart = "unknown";
	if (url) {
		const withoutProtocol = url.replace(/^https?:\/\//i, "");
		const host = withoutProtocol.split("/")[0] ?? "";
		urlPart = sanitizeForPath(host || withoutProtocol);
	}

	// organized-by-browser path
	const browserDir = `${SCREENSHOTS_ROOT_DIR}/by-browser/${browserSlug}`;
	let fileName: string;
	if (urlPart !== "unknown") {
		// normal case: use the host as the filename so it's easy to scan
		fileName = `${urlPart}.png`;
	} else if (phase) {
		// preflight / misc captures without a url fall back to the phase label
		fileName = `${sanitizeForPath(phase)}.png`;
	} else {
		fileName = "screenshot.png";
	}
	const browserFilePath = `${browserDir}/${fileName}`;

	// organized-by-site path (only when we have a host)
	const siteSlug = urlPart !== "unknown" ? urlPart : null;
	const siteDir =
		siteSlug != null ? `${SCREENSHOTS_ROOT_DIR}/by-site/${siteSlug}` : null;
	const siteFilePath = siteDir != null ? `${siteDir}/${browserSlug}.png` : null;

	try {
		await $`mkdir -p ${browserDir}`.quiet();
		if (siteDir) {
			await $`mkdir -p ${siteDir}`.quiet();
		}

		// capture once into the browser-organized path
		await $`screencapture -x ${browserFilePath}`.quiet();

		// and copy into the site-organized layout if applicable
		if (siteFilePath) {
			await $`cp ${browserFilePath} ${siteFilePath}`.quiet();
		}

		console.log(
			`[Monitor] Saved screenshot for ${browser} (${url ?? "no url"}) to ${browserFilePath}${
				siteFilePath ? ` and ${siteFilePath}` : ""
			}`,
		);
	} catch (err) {
		console.error(
			`[Error] Failed to capture screenshot for ${browser} (${url ?? "no url"}):`,
			err,
		);
	}
}

type PageEnergy = {
	url: string;
	energy: EnergyResult;
};

/**
 * Formats a duration in seconds into a human-readable string.
 */
function formatSeconds(totalSeconds: number): string {
	const wholeSeconds = Math.floor(totalSeconds);
	const hours = Math.floor(wholeSeconds / 3600);
	const minutes = Math.floor((wholeSeconds % 3600) / 60);
	const seconds = wholeSeconds % 60;
	// prefer hours+minutes when >= 1 hour to avoid noisy second-level flicker
	if (hours > 0) {
		if (minutes > 0) return `${hours}h ${minutes}m`;
		return `${hours}h`;
	}
	// for sub-hour durations, keep minutes+seconds for better granularity
	if (minutes > 0) {
		if (seconds > 0) return `${minutes}m ${seconds}s`;
		return `${minutes}m`;
	}
	return `${seconds}s`;
}

/**
 * live status line (single-line, non-persistent) utilities.
 * we keep one status line rendered at the bottom of the console and
 * re-draw it in place so it doesn't spam logs. falls back to normal logs
 * when not attached to a tty (e.g. redirected to file).
 */
// ansi color helpers; colorize tagged logs when running in a tty
const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
} as const;

function colorizeTaggedText(text: string, { isError = false } = {}): string {
	// only colorize well-known tags; keep everything else as-is
	let colored = text;
	colored = colored.replaceAll(
		"[Preflight]",
		`${ANSI.bold}${ANSI.cyan}[Preflight]${ANSI.reset}`,
	);
	colored = colored.replaceAll(
		"[Monitor]",
		`${ANSI.bold}${ANSI.blue}[Monitor]${ANSI.reset}`,
	);
	colored = colored.replaceAll(
		"[Test]",
		`${ANSI.bold}${ANSI.magenta}[Test]${ANSI.reset}`,
	);
	colored = colored.replaceAll(
		"[Results]",
		`${ANSI.bold}${ANSI.green}[Results]${ANSI.reset}`,
	);
	colored = colored.replaceAll(
		"[Error]",
		`${ANSI.bold}${ANSI.red}[Error]${ANSI.reset}`,
	);
	// emphasize generic thrown errors when no tag is present
	if (isError && colored === text) {
		colored = `${ANSI.red}${text}${ANSI.reset}`;
	}
	return colored;
}

const isInteractiveTerminal =
	typeof process !== "undefined" &&
	typeof process.stdout !== "undefined" &&
	(Boolean as unknown as (v: unknown) => boolean)(process.stdout.isTTY);
let liveStatusText = "";
let liveStatusActive = false;
const originalConsoleLog: typeof console.log = console.log.bind(console);
const originalConsoleError: typeof console.error = console.error.bind(console);

function writeAndRenderLiveStatus() {
	if (!isInteractiveTerminal || !liveStatusActive) return;
	// clear current line, carriage return, then write status
	const line = colorizeTaggedText(liveStatusText);
	process.stdout.write(`\x1b[2K\r${line}`);
}

function clearLiveStatusLine() {
	if (!isInteractiveTerminal) return;
	process.stdout.write("\x1b[2K\r");
}

function setLiveStatus(text: string) {
	if (!isInteractiveTerminal) {
		// not a tty; emit a normal log so information isn't lost
		originalConsoleLog(text);
		return;
	}
	liveStatusText = text;
	liveStatusActive = true;
	writeAndRenderLiveStatus();
}

function stopLiveStatus() {
	liveStatusActive = false;
	clearLiveStatusLine();
	stopRealtimeETC();
}

async function promptYesNo(question: string): Promise<boolean> {
	if (!isInteractiveTerminal) {
		// not interactive; assume 'yes' so CI/logged runs don't hang
		originalConsoleLog(`${question} (non-interactive: assuming 'y')`);
		return true;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const interactiveQuestion =
		typeof question === "string" ? colorizeTaggedText(question) : question;
	const answer: string = await new Promise((resolve) =>
		rl.question(interactiveQuestion, (ans: string) => resolve(ans)),
	);
	rl.close();
	const normalized = answer.trim().toLowerCase();
	return normalized === "y" || normalized === "yes";
}

// wrap console methods so the live status stays at the bottom while printing
console.log = ((...args: unknown[]) => {
	if (isInteractiveTerminal && liveStatusActive) clearLiveStatusLine();
	const finalArgs = isInteractiveTerminal
		? args.map((a) => (typeof a === "string" ? colorizeTaggedText(a) : a))
		: args;
	// @ts-ignore bun's console types are compatible
	originalConsoleLog(...finalArgs);
	if (liveStatusActive) writeAndRenderLiveStatus();
}) as typeof console.log;

console.error = ((...args: unknown[]) => {
	if (isInteractiveTerminal && liveStatusActive) clearLiveStatusLine();
	const finalArgs = isInteractiveTerminal
		? args.map((a) =>
				typeof a === "string" ? colorizeTaggedText(a, { isError: true }) : a,
			)
		: args;
	// @ts-ignore bun's console types are compatible
	originalConsoleError(...finalArgs);
	if (liveStatusActive) writeAndRenderLiveStatus();
}) as typeof console.error;

// ensure we don't leave the status line hanging on exit/ctrl-c
if (typeof process !== "undefined") {
	process.on("exit", () => {
		stopLiveStatus();
	});
	process.on("SIGINT", () => {
		stopLiveStatus();
		process.exit(130);
	});
}

/**
 * updates the live status with estimated time remaining.
 */
function logETC(startTime: number, currentStep: number, totalSteps: number) {
	if (currentStep <= 0) return;
	const elapsedTimeMs = Date.now() - startTime;
	const timePerStepMs = elapsedTimeMs / currentStep;
	const remainingSteps = totalSteps - currentStep;
	const remainingTimeMs = remainingSteps * timePerStepMs;

	// if we don't already have a fixed deadline, initialize it once from current pace
	if (expectedCompletionTimestampMs == null) {
		expectedCompletionTimestampMs = Date.now() + remainingTimeMs;
	}
	latestCompletedStep = currentStep;
	latestTotalSteps = totalSteps;

	// draw once immediately, then keep updating every second until we stop
	const displayRemainingMs = Math.max(
		0,
		(expectedCompletionTimestampMs ?? Date.now()) - Date.now(),
	);
	setLiveStatus(
		`[Monitor]  Step ${latestCompletedStep}/${latestTotalSteps} complete. ETC: ${formatSeconds(
			displayRemainingMs / 1000,
		)}`,
	);
	ensureRealtimeETC();
}

/**
 * Quickly verifies we can control each browser by launching it,
 * opening a simple page, closing the front window, and quitting.
 * If any step fails for a browser, the test run aborts early.
 */
async function preflightBrowsers(browserNames: string[]): Promise<void> {
	console.log(
		"\n[Preflight] Verifying browser control before starting tests...",
	);
	// generate a short phrase and use it in the URL path to avoid cache hits from previous runs
	const randomWords = generateRandomWords(5);
	const phrase = (
		Array.isArray(randomWords) ? randomWords : [randomWords]
	).join("-");
	const exampleUrl = `https://google.com/?q=${phrase}`;
	console.log(`[Preflight] Using unique URL: ${exampleUrl}`);

	// ask once whether to pause for manual confirmation during preflight
	const pauseDuringPreflight = await promptYesNo(
		"[Preflight] Pause to confirm each browser opened the test URL? (y/n): ",
	);
	console.log(
		pauseDuringPreflight
			? "[Preflight] Manual confirmation enabled."
			: "[Preflight] Manual confirmation disabled; proceeding with brief waits.",
	);

	// launch
	for (const browser of browserNames) {
		await launchBrowser(browser);
		if (browser === "ChatGPT Atlas") await Bun.sleep(3000);
	}
	await Bun.sleep(1000);
	for (const browser of browserNames) {
		for (const url of urls) {
			await openUrlInBrowser(browser, url);
		}

		await openUrlInBrowser(browser, exampleUrl);
	}

	// prompt user to confirm the correct URL opened
	if (pauseDuringPreflight) {
		const approved = await promptYesNo(
			`[Preflight] Did all browsers open ${exampleUrl} correctly? (y/n): `,
		);
		if (!approved) {
			for (const browser of browserNames) {
				await quitBrowser(browser);
			}
			throw new Error(
				`User did not approve that all browsers opened ${exampleUrl} correctly.`,
			);
		}
	}

	for (const browser of browserNames) {
		// close the windows we just opened
		for (const _ of urls) {
			await closeTab(browser);
		}
		await closeTab(browser);
	}

	if (pauseDuringPreflight) {
		const approved = await promptYesNo(
			"[Preflight] Did all browsers close the tab correctly? (y/n): ",
		);
		if (!approved) {
			for (const browser of browserNames) {
				await quitBrowser(browser);
			}
			throw new Error(
				"User did not approve that all browsers closed the tab correctly.",
			);
		}
	}

	for (const browser of browserNames) {
		// quit the app
		await quitBrowser(browser);
	}

	console.log("[Preflight] OK: all browsers passed control check");

	await Bun.sleep(PREFLIGHT_COOLDOWN_SECONDS * 1000);
}

// --- realtime ETC support ---
let etcIntervalId: ReturnType<typeof setInterval> | null = null;
let expectedCompletionTimestampMs: number | null = null;
let latestCompletedStep = 0;
let latestTotalSteps = 0;

function stopRealtimeETC() {
	if (etcIntervalId) {
		clearInterval(etcIntervalId);
		etcIntervalId = null;
	}
	expectedCompletionTimestampMs = null;
}

function ensureRealtimeETC() {
	if (etcIntervalId) return;
	etcIntervalId = setInterval(() => {
		if (!liveStatusActive || expectedCompletionTimestampMs == null) return;
		const remainingMs = Math.max(0, expectedCompletionTimestampMs - Date.now());
		liveStatusText = `[Monitor]  Step ${latestCompletedStep}/${latestTotalSteps} complete. ETC: ${formatSeconds(
			remainingMs / 1000,
		)}`;
		writeAndRenderLiveStatus();
	}, 1000);
}

// --- results aggregation ---
type BrowserRunResult = {
	browser: string;
	hasData: boolean;
};
type BrowserReport = BrowserRunResult & {
	startupEnergy: EnergyResult | null;
	quitEnergy: EnergyResult | null;
	perPageEnergy: PageEnergy[];
};
const overallResults: BrowserReport[] = [];
let overallEnergy: EnergyResult | null = null;

async function writeResultsReport(results: BrowserReport[]) {
	const payload = {
		generatedAt: new Date().toISOString(),
		sampleIntervalMs,
		waitTimeSeconds,
		overallEnergy,
		results,
	};
	try {
		await Bun.write(RESULTS_FILE, JSON.stringify(payload, null, 2));
		console.log(
			`[Results] Saved cumulative report to ./${RESULTS_FILE} (${results.length} browsers)`,
		);
	} catch (err) {
		console.error("[Error] Failed to write results.json:", err);
	}
}

// --- Setup ---
console.log("Setting up logs directory...");
await $`rm -rf ${LOG_DIR}`.quiet();
await $`mkdir -p ${LOG_DIR}`.quiet();
console.log(`Logs will be stored in ./${LOG_DIR}`);
console.log(
	`Screenshots will be stored in ./${SCREENSHOTS_ROOT_DIR}/by-browser/{browser}/ and ./${SCREENSHOTS_ROOT_DIR}/by-site/{site}/`,
);

console.log(
	"[Preflight] Taking a test screenshot to confirm screen capture permissions...",
);
await captureScreenshot({
	browser: "preflight",
	phase: "permission-check",
});

// --- ETC Calculation (exact, from explicit sleeps) ---
const totalSteps = browsers.length * urls.length;
// per test (per browser):
// - wait after browser launch
// - per URL: waitTimeSeconds dwell + close window
// - quit browser
const TEST_SLEEP_PER_BROWSER_MS =
	BROWSER_LAUNCH_DELAY_MS +
	urls.length * (waitTimeSeconds * 1000 + WINDOW_CLOSE_DELAY_MS) +
	BROWSER_QUIT_DELAY_MS;
const plannedTestMs = browsers.length * TEST_SLEEP_PER_BROWSER_MS;
console.log(
	`[Monitor] Planned sleeps - total: ${formatSeconds(
		plannedTestMs / 1000,
	)}. Total steps: ${totalSteps}`,
);

const startTime = Date.now();
// defer etc initialization until after preflight; preflight timing is indeterminate
latestCompletedStep = 0;
latestTotalSteps = totalSteps;
let currentStep = 0;

// $`&` is used to suppress output from 'which' command
// We're checking if the 'sudo' command is available (it always should be)
// and this serves as a way to trigger the sudo password prompt *once*
// at the beginning, rather than during the script.
console.log(
	"Checking for sudo access... You may be prompted for your password.",
);
try {
	await $`sudo -v`.quiet();
	console.log("Sudo access confirmed.");
} catch (e) {
	throw new Error("Failed to get sudo access. Exiting.");
}

// --- Preflight: open and close all browsers to confirm control ---
await preflightBrowsers(browsers);

console.log("[Monitor] Measuring energy for entire browser test run...");
const overallTracker = startTrackingEnergy({
	sampleIntervalMs: POWER_SAMPLE_INTERVAL_MS,
});
await overallTracker.ready;

let browserIndex = 0;
for (const browser of browsers) {
	console.log(`\n--- Starting Test for: ${browser} ---`);

	// at the beginning of the test, recalibrate deadline from remaining planned sleeps
	const remainingBrowsersIncludingCurrent = browsers.length - browserIndex;
	const recalculatedRemainingMs =
		remainingBrowsersIncludingCurrent * TEST_SLEEP_PER_BROWSER_MS;
	const recalculatedDeadline = Date.now() + recalculatedRemainingMs;
	if (expectedCompletionTimestampMs != null) {
		const deltaMs = recalculatedDeadline - expectedCompletionTimestampMs;
		if (Math.abs(deltaMs) > ETC_DRIFT_WARNING_SECONDS * 1000) {
			console.log(
				`[Monitor] Warning: ETC drift ${deltaMs > 0 ? "+" : ""}${Math.round(deltaMs / 1000)}s vs previous estimate. Recalibrating.`,
			);
		}
	}
	expectedCompletionTimestampMs = recalculatedDeadline;
	latestTotalSteps = totalSteps;
	latestCompletedStep = currentStep;
	const initialRemainingMs = Math.max(
		0,
		(expectedCompletionTimestampMs ?? Date.now()) - Date.now(),
	);
	setLiveStatus(
		`[Monitor]  Step ${latestCompletedStep}/${latestTotalSteps} complete. ETC: ${formatSeconds(
			initialRemainingMs / 1000,
		)}`,
	);
	ensureRealtimeETC();

	const browserSamples: number[] = [];
	const perPageEnergy: PageEnergy[] = [];
	let startupEnergy: EnergyResult | null = null;
	let quitEnergy: EnergyResult | null = null;

	try {
		// 1. Measure browser startup
		console.log(`[Monitor] Measuring startup energy for ${browser}...`);
		{
			const tracker = startTrackingEnergy({
				sampleIntervalMs: POWER_SAMPLE_INTERVAL_MS,
			});
			await tracker.ready;
			console.log(`[Test] Launching ${browser}...`);
			await launchBrowser(browser);
			await Bun.sleep(BROWSER_LAUNCH_DELAY_MS);
			const energy = await tracker.stopTracking();
			startupEnergy = energy;
			browserSamples.push(...energy.rawSamples);
		}

		// 2. Loop through URLs and measure each page separately
		for (const url of urls) {
			console.log(`[Test]   Measuring page: ${url}...`);
			const tracker = startTrackingEnergy({
				sampleIntervalMs: POWER_SAMPLE_INTERVAL_MS,
			});
			await tracker.ready;

			console.log(`[Test]   Opening ${url}...`);
			await openUrlInBrowser(browser, url);

			console.log(`[Monitor]  Waiting ${waitTimeSeconds} seconds...`);
			await Bun.sleep(waitTimeSeconds * 1000);

			await captureScreenshot({
				browser,
				url,
				phase: "before-close-tab",
			});
			console.log("[Test]   Closing window...");
			await closeTab(browser);
			await Bun.sleep(WINDOW_CLOSE_DELAY_MS);

			const energy = await tracker.stopTracking();
			perPageEnergy.push({ url, energy });
			browserSamples.push(...energy.rawSamples);

			// Update ETC after each page completes
			currentStep++;
			logETC(startTime, currentStep, totalSteps);
		}

		// 3. Measure browser quit
		console.log(`[Monitor] Measuring quit energy for ${browser}...`);
		{
			const tracker = startTrackingEnergy({
				sampleIntervalMs: POWER_SAMPLE_INTERVAL_MS,
			});
			await tracker.ready;
			console.log(`[Test] Quitting ${browser}...`);
			await quitBrowser(browser);
			await Bun.sleep(BROWSER_QUIT_DELAY_MS);
			const energy = await tracker.stopTracking();
			quitEnergy = energy;
			browserSamples.push(...energy.rawSamples);
		}
	} catch (error) {
		console.error(`[Error] Test failed for ${browser}:`, error);
	} finally {
		// 4. Process results
		console.log("[Results] Aggregating samples...");
		const totalEnergyMWh =
			(startupEnergy?.totalEnergy ?? 0) +
			perPageEnergy.reduce((sum, page) => sum + page.energy.totalEnergy, 0) +
			(quitEnergy?.totalEnergy ?? 0);
		const hasData = totalEnergyMWh > 0;

		overallResults.push({
			browser,
			hasData,
			startupEnergy,
			quitEnergy,
			perPageEnergy,
		});

		if (hasData) {
			console.log(`[Results] --- ${browser} ---`);
			console.log(
				`[Results] Total energy (startup + pages + quit): ${totalEnergyMWh.toFixed(
					4,
				)} mWh`,
			);
		} else {
			console.log(`[Results] No power data captured for ${browser}.`);
		}

		// 5. Write cumulative results so far so partial runs are preserved
		await writeResultsReport(overallResults);
	}
	browserIndex++;
}

console.log("[Monitor] Stopping overall energy tracker...");
overallEnergy = await overallTracker.stopTracking();
if (overallEnergy) {
	console.log(
		`[Results] Overall test energy: ${overallEnergy.totalEnergy.toFixed(
			4,
		)} mWh (avg ${overallEnergy.averagePower.toFixed(2)} mW)`,
	);
}
await writeResultsReport(overallResults);

const endTime = Date.now();
stopLiveStatus();
console.log("\n--- All Tests Finished ---");
console.log(`Total time taken: ${formatSeconds((endTime - startTime) / 1000)}`);

// overall summary across browsers
if (overallResults.length > 0) {
	console.log("\n[Results] Overall summary:");
	const successful = overallResults.filter((r) => r.hasData);
	const missing = overallResults.filter((r) => !r.hasData);

	if (successful.length > 0) {
		// sort by total energy ascending (lower is better)
		const withEnergy = successful.map((r) => {
			const totalEnergyMWh =
				(r.startupEnergy?.totalEnergy ?? 0) +
				r.perPageEnergy.reduce(
					(sum, page) => sum + page.energy.totalEnergy,
					0,
				) +
				(r.quitEnergy?.totalEnergy ?? 0);
			return { report: r, totalEnergyMWh };
		});
		withEnergy.sort((a, b) => a.totalEnergyMWh - b.totalEnergyMWh);

		const namePad = Math.max(
			"Browser".length,
			...withEnergy.map((x) => x.report.browser.length),
		);
		console.log(
			`[Results] ${"Browser".padEnd(namePad)}  ${"Total (mWh)".padStart(12)}`,
		);
		for (const { report, totalEnergyMWh } of withEnergy) {
			console.log(
				`[Results] ${report.browser.padEnd(namePad)}  ${totalEnergyMWh
					.toFixed(4)
					.padStart(12)}`,
			);
		}
		const best = withEnergy.reduce((min, x) =>
			x.totalEnergyMWh < min.totalEnergyMWh ? x : min,
		);
		console.log(
			`[Results] Best (lowest total energy): ${
				best.report.browser
			} (${best.totalEnergyMWh.toFixed(4)} mWh)`,
		);
	}

	for (const r of missing) {
		console.log(`[Results] ${r.browser}: no power data captured`);
	}
}

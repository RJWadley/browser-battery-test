#!/usr/bin/env bun
import { $ } from "bun";
import { generate as generateRandomWords } from "random-words";
import { createInterface } from "node:readline";

// --- Configuration ---
const browsers = [
	// Test the browsers that misbehave first
	// Arc
	"Arc",
	// dia
	"Dia",
	// ChatGPT Atlas
	"ChatGPT Atlas",
	// deta surf
	"Surf",

	// Chrome
	"Google Chrome",
	// Edge
	"Microsoft Edge",
	// Helium
	"Helium",
	// Zen
	"Zen",

	// comet
	"Comet",

	// Vivaldi
	"Vivaldi",
	// Opera
	"Opera",
	// Safari
	"Safari",
	// Orion
	"Orion",

	// Not even worth considering
	// Brave
	"Brave Browser",
	// sigmaOS
	"SigmaOS",
	// firefox
	"Firefox",
	// ladybird (future)
	// "Ladybird",
];

const urls = [
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
	"https://www.weather.com/",

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
const waitTimeSeconds = 10;
const sampleIntervalMs = 500;

// Estimated overheads in seconds for ETC calculation
const ETC_DRIFT_WARNING_SECONDS = 3; // warn when recalculated deadline shifts by more than this
const LOG_DIR = "logs";
const RESULTS_FILE = "results.json";
// ---

// sleep delays (ms); centralize here to tune timings in one place
const POWERMETRICS_STARTUP_DELAY_MS = 2000;
const BROWSER_LAUNCH_DELAY_MS = 5000;
const WINDOW_CLOSE_DELAY_MS = 500;
const BROWSER_QUIT_DELAY_MS = 2000;
const POWERMETRICS_STOP_DELAY_MS = 500;
const PREFLIGHT_COOLDOWN_SECONDS = 20;

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
	if (browser === "ChatGPT Atlas" || browser === "Dia") {
		await $`killall "${browser}"`.quiet();
	} else {
		await $`osascript -e 'tell application "${browser}" to quit'`.quiet();
	}
}

/**
 * Parses the verbose output of powermetrics to find Combined Power readings.
 * This is specific to Apple Silicon.
 */
function parsePowerLog(log: string): {
	avg: number;
	max: number;
	count: number;
} {
	const readings: number[] = [];
	// Regex to find "Combined Power (CPU + GPU + ANE): XXXX mW"
	const regex = /Combined Power \(CPU \+ GPU \+ ANE\): (\d+) mW/g;
	let match: RegExpExecArray | null = regex.exec(log);
	while (match !== null) {
		const capturedMilliwatts = match[1];
		if (typeof capturedMilliwatts === "string") {
			readings.push(Number.parseInt(capturedMilliwatts, 10));
		}
		match = regex.exec(log);
	}

	if (readings.length === 0) {
		return { avg: 0, max: 0, count: 0 };
	}

	const sum = readings.reduce((a, b) => a + b, 0);
	const avg = sum / readings.length;
	const max = Math.max(...readings);

	return { avg, max, count: readings.length };
}

/**
 * returns all power samples discovered in the log as a time-ordered array.
 * we keep this separate from parsePowerLog() so we can store raw samples
 * for later analysis and derive per-site stats.
 */
function extractPowerSamples(log: string): number[] {
	const samples: number[] = [];
	const regex = /Combined Power \(CPU \+ GPU \+ ANE\): (\d+) mW/g;
	let match: RegExpExecArray | null = regex.exec(log);
	while (match !== null) {
		const capturedMilliwatts = match[1];
		if (typeof capturedMilliwatts === "string") {
			samples.push(Number.parseInt(capturedMilliwatts, 10));
		}
		match = regex.exec(log);
	}
	return samples;
}

type SiteAverage = {
	index: number;
	url: string;
	avg: number;
	count: number;
};

/**
 * estimates per-site averages by slicing the raw samples into contiguous
 * chunks that align with our fixed wait window for each url.
 *
 * note: we intentionally skip the initial samples taken during powermetrics
 * startup and browser launch to reduce noise in per-site averages.
 */
function computePerSiteAverages(
	allSamples: number[],
	siteUrls: string[],
): SiteAverage[] {
	if (allSamples.length === 0) return [];
	// samples gathered before first site (powermetrics startup + browser launch)
	const preSiteSamples = Math.max(
		0,
		Math.round(
			(POWERMETRICS_STARTUP_DELAY_MS + BROWSER_LAUNCH_DELAY_MS) /
				sampleIntervalMs,
		),
	);
	// number of samples we expect to collect during each site's dwell window
	const perSiteSamples = Math.max(
		1,
		Math.round((waitTimeSeconds * 1000) / sampleIntervalMs),
	);
	const samples = allSamples.slice(preSiteSamples);
	const results: SiteAverage[] = [];
	for (let i = 0; i < siteUrls.length; i++) {
		const start = i * perSiteSamples;
		const end = start + perSiteSamples;
		if (start >= samples.length) break;
		const chunk = samples.slice(start, end);
		if (chunk.length === 0) break;
		const avg =
			chunk.reduce((acc, n) => acc + n, 0) / Math.max(1, chunk.length);
		const url = siteUrls[i] ?? `site-${i}`;
		results.push({
			index: i,
			url,
			avg,
			count: chunk.length,
		});
	}
	return results;
}

type SiteSamples = {
	index: number;
	url: string;
	samples: number[];
};

/**
 * returns arrays of raw samples for each site window, using the same segmentation
 * logic as computePerSiteAverages. this categorizes raw samples per site.
 */
function computeSamplesPerSite(
	allSamples: number[],
	siteUrls: string[],
): SiteSamples[] {
	if (allSamples.length === 0) return [];
	const preSiteSamples = Math.max(
		0,
		Math.round(
			(POWERMETRICS_STARTUP_DELAY_MS + BROWSER_LAUNCH_DELAY_MS) /
				sampleIntervalMs,
		),
	);
	const perSiteSamples = Math.max(
		1,
		Math.round((waitTimeSeconds * 1000) / sampleIntervalMs),
	);
	const samples = allSamples.slice(preSiteSamples);
	const results: SiteSamples[] = [];
	for (let i = 0; i < siteUrls.length; i++) {
		const start = i * perSiteSamples;
		const end = start + perSiteSamples;
		if (start >= samples.length) break;
		const chunk = samples.slice(start, end);
		if (chunk.length === 0) break;
		const url = siteUrls[i] ?? `site-${i}`;
		results.push({
			index: i,
			url,
			samples: chunk,
		});
	}
	return results;
}

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
		// close the window we just opened
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
	avg: number;
	max: number;
	count: number;
	hasData: boolean;
	logFile: string;
	errorLogFile: string;
};
type BrowserReport = BrowserRunResult & {
	averagePerSite: SiteAverage[];
	rawSamples: number[];
	rawSamplesPerSite: SiteSamples[];
};
const overallResults: BrowserReport[] = [];

async function writeResultsReport(results: BrowserReport[]) {
	const payload = {
		generatedAt: new Date().toISOString(),
		sampleIntervalMs,
		waitTimeSeconds,
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

// --- ETC Calculation (exact, from explicit sleeps) ---
const totalSteps = browsers.length * urls.length;
// per test (per browser):
// - wait after powermetrics start
// - wait after browser launch
// - per URL: waitTimeSeconds + close window
// - quit browser
// - wait after powermetrics stop
const TEST_SLEEP_PER_BROWSER_MS =
	POWERMETRICS_STARTUP_DELAY_MS +
	BROWSER_LAUNCH_DELAY_MS +
	urls.length * (waitTimeSeconds * 1000 + WINDOW_CLOSE_DELAY_MS) +
	BROWSER_QUIT_DELAY_MS +
	POWERMETRICS_STOP_DELAY_MS;
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

	const logFile = `${LOG_DIR}/power_log_${browser.replace(/\s+/g, "_")}.txt`;
	const errorLogFile = `${LOG_DIR}/power_error_${browser.replace(
		/\s+/g,
		"_",
	)}.txt`;

	// 1. Start monitoring power consumption in the background
	console.log(`[Monitor] Starting powermetrics (logging to ${logFile})...`);
	const powerMonitor = Bun.spawn(
		[
			"sudo",
			"powermetrics",
			"--samplers",
			"cpu_power",
			"-i",
			`${sampleIntervalMs}`,
		],
		{
			stdout: Bun.file(logFile),
			stderr: Bun.file(errorLogFile),
		},
	);
	console.log(`[Monitor] Started (PID: ${powerMonitor.pid})`);

	try {
		// Give powermetrics a moment to start
		await Bun.sleep(POWERMETRICS_STARTUP_DELAY_MS);

		// 2. Launch the browser
		console.log(`[Test] Launching ${browser}...`);
		await launchBrowser(browser);
		await Bun.sleep(BROWSER_LAUNCH_DELAY_MS); // wait for the browser to launch

		// 3. Loop through URLs
		for (const url of urls) {
			console.log(`[Test]   Opening ${url}...`);

			// 4. Open the URL
			await openUrlInBrowser(browser, url);

			// 5. Monitor for one minute
			console.log(`[Monitor]  Waiting ${waitTimeSeconds} seconds...`);
			await Bun.sleep(waitTimeSeconds * 1000);

			// Update ETC
			currentStep++;
			logETC(startTime, currentStep, totalSteps);

			// 6. Close the window
			console.log("[Test]   Closing window...");
			await closeTab(browser);
		}

		// 7. Quit the browser
		console.log(`[Test] Quitting ${browser}...`);
		await quitBrowser(browser);
		await Bun.sleep(BROWSER_QUIT_DELAY_MS); // wait for it to fully quit
	} catch (error) {
		console.error(`[Error] Test failed for ${browser}:`, error);
	} finally {
		// 8. Stop monitoring (ALWAYS run this)
		console.log("[Monitor] Stopping powermetrics...");
		powerMonitor.kill();
		await Bun.sleep(POWERMETRICS_STOP_DELAY_MS); // give it a moment to stop
		console.log("[Monitor] Stopped.");

		// 9. Process results
		console.log("[Results] Processing power log...");
		const logContent = await Bun.file(logFile).text();
		const { avg, max, count } = parsePowerLog(logContent);
		const rawSamples = extractPowerSamples(logContent);
		const averagePerSite = computePerSiteAverages(rawSamples, urls);
		const rawSamplesPerSite = computeSamplesPerSite(rawSamples, urls);
		const hasData = count > 0;
		overallResults.push({
			browser,
			avg,
			max,
			count,
			hasData,
			logFile,
			errorLogFile,
			averagePerSite,
			rawSamples,
			rawSamplesPerSite,
		});

		if (hasData) {
			console.log(`[Results] --- ${browser} ---`);
			console.log(`[Results] Average Power: ${avg.toFixed(2)} mW`);
			console.log(`[Results] Max Power: ${max} mW`);
			console.log(`[Results] Samples Taken: ${count}`);
		} else {
			console.log(`[Results] No power data captured for ${browser}.`);
			console.log(`[Results] Check ${errorLogFile} for errors.`);
		}

		// 10. Clean up log files
		// We'll leave the log files in the logs/ directory for review
		console.log("[Test] Log files are available in ./logs/");
		// 11. Write cumulative results so far so partial runs are preserved
		await writeResultsReport(overallResults);
	}
	browserIndex++;
}

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
		// sort by avg ascending (lower is better)
		successful.sort((a, b) => a.avg - b.avg);
		const namePad = Math.max(
			"Browser".length,
			...successful.map((r) => r.browser.length),
		);
		console.log(
			`[Results] ${"Browser".padEnd(namePad)}  ${"Avg (mW)".padStart(9)}  ${"Max (mW)".padStart(9)}  ${"Samples".padStart(8)}`,
		);
		for (const r of successful) {
			console.log(
				`[Results] ${r.browser.padEnd(namePad)}  ${r.avg.toFixed(2).padStart(9)}  ${String(r.max).padStart(9)}  ${String(r.count).padStart(8)}`,
			);
		}
		const best = successful.reduce((min, r) => (r.avg < min.avg ? r : min));
		console.log(
			`[Results] Best (lowest avg power): ${best.browser} (${best.avg.toFixed(2)} mW)`,
		);
	}

	for (const r of missing) {
		console.log(
			`[Results] ${r.browser}: no power data captured (see ${r.errorLogFile})`,
		);
	}
}

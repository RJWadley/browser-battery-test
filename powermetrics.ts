import { spawn } from "bun";

export type EnergyResult = {
	averagePower: number;
	averagePowerUnit: string;
	totalEnergy: number;
	totalEnergyUnit: string;
	sampleInterval: number;
	rawSamples: number[];
};

export type StartTrackingOptions = {
	/**
	 * desired sampling interval in milliseconds passed to powermetrics (-i).
	 * bun-level timing jitter doesn't matter; we compute energy from samples.
	 */
	sampleIntervalMs?: number;
	/**
	 * include additional powermetrics samplers. defaults to ["cpu_power"].
	 * note: combined power appears in cpu_power; changing this risks no matches.
	 */
	samplers?: string[];
	/**
	 * when true, attempts to run powermetrics without sudo. this usually fails
	 * on macos unless the user has special entitlements. prefer keeping sudo.
	 */
	disableSudo?: boolean;
};

export type EnergyTracker = {
	/**
	 * resolves once we've seen at least one combined-power sample or the
	 * powermetrics stream has finished. callers can await this before starting
	 * the measured action to avoid "pre-warm" skew.
	 */
	ready: Promise<void>;
	/**
	 * kills powermetrics, waits for the reader to finish, and returns metrics.
	 */
	stopTracking(): Promise<EnergyResult>;
	/**
	 * underlying powermetrics pid for debugging.
	 */
	pid: number;
};

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_SAMPLERS = ["cpu_power"];

// relaxed match for "Combined Power (CPU + GPU + ANE): NNNN mW"
// keep a specific pattern first, fall back to a broader one if apple adjusts labels
const COMBINED_POWER_REGEXPS: RegExp[] = [
	/Combined Power \(CPU \+ GPU(?: \+ ANE)?\):\s*(\d+)\s*mW/i,
	/Combined Power.*?:\s*(\d+)\s*mW/i,
];

function tryParseMilliwatts(line: string): number | null {
	for (const re of COMBINED_POWER_REGEXPS) {
		const m = re.exec(line);
		if (m?.[1]) return Number.parseInt(m[1], 10);
	}
	return null;
}

export function startTrackingEnergy(
	opts: StartTrackingOptions = {},
): EnergyTracker {
	const sampleIntervalMs = Math.max(
		1,
		Math.floor(opts.sampleIntervalMs ?? DEFAULT_INTERVAL_MS),
	);
	const samplers = opts.samplers?.length ? opts.samplers : DEFAULT_SAMPLERS;
	const useSudo = !opts.disableSudo;

	const args = [
		"powermetrics",
		"--samplers",
		samplers.join(","),
		"-i",
		String(sampleIntervalMs),
	];

	const cmd = useSudo ? ["sudo", ...args] : args;

	// pipe stdout so we can parse lines and accumulate samples in memory
	const proc = spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});

	const rawSamples: number[] = [];
	let readerDone: Promise<void> | null = null;

	let readyResolve: (() => void) | undefined;
	let readySettled = false;
	const ready = new Promise<void>((resolve) => {
		readyResolve = () => {
			if (readySettled) return;
			readySettled = true;
			resolve();
		};
	});

	// consume stdout and parse samples incrementally
	if (proc.stdout) {
		const decoder = new TextDecoder();
		let buffer = "";
		readerDone = (async () => {
			// @ts-ignore bun's ReadableStream iterable
			for await (const chunk of proc.stdout) {
				buffer += decoder.decode(chunk as Uint8Array, { stream: true });
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					const mw = tryParseMilliwatts(line);
					if (mw != null) {
						rawSamples.push(mw);
						if (!readySettled && readyResolve) {
							readyResolve();
						}
					}
					nl = buffer.indexOf("\n");
				}
			}
			// flush remainder (last line without newline)
			if (buffer.length > 0) {
				const mw = tryParseMilliwatts(buffer);
				if (mw != null) {
					rawSamples.push(mw);
					if (!readySettled && readyResolve) {
						readyResolve();
					}
				}
			}
			// if stream ended with no samples at all, still resolve ready
			if (!readySettled && readyResolve) {
				readyResolve();
			}
		})();
	} else {
		// no stdout stream; resolve ready immediately so callers don't hang
		if (readyResolve) {
			readyResolve();
		}
	}

	async function stop(): Promise<EnergyResult> {
		// ensure ready can't hang even if caller never awaited it
		if (!readySettled && readyResolve) {
			readyResolve();
		}

		// terminate powermetrics; wait for graceful exit
		try {
			proc.kill();
		} catch {
			// already exited
		}
		// ensure streams close
		try {
			await proc.exited;
		} catch {
			// ignore exit errors; we'll still compute from what we captured
		}
		if (readerDone) {
			try {
				await readerDone;
			} catch {
				// ignore reader errors; partial samples are fine
			}
		}

		const count = rawSamples.length;
		if (count === 0) {
			return {
				averagePower: 0,
				averagePowerUnit: "mW",
				totalEnergy: 0,
				totalEnergyUnit: "mWh",
				sampleInterval: sampleIntervalMs,
				rawSamples,
			};
		}

		// energy (mWh) = sum(mW) * dt(ms) / 3_600_000
		const sumMilliwatts = rawSamples.reduce((a, b) => a + b, 0);
		const totalEnergyMWh = (sumMilliwatts * sampleIntervalMs) / 3_600_000;
		// average power consistent with energy over total observed duration
		const averagePowermW =
			(totalEnergyMWh * 3_600_000) / (count * sampleIntervalMs);

		return {
			averagePower: averagePowermW,
			averagePowerUnit: "mW",
			totalEnergy: totalEnergyMWh,
			totalEnergyUnit: "mWh",
			sampleInterval: sampleIntervalMs,
			rawSamples,
		};
	}

	return {
		ready,
		stopTracking: stop,
		pid: proc.pid,
	};
}

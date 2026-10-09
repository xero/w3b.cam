// Terminal banner and spinner for the long site rebuilds (`bun bake`, `bun dev`). Frames draw from a
// worker thread because the bake blocks the main thread for seconds at a time (sync SQLite
// reads, grouping, autotags), which would freeze a setInterval spinner mid-build.
// Truthy CI turns both off so Actions logs stay clean; so does a non-terminal stderr.

import { writeSync } from "node:fs";
import { format } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

/** One braille cell per tick; the doubled frames are deliberate holds where the snake shrinks to one dot. */
export const FRAMES = ["⠁", "⠁", "⠉", "⠙", "⠚", "⠒", "⠂", "⠂", "⠒", "⠲", "⠴", "⠤", "⠄", "⠄", "⠤", "⠠", "⠠", "⠤", "⠦", "⠖", "⠒", "⠐", "⠐", "⠒", "⠓", "⠋", "⠉", "⠈", "⠈"];
const INTERVAL = 80;

/** Animate unless CI is truthy (1/true/yes/on; GitHub Actions sets CI=true) or stderr is not a terminal. */
export const animated = (env: NodeJS.ProcessEnv = process.env, tty = !!process.stderr.isTTY): boolean =>
	tty && !/^(1|true|yes|on)$/i.test(env.CI?.trim() ?? "");

const CLEAR = "\r\x1b[K";
const paint = (sgr: string, s: string): string => (process.env.NO_COLOR ? s : `\x1b[${sgr}m${s}\x1b[0m`);
export const clock = (ms: number, sep = ""): string => {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${sep}${String(s % 60).padStart(2, "0")}s`;
};
// Clipped to the terminal: a wrapped line strands rows that CLEAR can't reach on the next frame.
const line = (mark: string, msg: string, t0: number): string => {
	const t = clock(Date.now() - t0), w = (process.stderr.columns || 80) - t.length - 4;
	return `${CLEAR}${mark} ${msg.length > w ? `${msg.slice(0, Math.max(0, w - 1))}…` : msg} ${paint("2", t)}`;
};

// lock[0] guards the terminal line: 0 free, 1 held. The main thread waits for it; the worker
// just skips a frame, so a log line and a frame can never interleave mid-write.
const take = (l: Int32Array): void => { while (Atomics.compareExchange(l, 0, 0, 1) !== 0) Atomics.wait(l, 0, 1, 5); };
const give = (l: Int32Array): void => { Atomics.store(l, 0, 0); Atomics.notify(l, 0); };

export type Spinner = { update(msg: string): void; stop(msg?: string): void; fail(msg?: string): void };
const NOOP: Spinner = { update() {}, stop() {}, fail() {} };

/**
 * Start the spinner on stderr. Until stop/fail, console output is written above it, and
 * Ctrl+C or an early process.exit still restores the cursor. A no-op when not `animated()`.
 */
export function spin(msg: string): Spinner {
	if (!animated()) return NOOP;
	const lock = new Int32Array(new SharedArrayBuffer(4)), t0 = Date.now();
	const w = new Worker(new URL(import.meta.url), { workerData: { spinner: { lock, msg, t0 } } });
	w.unref();
	writeSync(2, "\x1b[?25l");

	const con = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
	const route = (fd: number, k: keyof typeof con) => (...a: unknown[]): void => {
		take(lock);
		try {
			writeSync(fd, `${fd === 2 || process.stdout.isTTY ? CLEAR : ""}${format(...a)}\n`);
		} catch {
			con[k](...a);
		} finally {
			give(lock);
		}
	};
	for (const k of ["log", "info", "debug"] as const) console[k] = route(1, k);
	for (const k of ["warn", "error"] as const) console[k] = route(2, k);

	let cur = msg, done = false;
	const end = (mark: string, m: string): void => {
		if (done) return;
		done = true;
		take(lock); // never given back, so the worker can't draw over the final line
		void w.terminate();
		Object.assign(console, con);
		process.off("SIGINT", onInt).off("SIGTERM", onTerm).off("exit", onExit);
		writeSync(2, `${m ? `${line(mark, m, t0)}\n` : CLEAR}\x1b[?25h`);
	};
	const s: Spinner = {
		update: (m) => { cur = m; w.postMessage(m); },
		stop: (m = cur) => end(paint("32", "✓"), m),
		fail: (m = cur) => end(paint("31", "✗"), m),
	};
	const sig = (code: number) => (): void => { s.fail("interrupted"); process.exit(code); };
	const onInt = sig(130), onTerm = sig(143);
	const onExit = (code: number): void => (code ? s.fail() : s.stop());
	process.once("SIGINT", onInt).once("SIGTERM", onTerm).once("exit", onExit);
	return s;
}

/** Spin while `fn` runs: ✓ `done` when it resolves (an empty `done` just clears the line), ✗ (then rethrow) when it rejects. */
export async function spinning<T>(msg: string, fn: () => Promise<T>, done = ""): Promise<T> {
	const s = spin(msg);
	try {
		const v = await fn();
		s.stop(done);
		return v;
	} catch (e) {
		s.fail();
		throw e;
	}
}

// The wordmark is String.raw so its backslashes survive. The camera can't be: Bun rewrites non-ASCII
// in a raw template to \uXXXX escapes, which String.raw then returns verbatim. ESC goes in through
// ${E}; the wordmark row ending in a backslash keeps a trailing space so it can't escape that ${.
const E = "\x1b";
export const BANNER = String.raw`  ${E}[37mhttps://w3b.cam          .--.${E}[0m
                   ${E}[37m.------/   |           ________      _________ _____${E}[0m
   ${E}[37m.----./\.----__/ __    \   !----.    .'       / .---'    \    \     \ ${E}[0m
    ${E}[37m\   /  \    \___>     |     _   \  /   /____/ /   _     /     >   . |${E}[0m
    ${E}[37m|         . |__<     <| :   )    |<    \    \/    (     |        .: |${E}[0m
    ${E}[37m|       .:: \   >  .: | ::.      |_\     .:: \ ::..  _  /       .:: |${E}[0m
    ${E}[37m|____/\_____|\_______/\/\_______/(_)\______  /\______>\/\__/\/\_____|${E}[0m
                                               ${E}[37m\/${E}[0m` + `

                       ${E}[37m▄▄▄▄▄▄▄▄${E}[30;47m▀▀${E}[37;40m████████████████████████████████${E}[0m
              ${E}[37m▄▄█████████████████████████████▀▀▀▀▀▀▀▀▀▀▀▀▀███████${E}[0m
              ${E}[37m███▌▒▌▒▌▒▌▒██████████████████▀  ░░░░░░░░ ░▒  ▓▓██▀${E}[0m
              ${E}[37m▀██████████████████████████▀ ░ ░░  ▄▄  ░░ ▒▓ ▓█▀${E}[0m
               ${E}[37m▄▄▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ░▒ ░ ▄█▀▀█▄ ░ ▓▓ ▀${E}[0m
               ${E}[37m▀███▓▓▓▓▓▓▓▓▓░░░░░░░░░░░▒▒ ▒█ ░ ▀█▄██▀ ░ ▓█${E}[0m
                  ${E}[37m▀▀▀█████▓▓▓▓▓▓▓▓▓▓▓▓▓▓█ ██ ░░  ▀▀  ░░ ██${E}[0m
           ${E}[37m▄▄▄▄▄▄        ▀▀▀▀████████████ ██  ░░░░░░░░  ██${E}[0m
          ${E}[37m█${E}[30;47mo${E}[37;40m████${E}[30;47mo${E}[37;40m█           ▄▄▄▄ ▀▀▀▀███▄▀██▄▄▄▄▄▄▄▄▄▄██▀${E}[0m
          ${E}[37m███▀▀▀▀▀           ▒▓██${E}[0m
          ${E}[37m██ ███▓▓▓▓▓▓▓▓▓▓▓▓▓▓██▀${E}[0m
          ${E}[37m██▄▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀     w a t c h i n g   t h e m${E}[0m
          ${E}[37m█${E}[30;47mo${E}[37;40m████${E}[30;47mo${E}[37;40m█${E}[0m
          ${E}[37m▀██████▀                    w a t c h i n g   u s${E}[0m`;

/** BANNER on stderr ahead of a bake, gated like the spinner (off under CI or off a terminal); NO_COLOR strips its colors. */
export const banner = (): void => {
	if (animated()) writeSync(2, `${process.env.NO_COLOR ? BANNER.replace(/\x1b\[[\d;]*m/g, "") : BANNER}\n\n`);
};

// Worker side: this same file, booted by spin() above.
if (!isMainThread && workerData?.spinner) {
	const { lock, t0 } = workerData.spinner as { lock: Int32Array; t0: number };
	let msg: string = workerData.spinner.msg, i = 0;
	parentPort!.on("message", (m: string) => (msg = m));
	const tick = (): void => {
		if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return;
		try {
			writeSync(2, line(paint("32", FRAMES[i++ % FRAMES.length]!), msg, t0));
		} catch {
			// EAGAIN on a busy terminal only drops this frame
		} finally {
			give(lock);
		}
	};
	tick();
	setInterval(tick, INTERVAL);
}

import { tmpdir } from "os";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { pathToFileURL } from "url";

const execFileAsync = promisify(execFile);
const {
	promises: { mkdir },
} = fs;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makeAbsolute = (filePath) =>
	path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

/**
 * @param {import('.').Options} options
 */
async function getLogFilePath(options) {
	const logFilePath = options.logFilePath
		? makeAbsolute(options.logFilePath)
		: `${tmpdir()}/v8-deopt-generate-log/v8.log`;

	const logDir = path.dirname(logFilePath);
	await mkdir(logDir, { recursive: true });

	return logFilePath;
}

async function getPuppeteer() {
	return import("puppeteer")
		.then((module) => module.default)
		.catch((error) => {
			if (
				error.message.includes("Cannot find module") ||
				error.message.includes("Cannot find package")
			) {
				console.error(
					'Could not find "puppeteer" package. Please install "puppeteer" as a peer dependency to this package to generate logs for HTML files and URLs'
				);
				process.exit(1);
			} else {
				throw error;
			}
		});
}

/**
 * @param {string} srcUrl
 * @param {import('../').Options} options
 */
async function runPuppeteer(srcUrl, options) {
	const puppeteer = await getPuppeteer();
	const logFilePath = await getLogFilePath(options);
	const v8Flags = [
		"--trace-ic",
		`--logfile=${logFilePath}`,
		"--no-logfile-per-isolate",
	];
	const args = [
		"--disable-extensions",
		`--js-flags=${v8Flags.join(" ")}`,
		`--no-sandbox`,
		srcUrl,
	];

	let browser;
	try {
		browser = await puppeteer.launch({
			ignoreDefaultArgs: ["about:blank"],
			args,
		});

		await browser.pages();

		// Wait 5s to allow page to load
		await delay(options.browserTimeoutMs);
	} finally {
		if (browser) {
			await browser.close();
			// Give the browser 1s to release v8.log
			await delay(100);
		}
	}

	return logFilePath;
}

async function generateForRemoteURL(srcUrl, options) {
	return runPuppeteer(srcUrl, options);
}

async function generateForLocalHTML(srcPath, options) {
	const srcUrl = pathToFileURL(makeAbsolute(srcPath)).toString();
	return runPuppeteer(srcUrl, options);
}

async function generateForNodeJS(srcPath, options) {
	const logFilePath = await getLogFilePath(options);
	const args = [
		"--trace-ic",
		`--logfile=${logFilePath}`,
		"--no-logfile-per-isolate",
		srcPath,
	];

	await execFileAsync(process.execPath, args, {});

	return logFilePath;
}

/** @type {import('.').Options} */
const defaultOptions = {
	browserTimeoutMs: 5000,
};

/**
 * @param {string} srcPath
 * @param {import('.').Options} options
 * @returns {Promise<string>}
 */
export async function generateV8Log(srcPath, options = {}) {
	options = Object.assign({}, defaultOptions, options);
	if (srcPath.startsWith("http://") || srcPath.startsWith("https://")) {
		return generateForRemoteURL(srcPath, options);
	} else if (srcPath.endsWith(".html")) {
		return generateForLocalHTML(srcPath, options);
	} else {
		return generateForNodeJS(srcPath, options);
	}
}
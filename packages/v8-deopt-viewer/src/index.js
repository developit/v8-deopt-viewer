import * as path from "path";
import { readFile, writeFile, copyFile } from "fs/promises";
import { fileURLToPath } from "url";
import open from "open";
import { get } from "httpie/dist/httpie.mjs";
import { generateV8Log } from "v8-deopt-generate-log";
import { parseV8Log, groupByFile } from "v8-deopt-parser";
import { determineCommonRoot } from "./determineCommonRoot.js";

// TODO: Replace with import.meta.resolve when stable
import { createRequire } from "module";

// @ts-ignore
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, "template.html");

/**
 * @param {import('v8-deopt-parser').PerFileV8DeoptInfo} deoptInfo
 * @returns {Promise<Record<string, import('./').V8DeoptInfoWithSources>>}
 */
async function addSources(deoptInfo) {
	const files = Object.keys(deoptInfo);
	const root = determineCommonRoot(files);

	/** @type {Record<string, import('v8-deopt-webapp').V8DeoptInfoWithSources>} */
	const result = Object.create(null);
	for (let file of files) {
		let srcPath;

		let src, srcError;
		if (file.startsWith("https://")) {
			try {
				srcPath = file;
				const { data } = await get(file);
				src = data;
			} catch (e) {
				srcError = e;
			}
		} else {
			let filePath = file.startsWith("file://") ? fileURLToPath(file) : file;
			if (path.isAbsolute(filePath)) {
				try {
					srcPath = filePath;
					src = await readFile(filePath, "utf8");
				} catch (e) {
					srcError = e;
				}
			} else {
				srcError = new Error("File path is not absolute");
			}
		}

		const relativePath = root ? file.slice(root.length) : file;
		if (srcError) {
			result[file] = {
				...deoptInfo[file],
				relativePath,
				srcPath,
				srcError: srcError.toString(),
			};
		} else {
			result[file] = {
				...deoptInfo[file],
				relativePath,
				srcPath,
				src,
			};
		}
	}

	return result;
}

/**
 * @param {string} srcFile
 * @param {import('.').Options} options
 */
export default async function run(srcFile, options) {
	let logFilePath;
	if (srcFile) {
		if (srcFile.startsWith("http://")) {
			throw new Error(
				"Please use an https URL. This script runs websites without a sandbox and untrusted URLs could compromise your machine."
			);
		}

		console.log("Running and generating log...");
		logFilePath = await generateV8Log(srcFile, {
			logFilePath: path.join(options.out, "v8.log"),
			browserTimeoutMs: options.timeout,
		});
	} else if (options.input) {
		logFilePath = path.isAbsolute(options.input)
			? options.input
			: path.join(process.cwd(), options.input);
	} else {
		throw new Error(
			'Either a file/url to generate a log or the "--input" flag pointing to a v8.log must be provided'
		);
	}

	console.log("Parsing log...");
	const logContents = await readFile(logFilePath, "utf8");
	const rawDeoptInfo = await parseV8Log(logContents, {
		keepInternals: options["keep-internals"],
	});

	console.log("Adding sources...");
	const deoptInfo = await addSources(groupByFile(rawDeoptInfo));
	const deoptInfoString = JSON.stringify(deoptInfo, null, 2);
	const jsContents = `window.V8Data = ${deoptInfoString};`;
	await writeFile(path.join(options.out, "v8-data.js"), jsContents, "utf8");

	console.log("Generating webapp...");
	const template = await readFile(templatePath, "utf8");
	const indexPath = path.join(options.out, "index.html");
	await writeFile(indexPath, template, "utf8");

	// @ts-ignore
	const require = createRequire(import.meta.url);
	const webAppIndexPath = require.resolve("v8-deopt-webapp");
	const webAppStylesPath = webAppIndexPath.replace(/.js$/g, ".css");
	await copyFile(webAppIndexPath, path.join(options.out, "v8-deopt-webapp.js"));
	await copyFile(webAppStylesPath, path.join(options.out, "v8-deopt-webapp.css"));

	if (options.open) {
		await open(indexPath, { url: true });
		console.log(
			`Done! Opening ${path.join(options.out, "index.html")} in your browser...`
		);
	} else {
		console.log(
			`Done! Open ${path.join(options.out, "index.html")} in your browser.`
		);
	}
}

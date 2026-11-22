import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function windowsNpmArgs(args) {
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Cannot locate npm on Windows. Run this command through its npm script.");
	if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI: ${npmCli}`);
	return [npmCli, ...args];
}

export function execNpmSync(args, options = {}) {
	if (process.platform !== "win32") return execFileSync("npm", args, options);
	return execFileSync(process.execPath, windowsNpmArgs(args), options);
}

/** Windows cannot spawn npm.cmd without a shell (EINVAL); run the npm CLI through Node like execNpmSync. */
export function spawnNpmSync(args, options = {}) {
	if (process.platform !== "win32") return spawnSync("npm", args, options);
	return spawnSync(process.execPath, windowsNpmArgs(args), options);
}

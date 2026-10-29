import type esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';

let routerCommit = 'unversioned';
try {
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src/core'], { encoding: 'utf8' }).trim();
	routerCommit = commit + (dirty ? '-dirty' : '');
} catch {
	/* Source archives may not contain Git metadata. */
}

export default {
	entryPoints: {
		'index': './src/index',
		'router-core': './src/ui/browser-core.js',
	},
	entryNames: '[name]',
	assetNames: '[name]',
	bundle: true, // 用于内部方法调用，请勿修改
	minify: false, // 用于内部方法调用，请勿修改
	loader: {},
	outdir: './dist/',
	sourcemap: undefined,
	platform: 'browser', // 用于内部方法调用，请勿修改
	format: 'iife', // 用于内部方法调用，请勿修改
	globalName: 'edaEsbuildExportName', // 用于内部方法调用，请勿修改
	treeShaking: true,
	ignoreAnnotations: true,
	define: { __JSPCB_ROUTER_COMMIT__: JSON.stringify(routerCommit) },
	external: [],
} satisfies Parameters<(typeof esbuild)['build']>[0];

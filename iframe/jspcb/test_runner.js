const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- 模拟浏览器环境 ---
global.js_pcb = {};
global.window = global;
global.self = global;
// 某些脚本可能需要 require (如 dsn-normalizer.js)
global.require = require;
global.module = { exports: {} }; // Mock module

// 模拟 importScripts
global.importScripts = function (...files) {
	for (const file of files) {
		const filePath = path.join(__dirname, file);
		try {
			const content = fs.readFileSync(filePath, 'utf8');
			// 使用 vm.runInThisContext 在全局作用域执行
			vm.runInThisContext(content, { filename: filePath });
			console.log(`Loaded ${file}`);
		} catch (e) {
			console.error(`Error loading script ${file}:`, e);
		}
	}
};

// 模拟 postMessage (用于接收 worker 输出)
// 新版 worker 最终发送 { type: 'done', data: best_pcb, ... }，
// 中间还会发送 progress/log 和 pcb 数组，只保留 done.data（或旧版数组）。
let workerOutput = null;
let workerDone = false;
global.postMessage = function (msg) {
	if (msg && msg.type === 'done') {
		workerOutput = msg.data;
		workerDone = true;
	} else if (Array.isArray(msg) && msg.length === 2) {
		workerOutput = msg;
	}
};

global.addEventListener = function (type, listener) {
	// 忽略
};

// --- 加载核心库 ---
// 顺序很重要
const libFiles = ['mymath.js', 'layer.js', 'router.js', 'dsn2pcb.js', 'dsn-normalizer.js', 'pcb2ses.js'];

console.log('Loading libraries...');
// 防止 dsn-normalizer.js 执行 CLI 逻辑
const originalArgv = process.argv;
process.argv = undefined;

for (const file of libFiles) {
	global.importScripts(file);
}

// 恢复 argv
process.argv = originalArgv;

// 加载 worker.js
// worker.js 会调用 importScripts 加载 mymath, layer, router，这是重复的但无害
// worker.js 定义了 pcb_thread
console.log('Loading worker.js...');
global.importScripts('worker.js');

// 确保 pcb_thread 可用
if (typeof pcb_thread !== 'function') {
	console.error('ERROR: pcb_thread not found!');
	process.exit(1);
}

// --- 测试流程 ---

async function runTest() {
	const cliFiles = process.argv.slice(2);
	if (cliFiles.length) {
		for (const file of cliFiles) await testFile(path.resolve(file));
		return;
	}
	const dirs = [
		path.resolve(__dirname, '..', 'jlc-file'),
		path.resolve(__dirname, '..', 'temp'),
		path.resolve(__dirname, '..', '..', 'tests', 'fixtures'),
	];
	const files = [];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			if (name.toLowerCase().endsWith('.dsn')) files.push(path.join(dir, name));
		}
	}
	if (!files.length) {
		console.error('No DSN files found. Usage: node test_runner.js <file.dsn> [...]');
		process.exit(1);
	}
	for (const file of files) await testFile(file);
}

async function testFile(dsnPath) {
	const baseName = path.basename(dsnPath, '.dsn');
	const outDir = path.resolve(__dirname, '..', '..', 'tmp');
	fs.mkdirSync(outDir, { recursive: true });
	const sesOutputPath = path.resolve(outDir, `test_output_${baseName}.ses`);

	console.log(`\n--- Test Start: ${dsnPath} ---`);
	console.log(`Input DSN: ${dsnPath}`);

	assert.ok(fs.existsSync(dsnPath), 'DSN file not found: ' + dsnPath);

	let dsnContent = fs.readFileSync(dsnPath, 'utf8');

	// 1. DSN 归一化（示例.dsn 是嘉立创格式；若已是标准格式则会原样返回）
	// 根据 main.js，用户勾选转换。
	console.log('Step 1: Normalizing EasyEDA DSN...');
	let normalizedDsn = dsnContent;
	let isDsnNormalized = false;
	const isJlcDsn = /\(resolution\s+mil\s+1000\)/i.test(dsnContent) && /host_cad\s+"EasyEDA Pro"/i.test(dsnContent);
	if (isJlcDsn) {
		try {
			normalizedDsn = global.normalizeDsn(dsnContent);
			isDsnNormalized = true;
			console.log('Normalization successful. Preview (first 2000 chars):');
			console.log(normalizedDsn.substring(0, 2000));
			if (normalizedDsn.includes('(network')) {
				console.log('✅ Found (network ... ) section in normalized DSN');
			} else {
				console.log('❌ (network ... ) section MISSING in normalized DSN');
			}
		} catch (e) {
			throw new Error('Normalization failed: ' + e.message);
		}
	} else {
		console.log('Not an EasyEDA/JLC DSN; using content as-is.');
	}

	// 2. 解析 DSN 到 PCB 数据
	console.log('Step 2: Parsing DSN to PCB data...');
	const gap = 2; // 默认值
	// dsn2pcb 需要标准 Specctra DSN（0.1um 坐标、F.Cu/B.Cu 层名）
	const pcbInputData = global.js_pcb.dsn2pcb(normalizedDsn, gap, 0);
	console.log(`DEBUG: pcbInputData tracks count: ${pcbInputData[1].length}`);
	console.log(`DEBUG: PCB Dimensions: ${pcbInputData[0]}`);

	// 3. 运行布线
	console.log('Step 3: Running Router...');
	// 参数: [pcb_data, arg_t, arg_v, arg_s, arg_z, arg_r, arg_q, arg_d, arg_fr, arg_xr, arg_yr]
	// 使用默认参数，减少时间 arg_t = 5s (默认 600)
	const args = [
		pcbInputData,
		30, // time limit (s)
		0, // detailed output (preview not needed in CLI)
		1, // samples
		16, // via cost
		1, // resolution (MUST BE > 0)
		2, // quantization (must be > 0)
		1, // distance func (Manhattan)
		2, // flood range
		1, // x range
		1, // y range
	];

	workerOutput = null;
	workerDone = false;
	pcb_thread(args);

	assert.ok(workerDone && workerOutput, 'Router failed to produce a done result');

	const finalPcbData = workerOutput;
	console.log(`DEBUG: finalPcbData tracks count: ${finalPcbData[1].length}`);
	console.log('Routing complete.');

	// 4. 导出 SES
	console.log('Step 4: Exporting SES...');
	// parseDsnInfo 需要传入 *转换后* 的 DSN 还是 *原始* DSN？
	// pcb2ses.js 的 parseDsnInfo 用来获取 netNames 和 minx/miny
	// 如果做了归一化，minx/miny 用原始 DSN 的值（dsn2pcb 内部会平移坐标，导出时需要还原）
	// 但是 pcb2ses.js 现在的 calculateGlobalBounds 是从 parseDsnInfo 内部调用的
	// 我们应该传给它 normalizedDsn 还是 dsnContent?
	// main.js 中: const dsnInfo = parseDsnInfo(originalFile); 传入的是原始文件内容
	// 所以这里应该传 dsnContent (原始 JLC DSN)

	const dsnInfo = global.parseDsnInfo(dsnContent);
	dsnInfo.fileName = baseName;
	dsnInfo.isDsnNormalized = isDsnNormalized;

	// 检查 parseDsnInfo 的结果
	console.log(`Parsed DSN Info: NetNames Count = ${dsnInfo.netNames.length}`);
	console.log(`Bounds: [${dsnInfo.minx}, ${dsnInfo.miny}, ${dsnInfo.maxy}]`);

	const sesContent = global.convertPcbToSes(finalPcbData, dsnInfo, { gap: gap });
	const viaPadstacks = (sesContent.match(/\(padstack via0/g) || []).length;
	console.log('SES via0 padstack declarations:', viaPadstacks);
	if (viaPadstacks !== 1) {
		throw new Error('Expected exactly one via0 padstack declaration');
	} else {
		console.log('✅ Single via0 padstack declaration');
	}
	if (!sesContent.includes('(network_out') || !sesContent.includes('(resolution')) {
		throw new Error('SES structure check failed');
	} else {
		console.log('✅ SES has resolution and network_out sections');
	}

	fs.writeFileSync(sesOutputPath, sesContent, 'utf8');
	console.log(`SES written to ${sesOutputPath}`);
	console.log('DEBUG: SES Content Preview (first 500 chars):');
	console.log(sesContent.substring(0, 500));

	// 5. 连通性回归：3 引脚及以上网络的所有引脚必须在同一条路径网络上
	analyzeConnectivity(finalPcbData);

	// 6. 分析结果
	analyzeResults(dsnContent, sesContent, dsnInfo);
}

function analyzeConnectivity(pcbData) {
	const TOL = 0.8; // 一个网格左右
	let checked = 0;
	let bad = 0;

	function segDist2(px, py, ax, ay, bx, by) {
		const vx = bx - ax,
			vy = by - ay;
		const wx = px - ax,
			wy = py - ay;
		const c1 = vx * wx + vy * wy;
		if (c1 <= 0) return wx * wx + wy * wy;
		const c2 = vx * vx + vy * vy;
		if (c2 <= c1) {
			const dx = px - bx,
				dy = py - by;
			return dx * dx + dy * dy;
		}
		const t = c1 / c2;
		const dx = px - (ax + t * vx),
			dy = py - (ay + t * vy);
		return dx * dx + dy * dy;
	}

	// 顶点落在线段上（同层），用于处理 T 型连接：优化后交点可能不是显式顶点
	function vertexOnPath(v, path) {
		for (let i = 1; i < path.length; ++i) {
			const a = path[i - 1],
				b = path[i];
			if (a[2] !== v[2] || b[2] !== v[2]) continue;
			if (segDist2(v[0], v[1], a[0], a[1], b[0], b[1]) <= TOL * TOL) return true;
		}
		return false;
	}

	for (const track of pcbData[1]) {
		if (!(track[0] > 0)) continue;
		const terms = track[3];
		const paths = track[4];
		if (terms.length < 3) continue;
		// 未布通的网络由 worker 的 unrouted 统计负责；这里只验证已布通网络
		if (!paths.length) continue;
		checked++;

		const parent = paths.map((_, i) => i);
		function find(i) {
			while (parent[i] !== i) {
				parent[i] = parent[parent[i]];
				i = parent[i];
			}
			return i;
		}
		function union(a, b) {
			a = find(a);
			b = find(b);
			if (a !== b) parent[a] = b;
		}

		// 路径之间：共享顶点，或一个路径的顶点落在另一路径的线段上
		for (let i = 0; i < paths.length; ++i) {
			for (let j = i + 1; j < paths.length; ++j) {
				let connected = false;
				for (const v of paths[i])
					if (vertexOnPath(v, paths[j])) {
						connected = true;
						break;
					}
				if (!connected)
					for (const v of paths[j])
						if (vertexOnPath(v, paths[i])) {
							connected = true;
							break;
						}
				if (connected) union(i, j);
			}
		}

		// A through-hole pad joins paths on all of its actual copper layers.
		let missing = false;
		for (const terminal of terms) {
			const layers = terminal[4] || [];
			const tx = terminal[2][0],
				ty = terminal[2][1];
			const hits = [];
			for (let i = 0; i < paths.length; i++) {
				const near =
					paths[i].some((v) => layers.includes(v[2]) && Math.hypot(v[0] - tx, v[1] - ty) < TOL) ||
					paths[i].some(
						(b, k) =>
							k > 0 &&
							b[2] === paths[i][k - 1][2] &&
							layers.includes(b[2]) &&
							segDist2(tx, ty, paths[i][k - 1][0], paths[i][k - 1][1], b[0], b[1]) <= TOL * TOL,
					);
				if (near) hits.push(i);
			}
			if (!hits.length) {
				missing = true;
				break;
			}
			for (const hit of hits) union(hits[0], hit);
		}
		const roots = new Set(paths.map((_, i) => find(i)));
		if (missing || roots.size !== 1) bad++;
	}

	console.log('Connectivity check: multi-pin nets =', checked, ', disconnected =', bad);
	if (bad > 0) {
		throw new Error('Connectivity regression detected');
	} else {
		console.log('✅ All multi-pin nets are connected');
	}
}

function analyzeResults(dsnContent, sesContent, dsnInfo) {
	// 完整回归：DSN -> 归一化 -> dsn2pcb -> worker -> SES 已在上面的流程中执行，
	// 这里额外检查 3 个及以上引脚的网络是否在 SES 中有对应走线。
	let multiPinNets = 0;
	for (const [netName, pins] of dsnInfo.netPins || new Map()) {
		if (pins.length < 3) continue;
		multiPinNets++;
		const blockStart = sesContent.indexOf('(net ' + netName);
		const blockEnd = blockStart >= 0 ? sesContent.indexOf('(net ', blockStart + 1) : -1;
		const block = blockStart >= 0 ? sesContent.slice(blockStart, blockEnd > blockStart ? blockEnd : undefined) : '';
		if (!block.includes('(wire')) {
			console.log('⚠️  Multi-pin net has no wire in SES:', netName, 'pins=', pins.length);
		}
	}
	console.log('Multi-pin nets checked:', multiPinNets);

	console.log('\n--- Analysis Results ---');

	// 1. 网络名对比
	// pcb2ses.js 已经解析了 dsnInfo.netNames
	const expectedNets = dsnInfo.netNames;

	// 从 SES 提取网络名
	const sesNetMatches = sesContent.match(/\(net\s+"?([^"\s]+)"?/g) || [];
	const actualNets = sesNetMatches.map((s) => {
		const m = s.match(/\(net\s+"?([^"\s]+)"?/);
		return m ? m[1].replace(/^"|"$/g, '') : '';
	});

	console.log(`Expected Nets (DSN): ${expectedNets.length}`);
	console.log(`Actual Nets (SES): ${actualNets.length}`);

	const missing = expectedNets.filter((n) => !actualNets.includes(n));
	const extra = actualNets.filter((n) => !expectedNets.includes(n));

	if (missing.length > 0) {
		throw new Error('Missing nets in SES: ' + missing.join(', '));
	} else {
		console.log('✅ All DSN nets present in SES.');
	}

	if (extra.length > 0) {
		console.log('⚠️  Extra Nets in SES (might be auto-generated):', extra);
	}

	// 2. 坐标范围检查
	// SES 的 path 坐标在 `(path ...` 的后续行中，逐行解析到闭合括号
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	let pointCount = 0;
	let inPath = false;

	for (const line of sesContent.split('\n')) {
		const t = line.trim();
		if (t.startsWith('(path ')) {
			inPath = true;
			continue;
		}
		if (!inPath) continue;
		if (t === ')' || t.startsWith(')')) {
			inPath = false;
			continue;
		}
		const parts = t.split(/\s+/).filter(Boolean);
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const x = parseFloat(parts[i]);
			const y = parseFloat(parts[i + 1]);
			if (!isNaN(x)) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
			if (!isNaN(y)) {
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
			pointCount++;
		}
	}

	if (pointCount === 0) {
		console.log('⚠️  No paths found in SES output.');
	} else {
		console.log(`Coordinate Range: X[${minX}, ${maxX}], Y[${minY}, ${maxY}]`);

		// 检查是否有异常值
		if (minX < -1000000 || maxX > 10000000 || minY < -1000000 || maxY > 10000000) {
			throw new Error('SES coordinates seem out of bounds');
		} else {
			console.log('✅ Coordinates seem reasonable.');
		}
	}
}

runTest().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});

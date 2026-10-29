/**
 * JS-PCB 布线结果转换为嘉立创EDA SES 格式。
 * 共享纯函数入口：require('./src/core').convertPcbToSes(...)。
 */

'use strict';

/**
 * 将 JS-PCB 布线结果转换为 SES 格式
 * @param {Array} pcbData - JS-PCB 输出的 [[width, height, depth], tracks]
 * @param {Object} dsnInfo - 原始 DSN 文件信息
 * @param {Object} options - 转换选项
 * @returns {string} SES 格式字符串
 */
function sesAtom(value) {
	return /^[^\s()"\\]+$/.test(String(value)) ? String(value) : JSON.stringify(String(value));
}

function convertPcbToSes(pcbData, dsnInfo, options = {}) {
	const [dims, tracks] = pcbData;
	const [width, height, depth] = dims;

	const isDsnNormalized = dsnInfo.isDsnNormalized || false;
	const gap = options.gap || 1;
	const origMinx = dsnInfo.minx || 0;
	const origMiny = dsnInfo.miny || 0;
	const origMaxy = dsnInfo.maxy || 0;

	const opts = {
		resolution: 1000,
		unit: 'mil',
		fileName: options.fileName || dsnInfo.fileName || 'PCB',
		viaSize: options.viaSize || dsnInfo.viaSize || 24,
		...options,
	};

	let scale, offsetX, offsetY;
	if (isDsnNormalized) {
		scale = (1000 / 254) * 1000;
		offsetX = origMinx * 1000 - gap * scale;
		offsetY = origMaxy * 1000 + gap * scale;
	} else {
		scale = 1000;
		offsetX = (origMinx - gap) * 1000;
		offsetY = (origMaxy + gap) * 1000;
	}

	let ses = [];

	ses.push(`(session ${JSON.stringify(opts.fileName)}`);
	ses.push(`  (base_design ${JSON.stringify(opts.fileName)})`);
	ses.push(`  (placement`);
	ses.push(`    (resolution ${opts.unit} ${opts.resolution})`);
	ses.push(`    (component u1`);
	ses.push(`      (place u1 0 0 front 0)`);
	ses.push(`    )`);
	ses.push(`  )`);
	ses.push(`  (was_is`);
	ses.push(`  )`);
	ses.push(`  (routes `);
	ses.push(`    (resolution ${opts.unit} ${opts.resolution})`);
	ses.push(`    (parser`);
	ses.push(`      (host_cad "EasyEDA Pro")`);
	ses.push(`      (host_version 3.2.69)`);
	ses.push(`    )`);
	ses.push(`    (library_out `);

	// SES 中每种过孔 padstack 只声明一次（同名重复声明可能导致导入异常）
	ses.push(`      (padstack via0`);
	ses.push(`        (shape`);
	ses.push(`          (circle 1 ${opts.viaSize * 1000} 0 0)`);
	ses.push(`        )`);
	ses.push(`        (shape`);
	ses.push(`          (circle 2 ${opts.viaSize * 1000} 0 0)`);
	ses.push(`        )`);
	ses.push(`      )`);

	ses.push(`    )`);
	ses.push(`    (network_out `);

	// Build reverse map for Net lookup by Pin location
	const pinToNet = new Map();
	if (dsnInfo.netPins) {
		for (const [netName, pins] of dsnInfo.netPins) {
			for (const pinName of pins) {
				const pinPos = dsnInfo.pinPositions.get(pinName);
				if (pinPos) {
					// Key by approx coordinates to handle float precision
					// DSN coords are in mil (or unit).
					// We need to match with track terminals.
					// Store pinPos directly.
					pinToNet.set(pinName, netName);
				}
			}
		}
	}

	const processedNets = new Set();

	for (let i = 0; i < tracks.length; i++) {
		const track = tracks[i];
		const [radius, viaRadius, gap, terminals, paths] = track;

		let netName = `Net-Track-${i}`;
		let matched = false;

		// Try to identify net from terminals
		if (terminals && terminals.length > 0) {
			for (const term of terminals) {
				// terminal[2] is [x, y, z] in internal coords
				const tx = term[2][0];
				const ty = term[2][1];

				// Convert internal to DSN coords
				// x_dsn = (tx + (minx - gap)) * 1000 ? No.
				// dsn2pcb: px = val / 1000; tx = px - (minx - gap);
				// val = px * 1000 = (tx + minx - gap) * 1000.

				// However, dsn2pcb minx/miny logic uses accumulated bounds.
				// We use dsnInfo.minx (origMinx).
				// But dsn2pcb calculates its OWN minx from the tracks/boundary.
				// If we assume dsn2pcb's minx matches origMinx (converted):
				// In internal units: origMinx_internal = origMinx / 1000 (if scale 1000).

				// Better approach: Use the SES output transform reversed?
				// SES X = tx * scale + offsetX
				// SES X is in mil*1000.
				// DSN X is in mil.
				// So DSN X = SES X / 1000.
				// DSN X = (tx * scale + offsetX) / 1000.

				// DSN Y: SES Y = offsetY - ty * scale
				// SES Y is in mil*1000.
				// DSN Y = SES Y / 1000.
				// DSN Y = (offsetY - ty * scale) / 1000.

				const sesX = tx * scale + offsetX;
				const sesY = offsetY - ty * scale;

				const dsnX = sesX / 1000;
				const dsnY = sesY / 1000;

				// Search for matching pin
				for (const [pinName, pos] of dsnInfo.pinPositions) {
					if (Math.abs(pos.x - dsnX) < 0.1 && Math.abs(pos.y - dsnY) < 0.1) {
						const foundNet = pinToNet.get(pinName);
						if (foundNet) {
							netName = foundNet;
							matched = true;
							break;
						}
					}
				}
				if (matched) break;
			}
		}

		// If not matched, try to fallback to index if feasible, or skip
		if (!matched) {
			// Fallback: use index if it's within range and not already processed?
			// But we suspect reordering.
			// If we can't match, maybe it's the "unconnected" track or a track with no pins?
			// If no terminals, likely empty track.
			if (i < dsnInfo.netNames.length && !processedNets.has(dsnInfo.netNames[i])) {
				// Dangerous assumption if reordered.
				// Better to skip or use generic name.
				// But we want to output ALL nets from DSN, even if empty.
			}
		} else {
			processedNets.add(netName);
		}

		// Output the track for this net
		// Note: A net might be split into multiple tracks? JS-PCB usually 1 track per net.
		// If multiple tracks map to same net, we should merge them or output multiple (net ... entries?
		// SES allows multiple (net name ... ) blocks? Or one block with multiple wires?
		// Usually one block.

		// We will collect output strings and group by netName.
	}

	// Group paths by netName
	const netPaths = new Map(); // netName -> paths
	const netVias = new Map(); // netName -> vias (count or objects?) -> Actually paths contain vias.

	// Initialize all nets from DSN as empty
	for (const name of dsnInfo.netNames) {
		netPaths.set(name, []);
	}

	for (let i = 0; i < tracks.length; i++) {
		const track = tracks[i];
		const [radius, viaRadius, gap, terminals, paths] = track;

		// Identify Net
		let netName = typeof track[5] === 'string' && dsnInfo.netNames.includes(track[5]) ? track[5] : null;
		if (!netName && terminals && terminals.length > 0) {
			for (const term of terminals) {
				const tx = term[2][0];
				const ty = term[2][1];
				const sesX = tx * scale + offsetX;
				const sesY = offsetY - ty * scale;
				const dsnX = sesX / 1000;
				const dsnY = sesY / 1000;

				for (const [pinName, pos] of dsnInfo.pinPositions) {
					// Tolerance: 0.5 mil
					if (Math.abs(pos.x - dsnX) < 0.5 && Math.abs(pos.y - dsnY) < 0.5) {
						const foundNet = pinToNet.get(pinName);
						if (foundNet) {
							netName = foundNet;
							break;
						}
					}
				}
				if (netName) break;
			}
		}

		if (netName) {
			// Add paths to this net
			if (paths && paths.length > 0) {
				// We also need radius.
				// Store {paths, radius}
				const existing = netPaths.get(netName) || [];
				existing.push({ paths, radius });
				netPaths.set(netName, existing);
			}
		} else {
			// Unmatched track
			// Only add if it has paths (wires)
			if (paths && paths.length > 0) {
				const genName = `Unmatched-${i}`;
				const existing = netPaths.get(genName) || [];
				existing.push({ paths, radius });
				netPaths.set(genName, existing);
			}
		}
	}

	// Combine all net names (DSN defined + Unmatched)
	const allNetNames = new Set(dsnInfo.netNames);
	for (const name of netPaths.keys()) {
		allNetNames.add(name);
	}

	// Output all nets
	for (const netName of allNetNames) {
		ses.push(`      (net ${sesAtom(netName)}`);

		const groups = netPaths.get(netName);
		if (groups) {
			for (const group of groups) {
				const { paths, radius } = group;
				const wireWidth = Math.round(radius * 2 * scale);

				for (const path of paths) {
					if (path.length < 2) continue;
					let segments = splitPathByLayer(path);
					for (const seg of segments) {
						if (seg.type === 'wire') {
							ses.push(formatWire(seg.points, seg.layer, wireWidth, scale, offsetX, offsetY));
						} else if (seg.type === 'via') {
							const x = Math.round(seg.point[0] * scale + offsetX);
							const y = Math.round(offsetY - seg.point[1] * scale);
							ses.push(`        (via via0 ${x} ${y}`);
							ses.push(`        )`);
						}
					}
				}
			}
		}
		// If empty, just close (net ...)
		ses.push(`      )`);
	}

	ses.push(`    )`);
	ses.push(`  )`);
	ses.push(`)`);

	return ses.join('\n');
}

function splitPathByLayer(path) {
	const segments = [];
	let currentLayer = path[0][2];
	let currentPoints = [path[0]];

	for (let i = 1; i < path.length; i++) {
		const point = path[i];
		const prevPoint = path[i - 1];

		if (point[2] !== currentLayer) {
			if (currentPoints.length >= 2) {
				segments.push({
					type: 'wire',
					layer: currentLayer + 1,
					points: currentPoints,
				});
			}
			segments.push({
				type: 'via',
				point: prevPoint,
			});
			currentLayer = point[2];
			currentPoints = [prevPoint, point];
		} else {
			currentPoints.push(point);
		}
	}
	if (currentPoints.length >= 2) {
		segments.push({
			type: 'wire',
			layer: currentLayer + 1,
			points: currentPoints,
		});
	}
	return segments;
}

function formatWire(points, layer, width, scale, offsetX, offsetY) {
	let lines = [];
	lines.push(`        (wire`);
	lines.push(`          (path ${layer} ${width}`);
	for (const point of points) {
		const x = Math.round(point[0] * scale + offsetX);
		const y = Math.round(offsetY - point[1] * scale);
		lines.push(`            ${x} ${y}`);
	}
	lines.push(`          )`);
	lines.push(`        )`);
	return lines.join('\n');
}

function parseDsnNetNames(dsnContent) {
	// Legacy support if needed, but we prefer full info
	const info = parseDsnInfo(dsnContent);
	return info.netNames;
}

function tokenize(str) {
	const tokens = [];
	let i = 0;
	while (i < str.length) {
		const ch = str[i];
		if (ch === '"' && tokens[tokens.length - 1] === 'string_quote' && /^\s*\)/.test(str.slice(i + 1))) {
			tokens.push('"');
			i++;
			continue;
		}
		if (ch === '(' || ch === ')') {
			tokens.push(ch);
			i++;
		} else if (ch === '"') {
			let s = '"';
			i++;
			while (i < str.length && str[i] !== '"') {
				if (str[i] === '\\' && i + 1 < str.length) s += str[i++];
				s += str[i++];
			}
			if (i >= str.length) throw new Error('Unclosed DSN string');
			s += '"';
			i++;
			tokens.push(s);
		} else if (/\s/.test(ch)) {
			i++;
		} else {
			let s = '';
			while (i < str.length && !/[\s()]/.test(str[i])) {
				s += str[i];
				i++;
			}
			tokens.push(s);
		}
	}
	return tokens;
}

function parseExpr(tokens, pos, depth = 0) {
	if (depth > 128 || pos.index >= tokens.length) throw new Error('Malformed or excessively nested DSN');
	if (tokens[pos.index] === '(') {
		pos.index++;
		const list = [];
		while (tokens[pos.index] !== ')') {
			list.push(parseExpr(tokens, pos, depth + 1));
		}
		pos.index++;
		return list;
	} else {
		return tokens[pos.index++];
	}
}

function searchTree(t, s) {
	if (!Array.isArray(t)) return [];
	if (t[0] === s) return t;
	for (let i = 0; i < t.length; i++) {
		if (Array.isArray(t[i])) {
			let st = searchTree(t[i], s);
			if (st.length) return st;
		}
	}
	return [];
}

/**
 * Extract DSN details: NetNames, PinPositions, NetPins, Bounds
 */
function extractDsnDetails(tree) {
	let minx = 1000000.0;
	let miny = 1000000.0;
	let maxx = -1000000.0;
	let maxy = -1000000.0;

	const pinPositions = new Map(); // pinName -> {x, y}
	const netPins = new Map(); // netName -> [pinName]
	const netNames = [];

	// 1. Structure -> Boundary (for bounds)
	const structure = searchTree(tree, 'structure');
	if (structure.length) {
		const boundary = searchTree(structure, 'boundary');
		if (boundary.length) {
			const path = searchTree(boundary, 'path');
			if (path.length) {
				for (let i = 3; i < path.length; i += 2) {
					if (i + 1 >= path.length) break;
					const x = parseFloat(path[i]);
					const y = parseFloat(path[i + 1]);
					if (!isNaN(x)) {
						minx = Math.min(x, minx);
						maxx = Math.max(x, maxx);
					}
					if (!isNaN(y)) {
						miny = Math.min(y, miny);
						maxy = Math.max(y, maxy);
					}
				}
			}
			const rect = searchTree(boundary, 'rect');
			if (rect.length) {
				const x1 = parseFloat(rect[2]);
				const y1 = parseFloat(rect[3]);
				const x2 = parseFloat(rect[4]);
				const y2 = parseFloat(rect[5]);
				if (!isNaN(x1)) {
					minx = Math.min(x1, minx);
					maxx = Math.max(x1, maxx);
					miny = Math.min(y1, miny);
					maxy = Math.max(y1, maxy);
					minx = Math.min(x2, minx);
					maxx = Math.max(x2, maxx);
					miny = Math.min(y2, miny);
					maxy = Math.max(y2, maxy);
				}
			}
		}
	}

	// 1b. 找出结构里声明的过孔 padstack 名称，后续从 library 里取它的实际尺寸，
	// 保证 SES 里的过孔大小与设计一致（而不是永远写 24 mil）。
	let viaName = null;
	if (structure.length) {
		const viaNode = searchTree(structure, 'via');
		if (viaNode.length) {
			for (let i = 1; i < viaNode.length; i++) {
				if (typeof viaNode[i] === 'string') {
					viaName = viaNode[i].replace(/^"|"$/g, '');
				}
			}
		}
	}

	// 2. Library & Placement -> Pin Positions
	const library = searchTree(tree, 'library');
	const componentMap = new Map();
	let viaSize = null;

	if (library.length) {
		for (let i = 1; i < library.length; i++) {
			const node = library[i];
			if (!Array.isArray(node) || node[0] !== 'padstack') continue;
			const padName = typeof node[1] === 'string' ? node[1].replace(/^"|"$/g, '') : null;
			if (!viaName || padName !== viaName) continue;
			// (padstack via0 (shape (circle layer size)))
			for (let j = 2; j < node.length; j++) {
				const shape = node[j];
				if (!Array.isArray(shape) || shape[0] !== 'shape') continue;
				const prim = shape[1];
				if (Array.isArray(prim) && prim[0] === 'circle') {
					const size = parseFloat(prim[2]);
					if (!isNaN(size) && size > 0) {
						viaSize = size;
						break;
					}
				}
			}
			if (viaSize) break;
		}
	}

	if (library.length) {
		for (let i = 1; i < library.length; i++) {
			const node = library[i];
			if (Array.isArray(node) && node[0] === 'image') {
				const compName = node[1];
				const pins = new Map();
				for (let j = 2; j < node.length; j++) {
					const child = node[j];
					if (Array.isArray(child) && child[0] === 'pin') {
						// (pin padstack_name pin_name x y ...)
						const pinName = child[2];
						let px = 0,
							py = 0,
							rot = 0;
						if (Array.isArray(child[3]) && child[3][0] === 'rotate') {
							px = parseFloat(child[3][1]);
							py = parseFloat(child[3][2]);
							rot = parseFloat(child[3][3]);
						} else {
							px = parseFloat(child[3]);
							py = parseFloat(child[4]);
						}
						pins.set(pinName, { x: px, y: py, rot: rot });
					}
				}
				componentMap.set(compName, pins);
			}
		}
	}

	const placement = searchTree(tree, 'placement');
	if (placement.length) {
		for (let i = 1; i < placement.length; i++) {
			const compNode = placement[i];
			if (Array.isArray(compNode) && compNode[0] === 'component') {
				const compName = compNode[1];
				const pins = componentMap.get(compName);
				if (!pins) continue;

				for (let j = 2; j < compNode.length; j++) {
					const placeNode = compNode[j];
					if (Array.isArray(placeNode) && placeNode[0] === 'place') {
						const ref = placeNode[1];
						const x = parseFloat(placeNode[2]);
						const y = parseFloat(placeNode[3]);
						const side = placeNode[4];
						const rot = parseFloat(placeNode[5]);

						for (const [pinName, pin] of pins) {
							let mx = pin.x;
							let my = pin.y;
							if (side !== 'front') mx = -mx;
							const angle = rot * -(Math.PI / 180.0);
							const s = Math.sin(angle);
							const c = Math.cos(angle);
							const absX = c * mx - s * my + x;
							const absY = s * mx + c * my + y;

							// Store global pin position: ref-pinName (e.g., u1-32e3)
							const globalPinName = `${ref}-${pinName}`;
							pinPositions.set(globalPinName, { x: absX, y: absY });

							if (!isNaN(absX)) {
								minx = Math.min(absX, minx);
								maxx = Math.max(absX, maxx);
							}
							if (!isNaN(absY)) {
								miny = Math.min(absY, miny);
								maxy = Math.max(absY, maxy);
							}
						}
					}
				}
			}
		}
	}

	// 3. Network -> Net Names and Pins
	const network = searchTree(tree, 'network');
	if (network.length) {
		for (let i = 1; i < network.length; i++) {
			const node = network[i];
			if (Array.isArray(node) && node[0] === 'net') {
				const netName = node[1];
				const cleanName = typeof netName === 'string' ? netName.replace(/^"|"$/g, '') : 'Unknown';

				// Keep order
				if (!netNames.includes(cleanName)) {
					netNames.push(cleanName);
				}

				const currentPins = netPins.get(cleanName) || [];
				for (let j = 2; j < node.length; j++) {
					const child = node[j];
					if (Array.isArray(child) && child[0] === 'pins') {
						// child[1] ... child[n] are pin names
						for (let k = 1; k < child.length; k++) {
							currentPins.push(child[k]);
						}
					}
				}
				netPins.set(cleanName, currentPins);
			}
		}
	}

	if (minx > maxx) {
		minx = 0;
		miny = 0;
		maxy = 0;
	}

	return {
		minx,
		miny,
		maxy,
		netNames,
		pinPositions,
		netPins,
		viaName,
		viaSize,
	};
}

function parseDsnInfo(dsnContent) {
	const info = {
		fileName: 'PCB',
		resolution: 1000,
		unit: 'mil',
		netNames: [],
		pinPositions: new Map(),
		netPins: new Map(),
		minx: 0,
		miny: 0,
		maxy: 0,
		viaName: null,
		viaSize: 24,
	};

	const fileMatch = dsnContent.match(/\((?:pcb|PCB)\s+"([^"]+)"/);
	if (fileMatch) {
		info.fileName = fileMatch[1].replace(/\\/g, '/').split('/').pop().replace('.dsn', '');
	}

	const resMatch = dsnContent.match(/\(resolution\s+(\w+)\s+(\d+)\)/);
	if (resMatch) {
		info.unit = resMatch[1];
		info.resolution = parseInt(resMatch[2]);
	}

	try {
		const tokens = tokenize(dsnContent);
		const pos = { index: 0 };
		const tree = parseExpr(tokens, pos);
		const details = extractDsnDetails(tree);

		info.minx = details.minx;
		info.miny = details.miny;
		info.maxy = details.maxy;
		info.netNames = details.netNames;
		info.pinPositions = details.pinPositions;
		info.netPins = details.netPins;
		info.viaName = details.viaName || info.viaName;
		info.viaSize = details.viaSize || info.viaSize;

		// Parsing is independent of UI logging.
	} catch (e) {
		// Invalid detail extraction is handled by the caller's validation report.
		// Fallback for names if tree parsing fails completely
		const lines = dsnContent.split('\n');
		let inNetwork = false;
		for (const line of lines) {
			if (line.includes('(network')) inNetwork = true;
			if (inNetwork && line.match(/^\s*\(net\s+([^\s()]+)/)) {
				const match = line.match(/^\s*\(net\s+([^\s()]+)/);
				if (match) {
					const name = match[1].replace(/^"|"$/g, '');
					if (!info.netNames.includes(name)) {
						info.netNames.push(name);
					}
				}
			}
		}
	}

	return info;
}

module.exports = { convertPcbToSes, parseDsnInfo, parseDsnNetNames };

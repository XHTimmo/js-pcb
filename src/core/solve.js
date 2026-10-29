'use strict';
const engine = require('./engine/router.js');

function stats(data) {
	const tracks = data?.[1] || [];
	const nets = tracks.filter((track) => track[0] > 0 && !track[6]?.protected);
	const failed = nets.filter((track) => track[6]?.routed !== true && !track[4]?.length);
	return { total: nets.length, unrouted: failed.length, routed: nets.length - failed.length };
}
function seededRandom(seed) {
	let state = seed >>> 0;
	return function () {
		state = (state + 0x6d2b79f5) >>> 0;
		let n = Math.imul(state ^ (state >>> 15), 1 | state);
		n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
		return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
	};
}
function vectors(range, xr, yr) {
	const result = [];
	for (let y = yr; y >= -yr; y--)
		for (let x = xr; x >= -xr; x--) {
			const distance = Math.hypot(x, y);
			if (distance > 0.1 && distance <= range) result.push([x, y, 0]);
		}
	return result;
}

function solvePcb(input, options = {}, hooks = {}) {
	const p = {
		timeoutSec: 30,
		viaCost: 16,
		samples: 1,
		resolution: 1,
		quantization: 2,
		distanceFunction: 1,
		spread: 2,
		xRange: 1,
		yRange: 1,
		verbosity: 0,
		...options,
	};
	const now = hooks.now || Date.now;
	const notify = hooks.onEvent || function () {};
	const deadline = hooks.deadline ?? (p.timeoutSec > 0 ? now() + p.timeoutSec * 1000 : Infinity);
	const pcbData = JSON.parse(JSON.stringify(input));
	const flood = [vectors(p.spread, p.xRange, p.spread), vectors(p.spread, p.spread, p.yRange)];
	const metrics = [
		engine.squared_euclidean_distance_3d,
		engine.manhattan_distance_3d,
		engine.euclidean_distance_3d,
		engine.chebyshev_distance_3d,
		engine.reciprical_distance_3d,
	];
	const size = pcbData[0].reduce((a, b) => a * b, 1) * p.resolution * p.resolution;
	if (p.maxNodes && size > p.maxNodes) throw Object.assign(new Error('Routing grid exceeds the configured node limit'), { code: 'RESOURCE_LIMIT' });
	const pcb = new engine.Pcb(pcbData[0], flood, flood, metrics[p.distanceFunction], p.resolution, p.verbosity, p.quantization, p.viaCost, {
		...hooks,
		now,
		onEvent: notify,
		random: hooks.random || (p.seed === undefined ? Math.random : seededRandom(p.seed)),
		deadline,
	});
	for (const track of pcbData[1]) pcb.add_track(track);
	if (pcbData[2]?.length) pcb.add_wall(pcbData[2], pcbData[3] || 0);
	for (const region of p.keepouts || []) pcb.add_keepout(region);
	for (const fixed of p.fixedRoutes || []) pcb.add_fixed_route(fixed);
	const total = pcb.connected_nets();
	notify({ type: 'progress', done: 0, total });
	notify({ type: 'log', key: 'log.routingStart', args: [total, p.samples, p.timeoutSec] });
	let best = pcb.output_pcb(),
		bestCost = Infinity;
	let timedOut = false;
	notify(best);
	for (let i = 0; i < p.samples; i++) {
		notify({ type: 'log', key: 'log.sampleStart', args: [i + 1, p.samples] });
		const start = now();
		const success = pcb.route(p.sampleTimeoutSec ?? p.timeoutSec);
		if (!success && pcb.m_timedout) {
			timedOut = true;
			const cost = pcb.cost();
			if (cost < bestCost) {
				bestCost = cost;
				best = pcb.output_pcb();
			}
			notify({ type: 'log', key: 'log.timeout', args: [i + 1, p.samples, p.timeoutSec] });
			break;
		}
		if (!success) {
			pcb.increase_quantization();
			continue;
		}
		const cost = pcb.cost();
		notify({
			type: 'log',
			key: 'log.sampleDone',
			args: [i + 1, p.samples, ((now() - start) / 1000).toFixed(2), total - pcb.unrouted_nets(), total, cost],
		});
		if (cost <= bestCost) {
			bestCost = cost;
			best = pcb.output_pcb();
			notify({ type: 'log', key: 'log.better', args: [cost] });
			notify(best);
		}
	}
	const coverage = stats(best);
	const result = {
		type: 'done',
		data: best,
		cost: bestCost,
		unrouted: coverage.unrouted,
		total: coverage.total,
		status: coverage.unrouted ? (timedOut ? 'timeout' : 'partial') : 'complete',
		timedOut,
		cancelled: !!pcb.m_cancelled,
	};
	notify({ type: 'progress', done: coverage.routed, total: coverage.total });
	notify({ type: 'log', key: 'log.allDone', args: [coverage.routed, coverage.total, coverage.unrouted] });
	notify(result);
	return result;
}

// The UI retains its established per-sample timeout and positional protocol.
function solveLegacyParameters(args, hooks = {}) {
	const [input, timeoutSec, verbosity, samples, viaCost, resolution, quantization, distanceFunction, spread, xRange, yRange] = args;
	return solvePcb(
		input,
		{
			timeoutSec: timeoutSec * samples,
			sampleTimeoutSec: timeoutSec,
			verbosity,
			samples,
			viaCost,
			resolution,
			quantization,
			distanceFunction,
			spread,
			xRange,
			yRange,
		},
		hooks,
	);
}
module.exports = { solvePcb, solveLegacyParameters, stats, seededRandom };

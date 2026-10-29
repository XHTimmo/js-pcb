const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../src/core');
const { inspectResult } = require('../../src/core/inspect');
const fixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures', name + '.dsn'), 'utf8');
const ordinary = { solver: { seed: 7 } };
const power = { id: 'power-loop', net: 'POWER', layer: 'TopLayer', protected: true, segments: [{ start: [20, 60], end: [100, 60], width: 4 }] };

test('ordinary calls need no Skill and produce repeatable routing with a seed', () => {
	const a = core.routeDsn(fixture('three-pin'), ordinary);
	const b = core.routeDsn(fixture('three-pin'), ordinary);
	assert.equal(a.report.status, 'dry-run');
	assert.equal(a.report.skillVersion, null);
	assert.deepEqual(a.report.ruleChecks, []);
	assert.equal(a.report.coverage.routedNets, 1);
	assert.equal(a.report.coverage.totalPins, 3);
	assert.equal(a.report.geometry.nonOrthogonalPadExits, null);
	assert.equal(a.report.imported, false);
	assert.equal(a.ses, b.ses);
	assert.deepEqual(a.report.geometry, b.report.geometry);
	const annotated = core.routeDsn(fixture('three-pin'), { ...ordinary, rules: { skillVersion: '0.1.7' } });
	assert.equal(annotated.ses, a.ses, 'Skill version metadata must not impose hidden routing rules');
	assert.deepEqual(annotated.report.ruleChecks, []);
});

test('explicit copper and edge gaps are applied and independently checked', () => {
	const { report } = core.routeDsn(fixture('three-pin'), {
		...ordinary,
		rules: { skillVersion: '0.1.7', copperClearanceMil: 6, edgeCopperGapMil: 5 },
	});
	assert.equal(report.status, 'dry-run');
	assert.ok(report.ruleChecks.every((check) => check.status === 'passed'));
	assert.equal(report.skillVersion, '0.1.7');
});

test('unsupported required rules, unknown options and headless import fail before solving', () => {
	for (const rules of [
		{ padExit: { mode: 'orthogonal', leadMil: 8 } },
		{ cornerStyle: 'arc' },
		{ viaSilkClearanceMil: 2 },
		{ viaTestPointClearanceMil: 4 },
	]) {
		const result = core.routeDsn(fixture('three-pin'), { rules });
		assert.equal(result.report.status, 'rejected');
		assert.equal(result.report.ruleChecks[0].status, 'unsupported');
		assert.equal(result.report.geometry.tracks, null);
		assert.equal(result.ses, null);
	}
	for (const options of [
		{ mode: 'import' },
		{ constraints: { preserveExistingRoutes: true } },
		{ rules: { inventedRule: true } },
		{ solver: { timeoutSec: 0 } },
		{ target: { boardUuid: 'missing-field' } },
	]) {
		const result = core.routeDsn(fixture('three-pin'), options);
		assert.equal(result.report.status, 'rejected');
		assert.equal(result.report.routing.status, 'not-run');
	}
});

test('a fixed copper path connects its own net, survives samples and keeps its SES identity', () => {
	const fixed = { id: 'gnd-loop', net: 'GND', layer: 0, protected: true, segments: [{ start: [20, 20], end: [100, 20], width: 4 }] };
	const result = core.routeDsn(fixture('three-pin'), { solver: { seed: 7, samples: 3, resolution: 2 }, constraints: { fixedRoutes: [fixed] } });
	assert.equal(result.report.status, 'dry-run');
	assert.equal(result.report.coverage.routedNets, 1);
	const preserved = result.data[1].filter((track) => track[6]?.protected);
	assert.equal(preserved.length, 1);
	assert.equal(preserved[0][5], 'GND');
	assert.deepEqual(preserved[0][4][0], [
		[7.08, 27.4, 0],
		[27.4, 27.4, 0],
	]);
	assert.ok(result.ses.includes('20000 20000') && result.ses.includes('100000 20000'));
	assert.ok(!result.ses.includes('Unmatched-'));
});

test('a fully fixed net counts as connected without adding duplicate tracks', () => {
	const result = core.routeDsn(fixture('fixed-crossing'), { ...ordinary, constraints: { fixedRoutes: [power] } });
	assert.equal(result.report.status, 'dry-run');
	assert.equal(result.report.coverage.routedNets, 2);
	const main = result.data[1].find((track) => track[5] === 'POWER' && !track[6]?.protected);
	assert.equal(main[4].length, 0);
	assert.equal(main[6].routed, true);
	assert.equal(result.data[1].filter((track) => track[6]?.protected).length, 1);
});

test('another net cannot cross protected copper on the same layer', () => {
	const result = core.routeDsn(fixture('fixed-crossing'), { solver: { seed: 7, samples: 2 }, constraints: { fixedRoutes: [power] } });
	assert.equal(result.report.status, 'dry-run');
	const y = 60 * 0.254 + 2,
		left = 20 * 0.254 + 2,
		right = 100 * 0.254 + 2;
	for (const track of result.data[1].filter((track) => track[5] === 'SIGNAL'))
		for (const line of track[4])
			for (let i = 1; i < line.length; i++) {
				const a = line[i - 1],
					b = line[i];
				if (a[2] || b[2] || (a[1] - y) * (b[1] - y) > 0 || Math.abs(a[1] - b[1]) < 1e-7) continue;
				const x = a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]);
				assert.ok(x < left - 1 || x > right + 1, 'SIGNAL crosses the protected POWER segment');
			}
});

test('add_track honors supplied paths and remove_netlist never deletes them', () => {
	const board = new core.engine.Pcb([30, 30, 2], [[], []], [[], []], core.engine.manhattan_distance_3d, 1, 0, 2, 16);
	const path = [
		[5, 5, 0],
		[20, 5, 0],
	];
	board.add_track([0.5, 2, 1, [], [path], 'RAW_FIXED']);
	board.remove_netlist();
	board.remove_netlist();
	const preserved = board.output_pcb()[1].filter((track) => track[6]?.protected);
	assert.equal(preserved.length, 1);
	assert.deepEqual(preserved[0][4], [path]);
	assert.equal(board.m_layers.hit_line([10, 0, 0], [10, 10, 0], 0.5, 1), true);
});

test('conflicting fixed routes, pads and keepouts are rejected with stable object ids', () => {
	const crossing = { id: 'bad-signal', net: 'SIGNAL', layer: 0, protected: true, segments: [{ start: [60, 20], end: [60, 100], width: 4 }] };
	const region = {
		id: 'blocked',
		layer: 'all',
		polygon: [
			[40, 40],
			[80, 40],
			[80, 80],
			[40, 80],
		],
	};
	for (const constraints of [
		{ fixedRoutes: [power, crossing] },
		{ fixedRoutes: [power], keepouts: [region] },
		{ fixedRoutes: [{ ...power, segments: [{ start: [60, 20], end: [100, 60], width: 4 }] }] },
	]) {
		const result = core.routeDsn(fixture('fixed-crossing'), { constraints });
		assert.equal(result.report.status, 'rejected');
		assert.equal(result.report.violations[0].code, 'FIXED_ROUTE_CONFLICT');
		assert.ok(result.report.violations[0].objectIds.includes('power-loop') || result.report.violations[0].objectIds.includes('bad-signal'));
		assert.equal(result.data, null);
	}
});

test('polygon keepouts force generated copper away from their interiors', () => {
	const result = core.routeDsn(fixture('three-pin'), {
		...ordinary,
		constraints: {
			keepouts: [
				{
					id: 'antenna',
					layer: 'all',
					polygon: [
						[40, 10],
						[80, 10],
						[80, 30],
						[40, 30],
					],
					clearanceMil: 2,
				},
			],
		},
	});
	assert.equal(result.report.status, 'dry-run');
	for (const track of result.data[1])
		for (const line of track[4])
			for (const p of line) {
				const x = (p[0] - 2) / 0.254,
					y = 120 - (p[1] - 2) / 0.254;
				assert.ok(!(x > 40 && x < 80 && y > 10 && y < 30));
			}
});

test('net selection preserves excluded fixed copper but only counts requested nets', () => {
	const result = core.routeDsn(fixture('fixed-crossing'), {
		...ordinary,
		nets: { include: ['SIGNAL'], priority: { SIGNAL: 10 } },
		constraints: { fixedRoutes: [power] },
	});
	assert.equal(result.report.status, 'dry-run');
	assert.equal(result.report.coverage.totalNets, 1);
	assert.equal(result.report.coverage.routedNets, 1);
	assert.deepEqual(result.report.excludedNets, ['POWER']);
	assert.ok(result.data[1].some((track) => track[5] === 'POWER' && track[6]?.protected));
	assert.equal(core.routeDsn(fixture('three-pin'), { nets: { include: ['TYPO'] } }).report.violations[0].code, 'UNKNOWN_NET');
});

test('right-angle validation can reject a fixed path instead of falsely marking it compliant', () => {
	const fixed = {
		id: 'corner',
		net: 'GND',
		layer: 0,
		protected: true,
		segments: [
			{ start: [20, 20], end: [100, 20], width: 4 },
			{ start: [100, 20], end: [100, 100], width: 4 },
		],
	};
	const result = core.routeDsn(fixture('three-pin'), {
		rules: { forbidRightAngle: true, allowedTurnAnglesDeg: [45] },
		constraints: { fixedRoutes: [fixed] },
	});
	assert.equal(result.report.status, 'rejected');
	assert.ok(result.report.geometry.rightAngleTurns > 0);
	assert.ok(result.report.ruleChecks.every((check) => check.status === 'failed'));
});

test('coverage uses actual copper connectivity even when a solver flag claims success', () => {
	const pad = (x) => [0.5, 0, [x, 0, 0], [], [0]];
	const track = [
		0.5,
		2,
		0,
		[pad(0), pad(10)],
		[
			[
				[0, 0, 0],
				[2, 0, 0],
			],
		],
		'A',
		{ routed: true },
	];
	const data = [[20, 20, 1], [track]];
	const inspected = inspectResult(data, data, {}, { keepouts: [] });
	assert.deepEqual(inspected.coverage.failedNets, ['A']);
	assert.equal(inspected.coverage.routedNets, 0);
});

test('unsupported via geometry cannot produce a misleading clearance report or SES', () => {
	for (const source of [
		fixture('opposite-smd').replace('(circle BottomLayer 20)', '(circle BottomLayer 24)'),
		fixture('opposite-smd').replace('(layer BottomLayer', '(layer InnerLayer (type signal))\n    (layer BottomLayer'),
	]) {
		const result = core.routeDsn(source, ordinary);
		assert.equal(result.report.status, 'rejected');
		assert.equal(result.report.violations.at(-1).code, 'UNSUPPORTED_VIA_MODEL');
		assert.equal(result.ses, null);
	}
});

test('bad DSN, unknown layers, invalid polygons and excessive grids fail explicitly', () => {
	for (const source of [
		'(PCB "bad" (resolution mil 1000)',
		fixture('three-pin').replace('mil 1000', 'um 10'),
		fixture('three-pin').replace('(circle TopLayer 8)', '(circle TopLayer invalid)'),
	])
		assert.equal(core.routeDsn(source).report.status, 'rejected');
	for (const options of [
		{ solver: { maxNodes: 1 } },
		{
			constraints: {
				keepouts: [
					{
						layer: 4,
						polygon: [
							[0, 0],
							[10, 0],
							[10, 10],
						],
					},
				],
			},
		},
		{
			constraints: {
				keepouts: [
					{
						layer: 0,
						polygon: [
							[0, 0],
							[1, 1],
							[2, 2],
						],
					},
				],
			},
		},
	])
		assert.equal(core.routeDsn(fixture('three-pin'), options).report.status, 'rejected');
});

test('cancellation and a shared deadline return a partial result with honest routing state', () => {
	const cancelled = core.routeDsn(fixture('three-pin'), ordinary, { isCancelled: () => true });
	assert.equal(cancelled.report.status, 'partial');
	assert.equal(cancelled.report.routing.status, 'cancelled');
	const expired = core.routeDsn(fixture('three-pin'), ordinary, { deadline: 0 });
	assert.equal(expired.report.status, 'partial');
	assert.equal(expired.report.routing.status, 'timeout');
});

test('options, DSN data and caller-supplied fixed routes are never mutated', () => {
	const options = { ...ordinary, constraints: { fixedRoutes: [{ ...power, id: undefined }] } };
	const before = structuredClone(options);
	core.routeDsn(fixture('fixed-crossing'), options);
	assert.deepEqual(options, before);
	const input = core.dsn2pcb(core.normalizeDsn(fixture('three-pin')), 2, 0);
	const original = structuredClone(input);
	core.solvePcb(input, { seed: 1, resolution: 2 });
	assert.deepEqual(input, original);
});

test('quoted net names retain stable identity in the SES output', () => {
	const source = fixture('three-pin').replace('(net GND ', '(net "GND return" ');
	const result = core.routeDsn(source, ordinary);
	assert.equal(result.report.status, 'dry-run');
	assert.ok(result.ses.includes('(net "GND return"'));
	assert.ok(!result.ses.includes('Unmatched-'));
});

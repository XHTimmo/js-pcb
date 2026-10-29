const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routeDsn } = require('../../src/core');
const { inspectResult } = require('../../src/core/inspect');
const { buildPlanarJunctions } = require('../../src/core/junctions');

const strictAngles = { forbidRightAngle: true, allowedTurnAnglesDeg: [45] };
const point = (x, y, z = 0) => [x, y, z];
const line = (a, b) => [point(...a), point(...b)];
function inspect(paths, rules = strictAngles) {
	const data = [[100, 100, 2], [[0.25, 0.5, 0, [], paths, 'A', { routed: true }]]];
	return inspectResult(data, data, { rules }, { keepouts: [] });
}
function angleSummary(result) {
	return {
		rightAngleTurns: result.geometry.rightAngleTurns,
		ruleChecks: result.ruleChecks,
		violations: result.violations
			.filter((item) => ['RIGHT_ANGLE', 'TURN_ANGLE'].includes(item.code))
			.map((item) => [item.ruleId, item.code, +item.measured.toFixed(5)])
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
	};
}
function subdivide(paths, fractions = [0.25, 0.5, 0.75]) {
	return paths.map((path) =>
		path.flatMap((a, i) => {
			const b = path[i + 1];
			return b ? [a, ...fractions.map((t) => a.map((n, axis) => n + (b[axis] - n) * t))] : [a];
		}),
	);
}
const horizontal = line([10, 40], [90, 40]);
const branch = line([50, 40], [50, 70]);

test('issue #6: fixed T copper has identical acceptance with or without an explicit split', () => {
	const source = fs.readFileSync(path.join(__dirname, '../fixtures/fixed-crossing.dsn'), 'utf8');
	const options = {
		mode: 'dry-run',
		solver: { seed: 7, timeoutSec: 3 },
		nets: { include: ['POWER'] },
		rules: strictAngles,
		constraints: {
			fixedRoutes: [
				{
					id: 'power-with-T-branch',
					net: 'POWER',
					layer: 'TopLayer',
					protected: true,
					segments: [
						{ start: [20, 60], end: [100, 60], width: 4 },
						{ start: [60, 60], end: [60, 80], width: 4 },
					],
				},
			],
		},
	};
	const split = structuredClone(options);
	split.constraints.fixedRoutes[0].segments = [
		{ start: [20, 60], end: [60, 60], width: 4 },
		{ start: [60, 60], end: [100, 60], width: 4 },
		{ start: [60, 60], end: [60, 80], width: 4 },
	];
	const reports = [options, split].map((config) => routeDsn(source, config).report);
	for (const report of reports) {
		assert.equal(report.status, 'rejected');
		assert.equal(report.coverage.routedNets, 1);
		assert.equal(report.geometry.rightAngleTurns, 2);
		assert.ok(report.ruleChecks.every((check) => check.status === 'failed'));
		const violations = report.violations.filter((item) => item.code === 'RIGHT_ANGLE');
		assert.equal(violations.length, 2);
		assert.ok(
			violations.every(
				(item) => item.net === 'POWER' && item.objectIds.length >= 2 && item.objectIds.every((id) => id.startsWith('power-with-T-branch:')),
			),
		);
	}
	assert.deepEqual(angleSummary(reports[0]), angleSummary(reports[1]));
	const ordinary = routeDsn(source, { ...options, rules: undefined });
	assert.equal(ordinary.report.status, 'dry-run');
	assert.equal(ordinary.report.geometry.rightAngleTurns, 2);
	assert.deepEqual(ordinary.report.ruleChecks, []);
	const checked = routeDsn(source, options);
	assert.deepEqual(checked.data, ordinary.data, 'Validation must never split or rewrite routed copper');
	assert.equal(checked.ses, ordinary.ses);
});

test('an endpoint in a segment interior contributes both trunk directions', () => {
	const unsplit = inspect([horizontal, branch]);
	const split = inspect([line([10, 40], [50, 40]), line([50, 40], [90, 40]), branch]);
	assert.equal(unsplit.geometry.rightAngleTurns, 2);
	assert.deepEqual(angleSummary(unsplit), angleSummary(split));
	assert.deepEqual(angleSummary(unsplit), angleSummary(inspect(subdivide([horizontal, branch]))));
});

test('interior/interior same-layer crossings contribute four distinct right-angle pairs', () => {
	const paths = [horizontal, line([50, 10], [50, 70])];
	const original = inspect(paths);
	assert.equal(original.geometry.rightAngleTurns, 4);
	assert.equal(original.violations.filter((item) => item.code === 'RIGHT_ANGLE').length, 4);
	assert.deepEqual(angleSummary(original), angleSummary(inspect(subdivide(paths))));
});

test('oblique crossings are checked against allowed angles even without any right angle', () => {
	const paths = [horizontal, line([30, 10], [70, 70])];
	const checked = inspect(paths, { forbidRightAngle: true, allowedTurnAnglesDeg: [90] });
	assert.equal(checked.geometry.rightAngleTurns, 0);
	assert.equal(checked.violations.filter((item) => item.code === 'TURN_ANGLE').length, 4);
	assert.equal(checked.ruleChecks.find((item) => item.ruleId === 'allowedTurnAnglesDeg').status, 'failed');
	assert.equal(checked.ruleChecks.find((item) => item.ruleId === 'forbidRightAngle').status, 'passed');
});

test('45-degree branching preserves the existing turn-angle convention', () => {
	const paths = [horizontal, line([50, 40], [70, 60])];
	const result = inspect(paths, { allowedTurnAnglesDeg: [45, 135], forbidRightAngle: true });
	assert.equal(result.geometry.rightAngleTurns, 0);
	assert.deepEqual(result.violations, []);
	assert.ok(result.ruleChecks.every((item) => item.status === 'passed'));
	const strict = inspect(paths, { allowedTurnAnglesDeg: [45] });
	assert.equal(strict.violations.length, 1);
	assert.equal(strict.violations[0].measured, 135);
});

test('duplicate and reversed edges do not multiply junction angles', () => {
	const paths = [horizontal, branch];
	const repeated = [...paths, ...paths.map((path) => path.toReversed()), ...paths];
	assert.equal(inspect(repeated).geometry.rightAngleTurns, 2);
	assert.deepEqual(angleSummary(inspect(paths)), angleSummary(inspect(repeated)));
});

test('partially overlapping collinear paths retain one copy of each incident direction', () => {
	const canonical = [horizontal, branch];
	for (const paths of [
		[horizontal, line([30, 40], [70, 40]), branch],
		[line([10, 40], [60, 40]), line([30, 40], [90, 40]), branch],
		[line([10, 40], [50, 40]), horizontal, line([90, 40], [50, 40]), branch],
	])
		assert.deepEqual(angleSummary(inspect(paths)), angleSummary(inspect(canonical)));
});

test('overlap directions preserve all source object ids without duplicate violations', () => {
	const checked = inspect([horizontal, horizontal.toReversed(), branch]);
	const rightAngles = checked.violations.filter((item) => item.code === 'RIGHT_ANGLE');
	assert.equal(rightAngles.length, 2);
	for (const violation of rightAngles) {
		assert.equal(violation.net, 'A');
		assert.deepEqual(violation.objectIds, ['route:A:0:1', 'route:A:1:1', 'route:A:2:1']);
	}
});

test('a collinear union alone creates no bend, regardless of overlap or subdivision', () => {
	const paths = [horizontal, line([20, 40], [60, 40]), line([80, 40], [40, 40])];
	for (const variant of [paths, subdivide(paths)]) {
		const checked = inspect(variant);
		assert.equal(checked.geometry.rightAngleTurns, 0);
		assert.deepEqual(checked.violations, []);
	}
});

test('a split diagonal and reversed segment order leave corner results unchanged', () => {
	const paths = [line([10, 10], [70, 40]), line([70, 40], [55, 70])];
	const expected = angleSummary(inspect(paths));
	assert.equal(expected.rightAngleTurns, 1);
	const split = subdivide(paths, [0.17, 0.63, 0.91]);
	assert.deepEqual(expected, angleSummary(inspect(split)));
	assert.deepEqual(expected, angleSummary(inspect(split.toReversed().map((path) => path.toReversed()))));
});

test('multiway interior intersections merge once and deduplicate their directions', () => {
	const paths = [horizontal, line([50, 10], [50, 70]), line([20, 10], [80, 70]), line([20, 70], [80, 10])];
	const expected = angleSummary(inspect(paths));
	assert.equal(expected.rightAngleTurns, 8);
	assert.deepEqual(expected, angleSummary(inspect([...subdivide(paths, [0.1, 0.4, 0.8]), horizontal.toReversed()])));
});

test('projected intersections and shared endpoints on different copper layers are not planar junctions', () => {
	const paths = [horizontal, line([50, 10, 1], [50, 70, 1]), line([10, 40, 1], [10, 70, 1])];
	const checked = inspect(paths);
	assert.equal(checked.geometry.rightAngleTurns, 0);
	assert.deepEqual(checked.violations, []);
});

test('different nets never share turn-angle junctions', () => {
	const data = [
		[100, 100, 2],
		[
			[0.25, 0.5, 0, [], [horizontal], 'A'],
			[0.25, 0.5, 0, [], [branch], 'B'],
		],
	];
	const result = inspectResult(data, data, { rules: strictAngles }, { keepouts: [] });
	assert.equal(result.geometry.rightAngleTurns, 0);
	assert.ok(result.ruleChecks.every((item) => item.status === 'passed'));
	assert.ok(!result.violations.some((item) => ['RIGHT_ANGLE', 'TURN_ANGLE'].includes(item.code)));
});

test('a via transition does not invent a planar right angle between layers', () => {
	const paths = [[point(10, 40), point(50, 40), point(50, 40, 1), point(50, 70, 1)]];
	const checked = inspect(paths);
	assert.equal(checked.geometry.vias, 1);
	assert.equal(checked.geometry.rightAngleTurns, 0);
	assert.deepEqual(checked.violations, []);
});

test('zero-length edges do not create directions, but ordinary calls still measure T junctions', () => {
	const checked = inspect([horizontal, branch, [point(50, 40), point(50, 40)]], {});
	assert.equal(checked.geometry.rightAngleTurns, 2);
	assert.deepEqual(checked.ruleChecks, []);
	assert.deepEqual(checked.violations, []);
});

test('nearby non-touching centerlines are not merged merely because their copper widths overlap', () => {
	const checked = inspect([horizontal, line([50, 40.01], [50, 70])]);
	assert.equal(checked.geometry.rightAngleTurns, 0);
	assert.deepEqual(checked.violations, []);
});

test('shallow crossings near a split endpoint are not counted a second time', () => {
	const paths = [
		line([17.75133445566805, 63.95196447997864], [11.099488268474907, 51.29057436221047]),
		line([16.75123638004635, 62.04809795372589], [10.715092602898252, 50.559127072146744]),
	];
	const checked = inspect(paths, { allowedTurnAnglesDeg: [90] });
	assert.equal(checked.violations.length, 4);
	assert.deepEqual(angleSummary(checked), angleSummary(inspect(subdivide(paths, [0.123, 0.617, 0.913]), { allowedTurnAnglesDeg: [90] })));
});

test('validation leaves caller-owned paths and segment metadata unchanged', () => {
	const segment = { a: point(10, 40), b: point(90, 40), net: 'A', via: false, id: 'fixed-a' };
	const other = { a: point(50, 40), b: point(50, 70), net: 'A', via: false, id: 'fixed-b' };
	const segments = [Object.freeze(segment), Object.freeze(other)];
	const original = structuredClone(segments);
	buildPlanarJunctions(segments);
	assert.deepEqual(segments, original);
});

test('fractional off-grid intersections are invariant under translation, ordering and subdivision', () => {
	for (let i = 0; i < 12; i++) {
		const x = 17.1234567 + i * 0.371,
			y = 31.7654321 + i * 0.219;
		const paths = [
			line([x - 8.3, y - 4.15], [x + 14.7, y + 7.35]),
			line([x, y], [x - 6.4, y + 12.8]),
			line([x - 2.1, y - 1.05], [x + 4.2, y + 2.1]),
		];
		const expected = angleSummary(inspect(paths));
		assert.equal(expected.rightAngleTurns, 2);
		const variant = subdivide(paths, [0.19, 0.61, 0.83])
			.toReversed()
			.map((path) => path.toReversed());
		assert.deepEqual(expected, angleSummary(inspect(variant)));
	}
});

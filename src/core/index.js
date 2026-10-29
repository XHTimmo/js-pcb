'use strict';
const engine = require('./engine/router.js');
const { dsn2pcb } = require('./engine/dsn2pcb.js');
const { normalizeDsn, parseTree } = require('./engine/dsn-normalizer.js');
const { parseDsnInfo, convertPcbToSes } = require('./engine/pcb2ses.js');
const { solvePcb, solveLegacyParameters, stats } = require('./solve.js');
const { validateOptions, RouteError } = require('./options.js');
const { prepareConstraints, WORLD_PER_MIL } = require('./constraints.js');
const { inspectResult } = require('./inspect.js');
const { validateParsedPcb, assertSesViaModel } = require('./validate.js');

const routerCommit = typeof __JSPCB_ROUTER_COMMIT__ === 'string' ? __JSPCB_ROUTER_COMMIT__ : 'unversioned';
const unsupported = ['padExit', 'cornerStyle', 'viaSilkClearanceMil', 'viaTestPointClearanceMil'];
function getCapabilities() {
	return {
		schemaVersion: 1,
		units: ['mil'],
		modes: ['dry-run'],
		importEnabled: false,
		fixedRoutes: { supported: true, segments: 'straight', layers: 'zero-based DSN copper order or DSN layer name' },
		keepouts: { supported: true, kinds: ['copper', 'via'], polygons: 'simple' },
		preserveExistingRoutes: false,
		vias: { model: 'one uniform circular through-via on two copper layers', unsupportedResults: 'rejected' },
		rules: {
			copperClearanceMil: 'enforced',
			edgeCopperGapMil: 'enforced',
			allowedTurnAnglesDeg: 'validation',
			forbidRightAngle: 'validation',
			padExit: 'unsupported',
			cornerStyle: 'unsupported',
			viaSilkClearanceMil: 'unsupported',
			viaTestPointClearanceMil: 'unsupported',
		},
		skillRequired: false,
		skillVersionIsMetadata: true,
		timeoutScope: 'whole-request',
		routerCommit,
	};
}
function createReport(config = null) {
	return {
		schemaVersion: 1,
		status: 'rejected',
		projectUuid: null,
		boardName: null,
		pcbUuid: null,
		pcbName: null,
		routerCommit,
		skillVersion: config?.rules?.skillVersion || null,
		config,
		coverage: { totalNets: 0, routedNets: 0, failedNets: [], totalPins: 0 },
		geometry: { tracks: null, vias: null, diagonalSegments: null, rightAngleTurns: null, nonOrthogonalPadExits: null },
		violations: [],
		ruleChecks: [],
		imported: false,
		execution: { mode: config?.mode || 'dry-run', phase: 'validation', imported: false, saved: false },
		routing: { status: 'not-run' },
		capabilities: getCapabilities(),
	};
}
function failure(report, error, phase = report.execution.phase) {
	report.status = 'rejected';
	report.execution.phase = phase;
	report.violations.push({
		ruleId: error.code === 'FIXED_ROUTE_CONFLICT' ? 'fixedRoutes' : 'input',
		severity: 'error',
		code: error.code || 'ROUTING_ERROR',
		message: error.message || String(error),
		objectIds: error.objectIds || [],
		...(error.net ? { net: error.net } : {}),
	});
	return report;
}
function preflight(input) {
	let config;
	try {
		config = validateOptions(input);
	} catch (error) {
		return { report: failure(createReport(), error) };
	}
	const report = createReport(config);
	if (config.mode === 'import')
		return {
			config,
			report: failure(report, new RouteError('IMPORT_DISABLED', 'This release supports dry-run only; the PCB is never modified')),
		};
	for (const key of unsupported)
		if (config.rules?.[key] !== undefined) {
			report.ruleChecks.push({
				ruleId: key,
				status: 'unsupported',
				implementation: 'unsupported',
				reason: 'This constraint has not been implemented; it was not treated as passed',
			});
			report.violations.push({
				ruleId: key,
				code: 'UNSUPPORTED_RULE',
				severity: 'error',
				message: key + ' is not supported by this router release',
			});
		}
	if (config.constraints?.preserveExistingRoutes)
		report.violations.push({
			ruleId: 'preserveExistingRoutes',
			code: 'UNSUPPORTED_CONSTRAINT',
			severity: 'error',
			message: 'Automatic collection of all existing tracks, arcs and vias is not implemented; provide explicit fixedRoutes instead',
		});
	return { config, report };
}
function routeDsn(dsn, input = {}, hooks = {}) {
	const prepared = preflight(input);
	const { config, report } = prepared;
	if (!config || report.violations.some((item) => item.severity === 'error')) return { report, ses: null, data: null };
	const deadline = hooks.deadline ?? (hooks.now || Date.now)() + config.solver.timeoutSec * 1000;
	try {
		report.execution.phase = 'parse';
		if (typeof dsn !== 'string' || dsn.length > 10000000)
			throw new RouteError('INVALID_DSN', 'DSN must be a string of at most 10 million characters');
		const tree = parseTree(dsn);
		if (!Array.isArray(tree) || !['PCB', 'pcb'].includes(tree[0])) throw new RouteError('INVALID_DSN', 'Expected a PCB DSN root');
		const resolution = tree.find((node) => Array.isArray(node) && node[0] === 'resolution');
		if (resolution?.[1] !== 'mil' || Number(resolution[2]) !== 1000)
			throw new RouteError('UNSUPPORTED_DSN_UNITS', 'The headless interface currently accepts EasyEDA DSN with resolution mil 1000');
		const info = parseDsnInfo(dsn);
		const gap = 2; // Existing engine world coordinates are 0.1 mm; API coordinates remain mil.
		const pcb = dsn2pcb(normalizeDsn(dsn), gap, 0);
		if (!pcb[0].every((n) => Number.isInteger(n) && n > 0) || !info.netNames.length)
			throw new RouteError('INVALID_DSN', 'DSN has no usable board dimensions or nets');
		validateParsedPcb(pcb);
		const structure = tree.find((node) => Array.isArray(node) && node[0] === 'structure');
		const layers = structure.filter((node) => Array.isArray(node) && node[0] === 'layer').map((node) => String(node[1]).replace(/^"|"$/g, ''));
		report.layers = layers.map((name, index) => ({ index, name }));
		const known = new Set(pcb[1].filter((track) => typeof track[5] === 'string').map((track) => track[5]));
		for (const name of [...(config.nets?.include || []), ...(config.nets?.exclude || []), ...Object.keys(config.nets?.priority || {})])
			if (!known.has(name)) throw new RouteError('UNKNOWN_NET', 'Unknown requested net: ' + name, [], name);
		for (const track of pcb[1]) {
			if (track[5] && track[3].length !== info.netPins.get(track[5])?.length)
				throw new RouteError('UNRESOLVED_PINS', 'Not all DSN pins could be resolved for ' + track[5], [], track[5]);
			if (config.rules?.copperClearanceMil !== undefined) {
				track[2] = Math.max(track[2], config.rules.copperClearanceMil * WORLD_PER_MIL);
				for (const pad of track[3]) pad[1] = Math.max(pad[1], config.rules.copperClearanceMil * WORLD_PER_MIL);
			}
			track[6] = { priority: Object.prototype.hasOwnProperty.call(config.nets?.priority || {}, track[5]) ? config.nets.priority[track[5]] : 0 };
		}
		if (config.rules?.edgeCopperGapMil !== undefined) pcb[3] = Math.max(pcb[3], config.rules.edgeCopperGapMil * WORLD_PER_MIL);
		report.execution.phase = 'constraints';
		const constraints = prepareConstraints(pcb, info, layers, config, gap);
		for (const track of pcb[1])
			if (track[0] > 0 && ((config.nets?.include && !config.nets.include.includes(track[5])) || config.nets?.exclude?.includes(track[5])))
				track[0] = 0;
		report.boardTotalNets = known.size;
		report.excludedNets = [...known].filter((name) => !pcb[1].some((track) => track[5] === name && track[0] > 0));
		if (tree.some((node) => Array.isArray(node) && node[0] === 'wiring' && node.length > 1))
			report.violations.push({
				ruleId: 'existingRoutes',
				severity: 'warning',
				code: 'EXISTING_ROUTES_NOT_PRESERVED',
				message: 'Existing DSN wiring is not automatically preserved; only supplied fixedRoutes are protected',
			});
		report.execution.phase = 'solve';
		const outcome = solvePcb(
			pcb,
			{ ...config.solver, fixedRoutes: constraints.fixedRoutes, keepouts: constraints.keepouts },
			{ ...hooks, deadline },
		);
		report.routing = { status: outcome.cancelled ? 'cancelled' : outcome.timedOut ? 'timeout' : outcome.status, cost: outcome.cost };
		report.execution.phase = 'geometry';
		const inspection = inspectResult(outcome.data, pcb, config, constraints);
		report.coverage = inspection.coverage;
		report.geometry = inspection.geometry;
		report.ruleChecks = inspection.ruleChecks;
		report.violations.push(...inspection.violations);
		assertSesViaModel(tree, pcb, info, inspection.geometry.vias);
		info.isDsnNormalized = true;
		const ses = convertPcbToSes(outcome.data, info, { gap });
		report.status = report.violations.some((item) => item.severity === 'error')
			? 'rejected'
			: inspection.coverage.failedNets.length || outcome.timedOut || outcome.cancelled
				? 'partial'
				: 'dry-run';
		if (inspection.coverage.failedNets.length && report.routing.status === 'complete') report.routing.status = 'partial';
		report.execution.phase = 'complete';
		if (config.output?.includeSes) report.artifacts = { sesText: ses };
		return { report, ses, data: outcome.data };
	} catch (error) {
		return { report: failure(report, error), ses: null, data: null };
	}
}
module.exports = {
	engine,
	dsn2pcb,
	normalizeDsn,
	parseDsnInfo,
	convertPcbToSes,
	solvePcb,
	solveLegacyParameters,
	stats,
	routeDsn,
	getCapabilities,
	createReport,
	failure,
	preflight,
};

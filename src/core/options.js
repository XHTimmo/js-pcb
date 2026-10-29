'use strict';

class RouteError extends Error {
	constructor(code, message, objectIds = [], net) {
		super(message);
		this.code = code;
		this.objectIds = objectIds;
		this.net = net;
	}
}
function object(value, name) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouteError('INVALID_OPTIONS', name + ' must be an object');
	return value;
}
function keys(value, allowed, name) {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new RouteError('UNSUPPORTED_OPTION', name + '.' + key + ' is not supported');
}
function number(value, name, min, max = Infinity, integer = false) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
		throw new RouteError('INVALID_OPTIONS', name + ' is outside its allowed range');
	return value;
}
function strings(value, name) {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
		throw new RouteError('INVALID_OPTIONS', name + ' must be an array of nonempty strings');
}
function point(value, name) {
	if (!Array.isArray(value) || value.length !== 2) throw new RouteError('INVALID_OPTIONS', name + ' must be [x, y]');
	value.forEach((n) => number(n, name, -1e7, 1e7));
}
function layer(value, name) {
	if (value === 'all') return;
	if (typeof value === 'string' && value) return;
	number(value, name, 0, 63, true);
}
const defaults = {
	timeoutSec: 30,
	viaCost: 16,
	resolution: 1,
	quantization: 2,
	samples: 1,
	distanceFunction: 1,
	spread: 2,
	xRange: 1,
	yRange: 1,
	maxNodes: 16000000,
};
function snapshot(value, seen = new Set()) {
	if (value === undefined || value === null || ['string', 'boolean'].includes(typeof value)) return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]'))
		throw new RouteError('INVALID_OPTIONS', 'Options must be finite, acyclic JSON data');
	seen.add(value);
	const copy = Array.isArray(value)
		? value.map((item) => snapshot(item, seen))
		: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, seen)]));
	seen.delete(value);
	return copy;
}
function validateOptions(input = {}) {
	object(input, 'options');
	input = snapshot(input);
	keys(input, ['mode', 'units', 'target', 'solver', 'rules', 'nets', 'constraints', 'output'], 'options');
	const config = { mode: 'dry-run', units: 'mil', ...input };
	if (!['dry-run', 'import'].includes(config.mode)) throw new RouteError('INVALID_OPTIONS', 'mode must be dry-run or import');
	if (config.units !== 'mil') throw new RouteError('INVALID_OPTIONS', 'Only mil coordinates are supported');
	if (config.target !== undefined) {
		object(config.target, 'target');
		keys(config.target, ['pcbUuid', 'boardName'], 'target');
		if (Object.keys(config.target).length !== 1 || Object.values(config.target).some((v) => typeof v !== 'string' || !v))
			throw new RouteError('INVALID_OPTIONS', 'Select either target.pcbUuid or target.boardName');
	}
	const supplied = config.solver === undefined ? {} : object(config.solver, 'solver');
	keys(supplied, [...Object.keys(defaults), 'seed'], 'solver');
	config.solver = { ...defaults, ...supplied };
	for (const [key, range] of Object.entries({
		timeoutSec: [0.001, 1800, false],
		viaCost: [0, 256, true],
		resolution: [1, 4, true],
		quantization: [0, 64, true],
		samples: [1, 32, true],
		distanceFunction: [0, 4, true],
		spread: [1, 8, true],
		xRange: [1, 8, true],
		yRange: [1, 8, true],
		maxNodes: [1, 64000000, true],
	}))
		number(config.solver[key], 'solver.' + key, ...range);
	if (config.solver.seed !== undefined) number(config.solver.seed, 'solver.seed', 0, 4294967295, true);
	if (config.rules !== undefined) {
		object(config.rules, 'rules');
		keys(
			config.rules,
			[
				'skillVersion',
				'padExit',
				'allowedTurnAnglesDeg',
				'forbidRightAngle',
				'cornerStyle',
				'copperClearanceMil',
				'viaSilkClearanceMil',
				'viaTestPointClearanceMil',
				'edgeCopperGapMil',
			],
			'rules',
		);
		if (config.rules.skillVersion !== undefined && (typeof config.rules.skillVersion !== 'string' || !config.rules.skillVersion))
			throw new RouteError('INVALID_OPTIONS', 'skillVersion must be a nonempty metadata string');
		for (const key of ['copperClearanceMil', 'viaSilkClearanceMil', 'viaTestPointClearanceMil', 'edgeCopperGapMil'])
			if (config.rules[key] !== undefined) number(config.rules[key], 'rules.' + key, 0, 10000);
		if (config.rules.forbidRightAngle !== undefined && typeof config.rules.forbidRightAngle !== 'boolean')
			throw new RouteError('INVALID_OPTIONS', 'forbidRightAngle must be boolean');
		if (config.rules.allowedTurnAnglesDeg !== undefined) {
			if (!Array.isArray(config.rules.allowedTurnAnglesDeg) || !config.rules.allowedTurnAnglesDeg.length)
				throw new RouteError('INVALID_OPTIONS', 'allowedTurnAnglesDeg must be nonempty');
			config.rules.allowedTurnAnglesDeg.forEach((value) => number(value, 'turn angle', 0, 180));
		}
		if (config.rules.cornerStyle !== undefined && !['chamfer45', 'arc'].includes(config.rules.cornerStyle))
			throw new RouteError('INVALID_OPTIONS', 'Unknown cornerStyle');
		if (config.rules.padExit !== undefined) {
			object(config.rules.padExit, 'padExit');
			keys(config.rules.padExit, ['mode', 'leadMil'], 'padExit');
			if (config.rules.padExit.mode !== 'orthogonal') throw new RouteError('INVALID_OPTIONS', 'Unknown padExit mode');
			number(config.rules.padExit.leadMil, 'leadMil', 0, 10000);
		}
	}
	if (config.nets !== undefined) {
		object(config.nets, 'nets');
		keys(config.nets, ['include', 'exclude', 'priority'], 'nets');
		for (const key of ['include', 'exclude']) if (config.nets[key] !== undefined) strings(config.nets[key], 'nets.' + key);
		if (config.nets.priority !== undefined)
			for (const value of Object.values(object(config.nets.priority, 'priority'))) number(value, 'priority', -1e6, 1e6);
	}
	if (config.constraints !== undefined) {
		const constraints = object(config.constraints, 'constraints');
		keys(constraints, ['fixedRoutes', 'keepouts', 'preserveExistingRoutes'], 'constraints');
		if (constraints.preserveExistingRoutes !== undefined && typeof constraints.preserveExistingRoutes !== 'boolean')
			throw new RouteError('INVALID_OPTIONS', 'preserveExistingRoutes must be boolean');
		for (const key of ['fixedRoutes', 'keepouts'])
			if (constraints[key] !== undefined && (!Array.isArray(constraints[key]) || constraints[key].length > 1000))
				throw new RouteError('INVALID_OPTIONS', key + ' must be an array of at most 1000 objects');
		const ids = new Set();
		let segments = 0;
		for (const [index, fixed] of (constraints.fixedRoutes || []).entries()) {
			object(fixed, 'fixedRoutes');
			keys(fixed, ['id', 'net', 'layer', 'segments', 'protected'], 'fixedRoutes');
			fixed.id ??= 'fixed-route-' + index;
			if (typeof fixed.id !== 'string' || !fixed.id || ids.has(fixed.id))
				throw new RouteError('INVALID_OPTIONS', 'Fixed-route ids must be unique');
			ids.add(fixed.id);
			if (typeof fixed.net !== 'string' || !fixed.net || fixed.protected !== true || fixed.layer === 'all')
				throw new RouteError('INVALID_OPTIONS', 'Fixed routes need a net, one layer and protected: true');
			layer(fixed.layer, 'fixed route layer');
			if (!Array.isArray(fixed.segments) || !fixed.segments.length) throw new RouteError('INVALID_OPTIONS', 'Fixed routes need segments');
			for (const segment of fixed.segments) {
				object(segment, 'segment');
				keys(segment, ['start', 'end', 'width'], 'segment');
				point(segment.start, 'segment.start');
				point(segment.end, 'segment.end');
				number(segment.width, 'segment.width', 0.001, 10000);
				if (segment.start[0] === segment.end[0] && segment.start[1] === segment.end[1])
					throw new RouteError('INVALID_OPTIONS', 'Fixed segments must have positive length');
			}
			segments += fixed.segments.length;
		}
		if (segments > 2000) throw new RouteError('RESOURCE_LIMIT', 'At most 2000 fixed segments are supported');
		for (const [index, region] of (constraints.keepouts || []).entries()) {
			object(region, 'keepout');
			keys(region, ['id', 'layer', 'polygon', 'clearanceMil', 'kind'], 'keepout');
			region.id ??= 'keepout-' + index;
			if (typeof region.id !== 'string' || !region.id || ids.has(region.id))
				throw new RouteError('INVALID_OPTIONS', 'Constraint ids must be unique');
			ids.add(region.id);
			layer(region.layer, 'keepout.layer');
			if (!Array.isArray(region.polygon) || region.polygon.length < 3 || region.polygon.length > 128)
				throw new RouteError('INVALID_OPTIONS', 'Keepouts need 3–128 polygon vertices');
			region.polygon.forEach((p) => point(p, 'keepout.polygon'));
			if (region.clearanceMil !== undefined) number(region.clearanceMil, 'keepout.clearanceMil', 0, 10000);
			if (region.kind !== undefined && !['copper', 'via'].includes(region.kind))
				throw new RouteError('INVALID_OPTIONS', 'Unknown keepout kind');
		}
	}
	if (config.output !== undefined) {
		object(config.output, 'output');
		keys(config.output, ['saveSesPath', 'saveReportPath', 'includeSes'], 'output');
		for (const key of ['saveSesPath', 'saveReportPath'])
			if (config.output[key] !== undefined && (typeof config.output[key] !== 'string' || !config.output[key]))
				throw new RouteError('INVALID_OPTIONS', key + ' must be nonempty');
		if (config.output.includeSes !== undefined && typeof config.output.includeSes !== 'boolean')
			throw new RouteError('INVALID_OPTIONS', 'includeSes must be boolean');
		if (config.output.saveSesPath && config.output.saveSesPath === config.output.saveReportPath)
			throw new RouteError('INVALID_OPTIONS', 'SES and report output paths must differ');
	}
	return JSON.parse(JSON.stringify(config));
}
module.exports = { RouteError, validateOptions, defaults };

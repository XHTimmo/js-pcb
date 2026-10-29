import type { getCapabilities } from './index.js';

export type Point = [number, number];
/** Zero-based DSN copper-layer order, or an exact DSN layer name. */
export type LayerRef = number | string;
export interface FixedRoute {
	id?: string;
	net: string;
	layer: LayerRef;
	segments: Array<{ start: Point; end: Point; width: number }>;
	protected: true;
}
export interface Keepout {
	id?: string;
	layer: LayerRef | 'all';
	polygon: Point[];
	clearanceMil?: number;
	kind?: 'copper' | 'via';
}
export interface SolverOptions {
	/** Total deadline for the headless request; the visible UI keeps its per-sample timeout. */
	timeoutSec: number;
	viaCost: number;
	resolution: number;
	quantization: number;
	samples: number;
	distanceFunction: 0 | 1 | 2 | 3 | 4;
	seed?: number;
	spread?: number;
	xRange?: number;
	yRange?: number;
	maxNodes?: number;
}
/** Caller-supplied constraints. No Skill installation or version is required. */
export interface RouteRules {
	/** Audit metadata only; it does not imply conformance to a complete Skill specification. */
	skillVersion?: string;
	padExit?: { mode: 'orthogonal'; leadMil: number };
	/** Validates distinct planar centerline directions at same-net, same-layer contacts, including T/cross junctions. */
	allowedTurnAnglesDeg?: number[];
	forbidRightAngle?: boolean;
	cornerStyle?: 'chamfer45' | 'arc';
	copperClearanceMil?: number;
	viaSilkClearanceMil?: number;
	viaTestPointClearanceMil?: number;
	edgeCopperGapMil?: number;
}
export interface RouteOptions {
	mode?: 'dry-run' | 'import';
	units?: 'mil';
	target?: { pcbUuid: string } | { boardName: string };
	solver?: Partial<SolverOptions>;
	rules?: RouteRules;
	nets?: { include?: string[]; exclude?: string[]; priority?: Record<string, number> };
	constraints?: { fixedRoutes?: FixedRoute[]; keepouts?: Keepout[]; preserveExistingRoutes?: boolean };
	output?: { saveSesPath?: string; saveReportPath?: string; includeSes?: boolean };
}
export interface EffectiveOptions extends RouteOptions {
	mode: 'dry-run' | 'import';
	units: 'mil';
	solver: SolverOptions;
}
export interface Violation {
	ruleId: string;
	code: string;
	severity: 'error' | 'warning';
	message: string;
	net?: string;
	objectIds?: string[];
	measured?: number;
	required?: number;
	unit?: 'mil' | 'deg';
}
export interface RuleCheck {
	ruleId: string;
	status: 'passed' | 'failed' | 'unsupported' | 'not-checked';
	implementation: 'enforced' | 'validation' | 'unsupported';
	reason?: string;
}
export interface RouteReport {
	schemaVersion: 1;
	status: 'dry-run' | 'imported' | 'rejected' | 'partial';
	projectUuid: string | null;
	boardName: string | null;
	pcbUuid: string | null;
	pcbName: string | null;
	routerCommit: string;
	skillVersion: string | null;
	config: EffectiveOptions | null;
	coverage: { totalNets: number; routedNets: number; failedNets: string[]; totalPins: number };
	geometry: {
		tracks: number | null;
		vias: number | null;
		diagonalSegments: number | null;
		/** Deduplicated 90-degree direction pairs; an orthogonal T counts as 2 and a cross as 4. */
		rightAngleTurns: number | null;
		nonOrthogonalPadExits: number | null;
	};
	violations: Violation[];
	ruleChecks: RuleCheck[];
	imported: boolean;
	execution: { mode: string; phase: string; imported: boolean; saved: boolean };
	routing: { status: string; cost?: number };
	layers?: Array<{ index: number; name: string }>;
	boardTotalNets?: number;
	excludedNets?: string[];
	artifacts?: { sesText?: string; sesPath?: string; reportPath?: string };
	capabilities: ReturnType<typeof getCapabilities>;
}
export interface CoreResult {
	report: RouteReport;
	ses: string | null;
	data: unknown;
}
export type HeadlessRouteOptions = RouteOptions;
export type HeadlessRouteReport = RouteReport;
export interface RouteHooks {
	now?: () => number;
	random?: () => number;
	isCancelled?: () => boolean;
	deadline?: number;
	onEvent?: (event: unknown) => void;
}

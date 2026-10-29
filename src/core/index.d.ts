import type { CoreResult, EffectiveOptions, RouteHooks, RouteOptions, RouteReport } from './types';

export * from './types';
export function routeDsn(dsn: string, options?: RouteOptions, hooks?: RouteHooks): CoreResult;
export function getCapabilities(): {
	schemaVersion: number;
	units: string[];
	modes: string[];
	importEnabled: boolean;
	fixedRoutes: { supported: boolean; segments: string; layers: string };
	keepouts: { supported: boolean; kinds: string[]; polygons: string };
	preserveExistingRoutes: boolean;
	vias: { model: string; unsupportedResults: string };
	rules: Record<string, string>;
	skillRequired: boolean;
	skillVersionIsMetadata: boolean;
	timeoutScope: string;
	routerCommit: string;
};
export function createReport(options?: EffectiveOptions | null): RouteReport;
export function failure(
	report: RouteReport,
	error: { code?: string; message?: string; objectIds?: string[]; net?: string },
	phase?: string,
): RouteReport;
export function preflight(options: unknown): { config?: EffectiveOptions; report: RouteReport };
export declare const engine: Record<string, unknown>;
export function solvePcb(input: unknown, options?: Record<string, unknown>, hooks?: RouteHooks): unknown;
export function solveLegacyParameters(input: unknown[], hooks?: RouteHooks): unknown;
export function stats(data: unknown): { total: number; unrouted: number; routed: number };
export function normalizeDsn(source: string): string;
export function dsn2pcb(source: string, gap: number, extraGap?: number): unknown;
export function parseDsnInfo(source: string): Record<string, unknown>;
export function convertPcbToSes(data: unknown, info: unknown, options?: unknown): string;

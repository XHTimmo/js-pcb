import { createReport, failure, preflight, routeDsn } from '../core/index.js';
import type { EffectiveOptions, RouteReport } from '../core/types';

interface PcbInfo {
	uuid: string;
	name: string;
	parentProjectUuid: string;
	parentBoardName?: string;
}
export interface HeadlessHost {
	dmt_Project: { getCurrentProjectInfo: () => Promise<{ uuid: string } | undefined> };
	dmt_SelectControl: { getCurrentDocumentInfo: () => Promise<{ uuid: string; documentType: number } | undefined> };
	dmt_Pcb: { getCurrentPcbInfo: () => Promise<PcbInfo | undefined>; getPcbInfo: (uuid: string) => Promise<PcbInfo | undefined> };
	dmt_Board: { getBoardInfo: (name: string) => Promise<{ name: string; parentProjectUuid: string; pcb?: PcbInfo } | undefined> };
	dmt_EditorControl: { openDocument: (uuid: string) => Promise<string | undefined>; activateDocument: (tabId: string) => Promise<boolean> };
	pcb_ManufactureData: { getDsnFile: (name?: string) => Promise<{ text: () => Promise<string> } | undefined> };
	sys_FileSystem?: { saveFileToFileSystem: (path: string, data: Blob) => Promise<boolean> };
}

function problem(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
function detail(error: unknown): { code: string; message: string } {
	return {
		code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'EDA_ERROR',
		message: error instanceof Error ? error.message : String(error),
	};
}

async function activateRequestedTarget(host: HeadlessHost, requested: EffectiveOptions['target'], projectUuid: string): Promise<void> {
	if (!requested) return;
	let target: PcbInfo | undefined;
	if ('pcbUuid' in requested) target = await host.dmt_Pcb.getPcbInfo(requested.pcbUuid);
	else {
		const board = await host.dmt_Board.getBoardInfo(requested.boardName);
		if (board?.parentProjectUuid === projectUuid) target = board.pcb;
	}
	if (!target || target.parentProjectUuid !== projectUuid) throw problem('TARGET_NOT_FOUND', 'Target PCB is not in the current project');
	const tab = await host.dmt_EditorControl.openDocument(target.uuid);
	if (!tab || !(await host.dmt_EditorControl.activateDocument(tab))) throw problem('TARGET_ACTIVATION_FAILED', 'Could not activate the target PCB');
}

async function getVerifiedPcb(host: HeadlessHost, requested: EffectiveOptions['target'], projectUuid: string): Promise<PcbInfo> {
	const doc = await host.dmt_SelectControl.getCurrentDocumentInfo();
	if (doc?.documentType !== EDMT_EditorDocumentType.PCB) throw problem('NOT_PCB', 'The active document is not a PCB');
	const pcb = await host.dmt_Pcb.getCurrentPcbInfo();
	if (!pcb || pcb.uuid !== doc.uuid || pcb.parentProjectUuid !== projectUuid)
		throw problem('DOCUMENT_CHANGED', 'Current PCB does not match the document and project');
	if (
		requested &&
		(('pcbUuid' in requested && pcb.uuid !== requested.pcbUuid) || ('boardName' in requested && pcb.parentBoardName !== requested.boardName))
	)
		throw problem('DOCUMENT_CHANGED', 'The target PCB did not become active');
	return pcb;
}

/** Read-only PCB adapter. It never opens an IFrame, imports a SES or saves the PCB. */
export function createHeadlessService(host: HeadlessHost): (options?: unknown) => Promise<RouteReport> {
	let busy = false;
	return async function routeCurrentPcb(input: unknown = {}): Promise<RouteReport> {
		const prepared = preflight(input);
		const config = prepared.config;
		let report = prepared.report;
		if (!config || report.violations.some((item) => item.severity === 'error')) return report;
		if (busy) return failure(report, problem('ROUTER_BUSY', 'Another headless request is using this editor context'));
		if ((config.output?.saveSesPath || config.output?.saveReportPath) && !host.sys_FileSystem?.saveFileToFileSystem)
			return failure(report, problem('FILE_API_UNAVAILABLE', 'Noninteractive file output is unavailable'));
		busy = true;
		const deadline = Date.now() + config.solver.timeoutSec * 1000;
		try {
			report.execution.phase = 'project';
			const project = await host.dmt_Project.getCurrentProjectInfo();
			if (!project) throw problem('NO_PROJECT', 'No project is open');
			report.projectUuid = project.uuid;
			await activateRequestedTarget(host, config.target, project.uuid);
			report.execution.phase = 'document';
			const pcb = await getVerifiedPcb(host, config.target, project.uuid);
			const identity = { projectUuid: project.uuid, pcbUuid: pcb.uuid, pcbName: pcb.name, boardName: pcb.parentBoardName || null };
			Object.assign(report, identity);
			report.execution.phase = 'dsn';
			const file = await host.pcb_ManufactureData.getDsnFile('JS-PCB-Headless-DSN');
			if (!file) throw problem('DSN_EXPORT_FAILED', 'DSN export failed');
			const text = await file.text();
			const current = await host.dmt_SelectControl.getCurrentDocumentInfo();
			if (current?.uuid !== pcb.uuid || current.documentType !== EDMT_EditorDocumentType.PCB)
				throw problem('DOCUMENT_CHANGED', 'Active document changed during DSN export');
			if (Date.now() >= deadline) throw problem('REQUEST_TIMEOUT', 'The request deadline expired during DSN export');
			const result = routeDsn(text, config, { deadline });
			report = Object.assign(result.report, identity);
			await writeOutputs(host, config, report, result.ses);
			return report;
		} catch (error) {
			const parsed = detail(error);
			return failure(report, parsed, parsed.code === 'OUTPUT_WRITE_FAILED' ? 'output' : report.execution.phase);
		} finally {
			busy = false;
		}
	};
}

async function writeOutputs(host: HeadlessHost, config: EffectiveOptions, report: RouteReport, ses: string | null): Promise<void> {
	const saveFile = host.sys_FileSystem?.saveFileToFileSystem.bind(host.sys_FileSystem);
	if (!saveFile) return;
	const write = async (uri: string, data: Blob): Promise<void> => {
		try {
			if (!(await saveFile(uri, data))) throw new Error('File API returned false');
		} catch (error) {
			throw problem('OUTPUT_WRITE_FAILED', 'Could not save ' + uri + ': ' + detail(error).message);
		}
	};
	if (config.output?.saveSesPath && ses && report.status !== 'rejected') {
		await write(config.output.saveSesPath, new Blob([ses], { type: 'text/plain' }));
		report.artifacts = { ...report.artifacts, sesPath: config.output.saveSesPath };
	}
	if (config.output?.saveReportPath) {
		const artifacts = { ...report.artifacts, reportPath: config.output.saveReportPath };
		await write(config.output.saveReportPath, new Blob([JSON.stringify({ ...report, artifacts }, null, 2)], { type: 'application/json' }));
		report.artifacts = artifacts;
	}
}

export function unavailableReport(message: string): RouteReport {
	return failure(createReport(), problem('HOST_UNAVAILABLE', message));
}

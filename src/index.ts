/**
 * 入口文件
 *
 * 本文件为默认扩展入口文件，如果你想要配置其它文件作为入口文件，
 * 请修改 `extension.json` 中的 `entry` 字段；
 *
 * 请在此处使用 `export`  导出所有你希望在 `headerMenus` 中引用的方法，
 * 方法通过方法名与 `headerMenus` 关联。
 *
 * 如需了解更多开发细节，请阅读：
 * https://prodocs.lceda.cn/cn/api/guide/
 */
import * as extensionConfig from '../extension.json';
import { getCapabilities } from './core/index.js';
import type { RouteReport } from './core/types';
import { createHeadlessService, unavailableReport } from './headless/service';
import type { HeadlessHost } from './headless/service';

export type { HeadlessRouteOptions, HeadlessRouteReport } from './core/types';

interface ExternalApiRegistry {
	register: (
		namespace: string,
		name: string,
		callback: (...args: unknown[]) => unknown | Promise<unknown>,
		help?: {
			title?: string;
			description?: string;
			params?: Array<{ name: string; type?: string; description?: string; required?: boolean }>;
			returns?: { type?: string; description?: string };
		},
	) => void;
}
let headlessService: ReturnType<typeof createHeadlessService> | undefined;
let externalRegistered = false;

export async function routeCurrentPcb(options: unknown = {}): Promise<RouteReport> {
	if (typeof eda === 'undefined') return unavailableReport('EasyEDA API is unavailable');
	headlessService ??= createHeadlessService(eda as unknown as HeadlessHost);
	return headlessService(options);
}

export function getRoutingCapabilities(): ReturnType<typeof getCapabilities> {
	return getCapabilities();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	if (externalRegistered) return;
	// The locked legacy SDK does not declare this newer API; capability detection
	// keeps ordinary UI routing usable on clients without external registration.
	try {
		const registry = (eda as unknown as { sys_ExternalApi?: ExternalApiRegistry }).sys_ExternalApi;
		if (!registry?.register) return;
		registry.register('jspcb', 'getCapabilities', getRoutingCapabilities, {
			title: 'JS-PCB capabilities',
			returns: { type: 'RoutingCapabilities' },
		});
		registry.register('jspcb', 'routeCurrentPcb', routeCurrentPcb, {
			title: 'JS-PCB 无头布线',
			description: '读取 PCB，执行无界面的 dry-run 布线并返回约束检查报告；不依赖 Skill。',
			params: [
				{ name: 'options', type: 'HeadlessRouteOptions', description: '可选求解参数、网络选择和显式约束；rules 可省略', required: false },
			],
			returns: { type: 'Promise<HeadlessRouteReport>', description: '布线、几何检查及未实现约束的报告；此版本禁用无头导入' },
		});
		externalRegistered = true;
	} catch (error) {
		console.warn('[jspcb] external API registration unavailable', error);
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('EasyEDA extension SDK v', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

export async function startAutoRouteIFrame(): Promise<void> {
	console.log('[autorouter][iframe] open');
	const props = {
		maximizeButton: true,
		minimizeButton: true,
		title: eda.sys_I18n.text('ui.dialogTitle'),
	};
	await eda.sys_IFrame.openIFrame('/iframe/jspcb/index.html', 1100, 700, 'jspcb-autorouter', props);
}

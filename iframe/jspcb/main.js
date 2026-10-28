/**
 * Presentation adapted from PR #1 by summving (@easyeda2021).
 * https://github.com/XHTimmo/js-pcb/pull/1 — see NOTICE.md.
 */
//filename and worker
let file = null;
let originalFile = null;  // 保存归一化前的原始 DSN 内容
let fileName = 'output';  // 文件名
let worker = null;
let lastPcbData = null;   // 保存最后的布线结果
let currentBoundary = null;  // 板框（与布线结果同一坐标系），用于预览
let isDsnNormalized = false;  // 是否已做 DSN 归一化
let routingTimer = null;
let routingStartTime = 0;
let isRouting = false;
let routingGeneration = 0;

function t(key, ...args)
{
	if (window.jspcbI18n && window.jspcbI18n.t) return window.jspcbI18n.t(key, ...args);
	return key;
let originalFile = null; // 保存原始文件内容（转换前）
let fileName = 'output'; // 文件名
let worker = null;
let lastPcbData = null; // 保存最后的布线结果
let isJlcConverted = false; // 是否经过 JLC 转换
let shouldSaveHistory = false;
let routingTimer = null;
let routingStartTime = 0;
const HISTORY_KEY = 'js_pcb_history_v1';
const HISTORY_LIMIT = 10;
let historyRecords = [];
let logRecords = [];

function t(key, ...args) {
	return jspcbI18n.t(key, ...args);
}

function startTimer() {
	stopTimer();
	const display = document.getElementById('timer-display');
	display.style.display = 'inline-block';
	display.innerText = '00:00';
	routingStartTime = Date.now();

	routingTimer = setInterval(() => {
		const elapsed = Date.now() - routingStartTime;
		const seconds = Math.floor(elapsed / 1000);
		const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
		const ss = String(seconds % 60).padStart(2, '0');
		display.innerText = `${mm}:${ss}`;
	}, 1000);
}

function stopTimer() {
	if (routingTimer) {
		clearInterval(routingTimer);
		routingTimer = null;
	}
}

//go button handler
let workerBlobUrl = null;

async function loadTextFile(relativePath) {
	if (typeof eda !== 'undefined' && eda?.sys_FileSystem?.getExtensionFile) {
		const f = await eda.sys_FileSystem.getExtensionFile('/iframe/jspcb/' + relativePath);
		if (f) return await f.text();
	}
	const r = await fetch('/iframe/jspcb/' + relativePath);
	return await r.text();
}

async function createRoutingWorker() {
	try {
		return new Worker('/iframe/jspcb/worker.js');
	} catch (e) {}

	const mymath = await loadTextFile('mymath.js');
	const layer = await loadTextFile('layer.js');
	const router = await loadTextFile('router.js');
	const workerSource = await loadTextFile('worker.js');
	const cleanedWorker = workerSource.replace(/^\s*importScripts\([^\)]*\);\s*/m, '');
	const combined = `${mymath}\n${layer}\n${router}\n${cleanedWorker}\n`;
	workerBlobUrl = URL.createObjectURL(new Blob([combined], { type: 'application/javascript' }));
	return new Worker(workerBlobUrl);
}

function setRoutingState(running)
{
	isRouting = running;
	const btn = document.getElementById('go');
	if (!btn) return;
	btn.innerText = running ? t('ui.stop') : t('ui.start');
	btn.classList.toggle('stop-mode', running);
}

function stopRouting()
{
	routingGeneration++;
	if (worker !== null)
	{
		try { worker.terminate(); } catch (e) {}
		worker = null;
	}
	setRoutingState(false);
	stopTimer();
	appendLog(t('log.stopped'));
}

function setProgress(done, total, completed)
{
	const fill = document.getElementById('progress-fill');
	const text = document.getElementById('progress-text');
	const pct = completed ? 100 : (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);
	if (fill) fill.style.width = pct + '%';
	if (text) {
		text.innerText = completed
			? t('ui.progressDone', done, total)
			: t('ui.progress', done, total, pct);
	}
}

// 部分布通/超时结果：由用户决定是否导入
function askImportPartial(routed, total)
{
	return new Promise(function(resolve) {
		const modal = document.getElementById('confirm_modal');
		const text = document.getElementById('confirm_text');
		if (!modal || !text) { resolve(false); return; }
		text.innerText = t('toast.partialConfirm', routed, total);
		modal.style.display = 'flex';

		const yes = document.getElementById('confirm_yes');
		const no = document.getElementById('confirm_no');
		function cleanup(value) {
			modal.style.display = 'none';
			yes.onclick = null;
			no.onclick = null;
			modal.onclick = null;
			document.removeEventListener('keydown', onKey);
			resolve(value);
		}
		function onKey(e) {
			if (e.key === 'Escape') cleanup(false);
		}
		yes.onclick = function() { cleanup(true); };
		no.onclick = function() { cleanup(false); };
		modal.onclick = function(e) { if (e.target === modal) cleanup(false); };
		document.addEventListener('keydown', onKey);
	});
}

async function handleOnGo(evt)
{
	if (isRouting) { stopRouting(); return; }

	const generation = ++routingGeneration;

	if (file !== null)
	{
		//params
		let arg_g = +document.getElementById('arg_g').value;
		let arg_c = +document.getElementById('arg_c').value;
		let arg_t = +document.getElementById('arg_t').value;
		let arg_v = +document.getElementById('arg_v').value;
		let arg_s = +document.getElementById('arg_s').value;
		let arg_z = +document.getElementById('arg_z').value;
		let arg_r = +document.getElementById('arg_r').value;
		let arg_q = +document.getElementById('arg_q').value;
		let arg_d = +document.getElementById('arg_d').value;
		let arg_fr = +document.getElementById('arg_fr').value;
		let arg_xr = +document.getElementById('arg_xr').value;
		let arg_yr = +document.getElementById('arg_yr').value;

		// Reset log UI
		document.getElementById('log-content').innerHTML = ''; // Clear logs
		appendLog(t('log.init'));
		setRoutingState(true);
		setProgress(0, 0);
		logRecords = [];
		document.getElementById('log-content').innerHTML = '';
		appendLog('log.init');
		document.getElementById('go').disabled = true;
		shouldSaveHistory = false;
		startTimer();

		//run pcb solver web worker thread, register output listner
		if (worker !== null) worker.terminate();
		if (workerBlobUrl) {
			try {
				URL.revokeObjectURL(workerBlobUrl);
			} catch {}
			workerBlobUrl = null;
		}
		try {
			const newWorker = await createRoutingWorker();
			// 创建期间用户可能已停止/重新开始；过期 Worker 直接丢弃，避免覆盖新任务
			if (generation !== routingGeneration || !isRouting) {
				try { newWorker.terminate(); } catch (e) {}
				return;
			}
			worker = newWorker;
		} catch (e) {
			const msg = e && e.message ? e.message : String(e);
			appendLog(t('log.workerCreateFail', msg));
			setRoutingState(false);
			stopTimer();
			return;
		}
		worker.addEventListener('message', function(event)
		{
			if (generation !== routingGeneration) return;
			// 进度条更新
			if (event.data.type === 'progress') {
				setProgress(event.data.done || 0, event.data.total || 0);
				return;
			}

			// Handle log messages (structured keys from worker/router)
			if (event.data.type === 'log') {
				const key = event.data.key;
				const text = key ? t(key, ...(event.data.args || [])) : event.data.message;
				appendLog(text);
				if (key === 'log.allDone') {
					setRoutingState(false);
					stopTimer();
				}
				return;
			}

			// Worker 内部异常：恢复界面，避免一直卡在“开始布线”状态
			if (event.data.type === 'error') {
				appendLog(t('log.routeError', event.data.message));
				setRoutingState(false);
				stopTimer();
				return;
			}

			// 一次采样结束（完整布通 / 部分布通 / 超时）
			if (event.data.type === 'done') {
				lastPcbData = event.data.data;
				js_pcb.view_pcb(lastPcbData, 0, 2, currentBoundary);
				setRoutingState(false);
				stopTimer();
				const total = event.data.total || 0;
				const unrouted = event.data.unrouted || 0;
				const routed = Math.max(0, total - unrouted);
				const status = event.data.status || (unrouted > 0 ? 'partial' : 'complete');

				// 进程已结束，进度条置满；文字显示实际布通数量
				setProgress(routed, total, true);

				if (status === 'complete' || unrouted === 0) {
					showToast(t('toast.done', routed, total), 'success', 4);
					importResultToPcb(lastPcbData, false);
				} else {
					const toastKey = status === 'timeout' ? 'toast.timeoutDone' : 'toast.partialDone';
					showToast(t(toastKey, routed, total), 'warn', 4);
					askImportPartial(routed, total).then(function(ok) {
						if (ok) importResultToPcb(lastPcbData, true);
						else appendLog(t('log.partialSkip'));
					});
				}
				return;
			}

			// Handle legacy array data (result)
			let pcbData = event.data;
			if (event.data.type === 'result') {
				pcbData = event.data.data;
			}

			if (pcbData && pcbData.length)
			{
				// 布线过程中的动态预览快照
				lastPcbData = pcbData;
				js_pcb.view_pcb(pcbData, 0, 2, currentBoundary);
			}
		}, false);

		// 捕获 worker 加载/运行失败（例如跨域或脚本异常）
		worker.addEventListener('error', function(event)
		{
			if (generation !== routingGeneration) return;
			appendLog(t('log.workerRuntime', event.message || ''));
			setRoutingState(false);
			stopTimer();
		}, false);

		//post to solver thread
		try {
			const pcbData = js_pcb.dsn2pcb(file, arg_g, arg_c);
			currentBoundary = Array.isArray(pcbData[2]) ? pcbData[2] : null;
			const totalNets = pcbData[1].filter(function(t) { return t[0] > 0; }).length;
			setProgress(0, totalNets);
			worker.postMessage([pcbData,
						arg_t, arg_v, arg_s, arg_z, arg_r, arg_q, arg_d, arg_fr, arg_xr, arg_yr]);
		} catch (e) {
			// DSN 解析失败时也必须恢复界面，否则按钮会一直处于禁用状态
			appendLog(t('log.dsnParseFail', e && e.message ? e.message : String(e)));
			setRoutingState(false);
			stopTimer();
		}
	}
}

function renderLogRecord(record) {
	const container = document.getElementById('log-content');
	const entry = document.createElement('div');
	entry.className = 'log-entry';

	const now = new Date();
	const ts = String(now.getHours()).padStart(2, '0') + ':' +
		String(now.getMinutes()).padStart(2, '0') + ':' +
		String(now.getSeconds()).padStart(2, '0');
	entry.innerText = '[' + ts + '] ' + message;
	logContainer.appendChild(entry);

	// Auto scroll to bottom
	logContainer.scrollTop = logContainer.scrollHeight;

}

//布线完成后自动导入 SES
async function importResultToPcb(pcbData, partial)
{
	if (!pcbData || !originalFile) return;

	try {
		const hasTracks = Array.isArray(pcbData[1]) && pcbData[1].some(function(t) {
			return t[4] && t[4].length;
		});
		if (!hasTracks) {
			appendLog(t('log.noTracks'));
			return;
		}

		const dsnInfo = parseDsnInfo(originalFile);
		dsnInfo.fileName = fileName;
		dsnInfo.isDsnNormalized = isDsnNormalized;

		const gap = +document.getElementById('arg_g').value;
		const sesContent = convertPcbToSes(pcbData, dsnInfo, { gap: gap });

		// EDA 环境：自动导入当前 PCB
		if (typeof eda !== 'undefined' && eda?.pcb_Document?.importAutoRouteSesFile) {
			const sesFile = new File([sesContent], fileName + '.ses', { type: 'text/plain' });
			try {
				await eda.pcb_Document.importAutoRouteSesFile(sesFile);
				appendLog(t(partial ? 'log.partialImport' : 'log.imported'));
			} catch (e) {
				console.error('[jspcb][eda] import failed', e);
				appendLog(t('log.importFail', e && e.message ? e.message : e));
				try {
					if (eda?.sys_FileSystem?.saveFile) {
						await eda.sys_FileSystem.saveFile(sesFile, sesFile.name);
						appendLog(t('log.savedFile', sesFile.name));
						showToast(t('toast.importSaved'), 'warn', 6);
					} else {
						showToast(t('toast.importFail'), 'error', 6);
					}
				} catch (e2) {
					console.error('[jspcb][eda] save fallback failed', e2);
					showToast(t('toast.importFailSave'), 'error', 8);
				}
			}
			return;
		}

		// 非 EDA 环境：下载 SES
		const blob = new Blob([sesContent], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName + '.ses';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		appendLog(t('log.exported'));
	} catch (err) {
		console.error('[jspcb] auto import failed', err);
		appendLog(t('log.sesFail', err && err.message ? err.message : err));
	}
}

//file onload handler
function handleOnLoad(evt, silent)
{
	//the onload get a string of the dsn file
	let content = evt.target.result;
	originalFile = content;  // 保存原始内容
	isDsnNormalized = false;
	
	// 检查是否需要把嘉立创 DSN 归一化为 JS-PCB 的标准坐标系
	if (document.getElementById('dsn_normalize').checked) {
		try {
			content = normalizeDsn(content);
			isDsnNormalized = true;
			console.log('DSN 已归一化');
		} catch (err) {
			console.error('DSN 归一化失败:', err);
			// 转换失败时不要继续使用未转换的数据，否则坐标系不一致，
			// 布线器会把整块板当成只有几毫米大小。
			file = null;
			lastPcbData = null;
			currentBoundary = null;
			if (!silent) showToast(t('log.normFail', err.message), 'error', 6);
			return false;
		}
	}

	file = content;
	lastPcbData = null;
	currentBoundary = null;
	if (!silent) showToast(t('toast.dsnLoaded', fileName), 'success', 2);

	// 打开窗口后立即绘制板框和焊盘，不必等到开始布线
	renderBoardPreview();
	return true;
}

// 解析 DSN 并绘制静态预览（板框 + 焊盘，无走线）
function renderBoardPreview()
{
	if (file === null) return;
	try {
		const gap = +document.getElementById('arg_g').value;
		const clearance = +document.getElementById('arg_c').value;
		const pcbData = js_pcb.dsn2pcb(file, gap, clearance);
		currentBoundary = Array.isArray(pcbData[2]) ? pcbData[2] : null;
		lastPcbData = pcbData;
		js_pcb.view_pcb(pcbData, 0, 2, currentBoundary);
		const totalNets = pcbData[1].filter(function(t) { return t[0] > 0; }).length;
		setProgress(0, totalNets);
	} catch (e) {
		console.error('[jspcb] preview failed', e);
	}
}

//file selection handler
function handleFileSelect(evt) {
	//filelist
	let files = evt.target.files;
	let f = files[0];

	//dsn files only.
	if (f.name.match('.*[.]dsn')) {
		// 保存文件名
		fileName = f.name.replace('.dsn', '');

		//file reader
		let reader = new FileReader();

		//onload handler
		reader.onload = handleOnLoad;

		//read the dsn file
		reader.readAsText(f);
	}
}

// Resize handler to re-render SVG on window resize
window.addEventListener('resize', function () {
	if (lastPcbData) {
		// Re-render with auto-scaling
		js_pcb.view_pcb(lastPcbData, 0, 2, currentBoundary);
	}
});

// 数字输入框：隐藏原生上下箭头，改成输入框内部的上下步进按钮
function enhanceNumberInputs()
{
	document.querySelectorAll('.param-row input[type="number"]').forEach(function(input) {
		if (input.parentElement && input.parentElement.classList.contains('num-field')) return;

		const field = document.createElement('div');
		field.className = 'num-field';
		input.parentNode.insertBefore(field, input);
		field.appendChild(input);

		const stepper = document.createElement('div');
		stepper.className = 'num-stepper';
		stepper.innerHTML =
			'<button type="button" class="step-btn step-up" tabindex="-1" aria-label="' + t('ui.increase') + '"></button>' +
			'<button type="button" class="step-btn step-down" tabindex="-1" aria-label="' + t('ui.decrease') + '"></button>';
		field.appendChild(stepper);

		function step(dir) {
			const min = input.min === '' ? -Infinity : +input.min;
			const max = input.max === '' ? Infinity : +input.max;
			const stepSize = input.step === '' ? 1 : +input.step;
			let value = input.value === '' ? (isFinite(min) ? min : 0) : +input.value;
			value = Math.min(max, Math.max(min, value + dir * stepSize));
			input.value = String(value);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		}

		stepper.querySelector('.step-up').addEventListener('click', function() { step(1); });
		stepper.querySelector('.step-down').addEventListener('click', function() { step(-1); });
	});
}

enhanceNumberInputs();

//register action handlers
document.getElementById('files').addEventListener('change', handleFileSelect, false);
document.getElementById('go').onclick = handleOnGo;
// 修改边框间隙后同步刷新静态预览
document.getElementById('arg_g').addEventListener('change', renderBoardPreview, false);
// ===== 从 EDA 自动获取并载入 DSN =====
let autoLoadInFlight = false;

function showToast(message, type, duration) {
	if (typeof eda === 'undefined') return;
	try {
		eda?.sys_Message?.showToastMessage?.(message, type || 'info', duration || 3);
	} catch (e) {
		console.warn('[jspcb] toast failed', e);
	}
}

function delay(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// iframe 中 eda API 可能比脚本更晚注入，这里轮询等待，避免一打开就误判为“非 EDA 环境”
function waitForEdaApi(timeoutMs) {
	return new Promise(function(resolve) {
		const start = Date.now();
		(function check() {
			if (typeof eda !== 'undefined' && eda?.pcb_ManufactureData?.getDsnFile) return resolve(true);
			if (Date.now() - start >= timeoutMs) return resolve(false);
			setTimeout(check, 200);
		})();
	});
}

function enableEdaMode() {
	const fileInputWrapper = document.getElementById('file_input_wrapper');
	if (fileInputWrapper) fileInputWrapper.style.display = 'none';
}

async function loadDsnFromEdaOnce() {
	const dsnFile = await eda.pcb_ManufactureData.getDsnFile();

	let dsnContent;
	if (typeof dsnFile === 'string') dsnContent = dsnFile;
	else if (dsnFile && typeof dsnFile.text === 'function') dsnContent = await dsnFile.text();
	else if (dsnFile instanceof ArrayBuffer) dsnContent = new TextDecoder().decode(dsnFile);
	else throw new Error(t('ui.errReadDsn'));

	if (!dsnContent || dsnContent.trim().length < 50) throw new Error(t('ui.errEmptyDsn'));

	const checkbox = document.getElementById('dsn_normalize');
	if (checkbox) checkbox.checked = true;

	const info = typeof parseDsnInfo === 'function' ? parseDsnInfo(dsnContent) : null;
	if (info && info.fileName) fileName = info.fileName;
	if (handleOnLoad({ target: { result: dsnContent } }, true) === false) {
		const err = new Error(t('ui.errNormalize'));
		err.fatal = true;
		throw err;
	}
}

async function autoLoadDsnFromEda() {
	if (autoLoadInFlight) return;
	autoLoadInFlight = true;
	try {
		const ready = await waitForEdaApi(5000);
		if (!ready) {
			// 非 EDA 环境（例如浏览器里直接打开），保留文件选择
			return;
		}

		enableEdaMode();
		showToast(t('toast.fetchingDsn'), 'info', 2);

		let lastError = null;
		for (let attempt = 1; attempt <= 5; attempt++) {
			try {
				await loadDsnFromEdaOnce();
				showToast(t('toast.dsnLoaded', fileName), 'success', 2);
				return;
			} catch (e) {
				lastError = e;
				console.warn('[jspcb][eda] 自动获取 DSN 失败，第 ' + attempt + ' 次', e);
				if (e && e.fatal) break;
				if (attempt < 5) {
					await delay(300 + attempt * 300);
				}
			}
		}

		const msg = lastError && lastError.message ? lastError.message : t('ui.errUnknown');
		console.error('[jspcb][eda] load DSN failed', lastError);
		showToast(t('toast.dsnFail', msg), 'error', 6);
	} catch (e) {
		console.error('[jspcb][eda] auto load failed', e);
		showToast(t('toast.dsnFail', e && e.message ? e.message : e), 'error', 6);
	} finally {
		autoLoadInFlight = false;
	}
}

// 语言切换按钮（位于“?”左侧）
(function initLanguageSwitch() {
	const btn = document.getElementById('lang_btn');
	if (!btn || !window.jspcbI18n) return;
	btn.addEventListener('click', function() {
		const next = window.jspcbI18n.getLang() === 'en' ? 'zh-Hans' : 'en';
		window.jspcbI18n.setLang(next);
	});
})();

// 语言切换后同步“开始/停止布线”按钮等动态文案
document.addEventListener('jspcb-lang-change', function() {
	setRoutingState(isRouting);
	document.querySelectorAll('.step-up').forEach(function(btn) { btn.setAttribute('aria-label', t('ui.increase')); });
	document.querySelectorAll('.step-down').forEach(function(btn) { btn.setAttribute('aria-label', t('ui.decrease')); });
});

// 等词条加载完成后再自动获取 DSN，保证吐司使用正确语言
if (window.jspcbI18n && window.jspcbI18n.ready) {
	window.jspcbI18n.ready.then(function() {
		setRoutingState(isRouting);
		autoLoadDsnFromEda();
	});
} else {
	autoLoadDsnFromEda();
}

// ===== 关于（?）弹窗 =====
(function initHelpDialog() {
	const modal = document.getElementById('help_modal');
	const openBtn = document.getElementById('help_btn');
	const closeBtn = document.getElementById('help_close');
	if (!modal || !openBtn) return;

	function openHelp() { modal.style.display = 'flex'; }
	function closeHelp() { modal.style.display = 'none'; }

	openBtn.onclick = openHelp;
	if (closeBtn) closeBtn.onclick = closeHelp;
	modal.addEventListener('click', function(e) {
		if (e.target === modal) closeHelp();
	});
	document.addEventListener('keydown', function(e) {
		if (e.key === 'Escape' && modal.style.display !== 'none') closeHelp();
	});
})();

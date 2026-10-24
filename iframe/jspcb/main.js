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

function startTimer() {
	stopTimer();
	const display = document.getElementById('timer-display');
	display.style.display = 'block';
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
	} catch (e) {
	}

	const mymath = await loadTextFile('mymath.js');
	const layer = await loadTextFile('layer.js');
	const router = await loadTextFile('router.js');
	const workerSource = await loadTextFile('worker.js');
	const cleanedWorker = workerSource.replace(/^\s*importScripts\([^\)]*\);\s*/m, '');
	const combined = `${mymath}\n${layer}\n${router}\n${cleanedWorker}\n`;
	workerBlobUrl = URL.createObjectURL(new Blob([combined], { type: 'application/javascript' }));
	return new Worker(workerBlobUrl);
}

async function handleOnGo(evt)
{
	if (file !== null)
	{
		//params
		let arg_g = +document.getElementById('arg_g').value;
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
		appendLog("系统就绪，开始初始化布线线程...");
		document.getElementById('go').disabled = true;
		startTimer();

		//run pcb solver web worker thread, register output listner
		if (worker !== null) worker.terminate();
		if (workerBlobUrl) {
			try { URL.revokeObjectURL(workerBlobUrl); } catch {}
			workerBlobUrl = null;
		}
		try {
			worker = await createRoutingWorker();
		} catch (e) {
			const msg = e && e.message ? e.message : String(e);
			appendLog('Worker 创建失败: ' + msg);
			document.getElementById('go').disabled = false;
			stopTimer();
			return;
		}
		worker.addEventListener('message', function(event)
		{
			// Handle log messages
			if (event.data.type === 'log') {
				appendLog(event.data.message);
				return;
			}

			// Worker 内部异常：恢复界面，避免一直卡在“开始布线”状态
			if (event.data.type === 'error') {
				appendLog('布线出错: ' + event.data.message);
				document.getElementById('go').disabled = false;
				stopTimer();
				return;
			}

			// 一次采样结束（正常完成或超时）
			if (event.data.type === 'done') {
				lastPcbData = event.data.data;
				js_pcb.view_pcb(lastPcbData, 0, 2, currentBoundary);
				document.getElementById('go').disabled = false;
				stopTimer();
				importResultToPcb(lastPcbData);
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
			appendLog('Worker 运行失败: ' + (event.message || '未知错误'));
			document.getElementById('go').disabled = false;
			stopTimer();
		}, false);

		//post to solver thread
		try {
			const pcbData = js_pcb.dsn2pcb(file, arg_g);
			currentBoundary = Array.isArray(pcbData[2]) ? pcbData[2] : null;
			worker.postMessage([pcbData,
						arg_t, arg_v, arg_s, arg_z, arg_r, arg_q, arg_d, arg_fr, arg_xr, arg_yr]);
		} catch (e) {
			// DSN 解析失败时也必须恢复界面，否则按钮会一直处于禁用状态
			appendLog('DSN 解析失败: ' + (e && e.message ? e.message : String(e)));
			document.getElementById('go').disabled = false;
			stopTimer();
		}
	}
}

function appendLog(message) {
	let logContainer = document.getElementById('log-content');
	let entry = document.createElement('div');
	entry.className = 'log-entry';
	entry.innerText = message;
	logContainer.appendChild(entry);

	// Auto scroll to bottom
	logContainer.scrollTop = logContainer.scrollHeight;

	// Check for completion message to re-enable button
	if (message.includes("所有采样完成")) {
		document.getElementById('go').disabled = false;
		stopTimer();
	}
}

//布线完成后自动导入 SES
async function importResultToPcb(pcbData)
{
	if (!pcbData || !originalFile) return;

	try {
		const hasTracks = Array.isArray(pcbData[1]) && pcbData[1].some(function(t) {
			return t[4] && t[4].length;
		});
		if (!hasTracks) {
			appendLog('没有可导入的走线，已跳过自动导入');
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
				appendLog('布线结果已自动导入 PCB');
				eda?.sys_Message?.showToastMessage?.('布线结果已导入 PCB', 'success', 3);
			} catch (e) {
				console.error('[jspcb][eda] import failed', e);
				appendLog('自动导入失败: ' + (e && e.message ? e.message : e));
				try {
					if (eda?.sys_FileSystem?.saveFile) {
						await eda.sys_FileSystem.saveFile(sesFile, sesFile.name);
						appendLog('SES 导入失败，已保存为文件: ' + sesFile.name);
						eda?.sys_Message?.showToastMessage?.('SES 导入失败，已保存文件', 'warning', 6);
					} else {
						eda?.sys_Message?.showToastMessage?.('SES 导入失败', 'error', 6);
					}
				} catch (e2) {
					console.error('[jspcb][eda] save fallback failed', e2);
					eda?.sys_Message?.showToastMessage?.('SES 导入失败且保存失败', 'error', 8);
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
		appendLog('已导出 SES 文件');
	} catch (err) {
		console.error('[jspcb] auto import failed', err);
		appendLog('SES 生成失败: ' + (err && err.message ? err.message : err));
	}
}

//file onload handler
function handleOnLoad(evt)
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
			alert('DSN 归一化失败: ' + err.message);
			// 转换失败时不要继续使用未转换的数据，否则坐标系不一致，
			// 布线器会把整块板当成只有几毫米大小。
			file = null;
			lastPcbData = null;
			currentBoundary = null;
			setDsnStatus('DSN 归一化失败：' + err.message, 'error');
			return false;
		}
	}

	file = content;
	lastPcbData = null;
	currentBoundary = null;
	setDsnStatus('已载入：' + fileName, 'success');
	return true;
}

//file selection handler
function handleFileSelect(evt)
{
	//filelist
	let files = evt.target.files;
	let f = files[0];

	//dsn files only.
	if (f.name.match('.*[.]dsn'))
	{
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
window.addEventListener('resize', function() {
	if (lastPcbData) {
		// Re-render with auto-scaling
		js_pcb.view_pcb(lastPcbData, 0, 2, currentBoundary);
	}
});

//register action handlers
document.getElementById('files').addEventListener('change', handleFileSelect, false);
document.getElementById('go').onclick = handleOnGo;
// ===== 从 EDA 自动获取并载入 DSN =====
let autoLoadInFlight = false;

function setDsnStatus(text, state) {
	const el = document.getElementById('dsn_status');
	if (!el) return;
	el.innerText = text;
	el.classList.remove('loading', 'success', 'error');
	if (state) el.classList.add(state);
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
	else throw new Error('无法读取 EDA 返回的 DSN');

	if (!dsnContent || dsnContent.trim().length < 50) throw new Error('DSN 内容为空');

	const checkbox = document.getElementById('dsn_normalize');
	if (checkbox) checkbox.checked = true;

	const info = typeof parseDsnInfo === 'function' ? parseDsnInfo(dsnContent) : null;
	if (info && info.fileName) fileName = info.fileName;
	if (handleOnLoad({ target: { result: dsnContent } }) === false) {
		throw new Error('DSN 归一化失败');
	}
}

async function autoLoadDsnFromEda() {
	if (autoLoadInFlight) return;
	autoLoadInFlight = true;
	try {
		const ready = await waitForEdaApi(5000);
		if (!ready) {
			// 非 EDA 环境（例如浏览器里直接打开），保留文件选择
			setDsnStatus('请选择 .dsn 文件');
			return;
		}

		enableEdaMode();
		setDsnStatus('正在从 EDA 获取 DSN…', 'loading');

		let lastError = null;
		for (let attempt = 1; attempt <= 5; attempt++) {
			try {
				await loadDsnFromEdaOnce();
				setDsnStatus('已自动载入：' + fileName, 'success');
				eda?.sys_Message?.showToastMessage?.('DSN 已自动载入', 'success', 2);
				return;
			} catch (e) {
				lastError = e;
				console.warn('[jspcb][eda] 自动获取 DSN 失败，第 ' + attempt + ' 次', e);
				if (attempt < 5) {
					setDsnStatus('正在重试获取 DSN（' + attempt + '/5）…', 'loading');
					await delay(300 + attempt * 300);
				}
			}
		}

		const msg = lastError && lastError.message ? lastError.message : '未知错误';
		console.error('[jspcb][eda] load DSN failed', lastError);
		setDsnStatus('DSN 自动获取失败：' + msg, 'error');
		eda?.sys_Message?.showToastMessage?.('DSN 自动获取失败，请重新打开窗口', 'error', 6);
	} catch (e) {
		console.error('[jspcb][eda] auto load failed', e);
		setDsnStatus('DSN 自动获取失败：' + (e && e.message ? e.message : e), 'error');
	} finally {
		autoLoadInFlight = false;
	}
}

// 弹窗打开即自动获取并载入 DSN
autoLoadDsnFromEda();

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

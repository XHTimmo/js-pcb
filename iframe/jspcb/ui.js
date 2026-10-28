/**
 * Display helpers adapted from PR #1 by summving (@easyeda2021).
 * https://github.com/XHTimmo/js-pcb/pull/1 — see NOTICE.md.
 */
'use strict';

var jspcbUi = (function () {
	function t(key, ...args) {
		return jspcbI18n.t(key, ...args);
	}

	// Keep the existing worker protocol; translate its presentation at the UI boundary.
	function formatLog(message, args = []) {
		if (message.startsWith('log.')) return t(message, ...args);
		const patterns = [
			[/^\[采样 (\d+)\/(\d+)\] 开始布线\.\.\.$/, 'log.sampleStart'],
			[/^\[采样 (\d+)\/(\d+)\] 布线失败，增加量化精度重试$/, 'log.sampleFail'],
			[/^\[采样 (\d+)\/(\d+)\] 完成! 耗时: (.+)s, 代价: (.+)$/, 'log.sampleDone'],
			[/^>>> 发现更优解 \(代价: (.+)\)$/, 'log.better'],
			[/^所有采样完成。最佳代价: (.+)$/, 'log.allDone'],
		];
		for (const [pattern, key] of patterns) {
			const match = message.match(pattern);
			if (match) return t(key, ...match.slice(1));
		}
		return message;
	}

	document.querySelectorAll('.param-row input[type="number"]').forEach(function (input) {
		const field = document.createElement('div');
		field.className = 'num-field';
		input.parentNode.insertBefore(field, input);
		field.appendChild(input);
		const stepper = document.createElement('div');
		stepper.className = 'num-stepper';
		for (const [direction, key, symbol] of [
			[1, 'ui.increase', '▲'],
			[-1, 'ui.decrease', '▼'],
		]) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'step-btn';
			button.setAttribute('data-i18n-aria-label', key);
			button.textContent = symbol;
			button.addEventListener('click', function () {
				if (direction > 0) input.stepUp();
				else input.stepDown();
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			});
			stepper.appendChild(button);
		}
		field.appendChild(stepper);
	});

	const languageButton = document.getElementById('lang_btn');
	languageButton.addEventListener('click', async function () {
		languageButton.disabled = true;
		try {
			await jspcbI18n.setLang(jspcbI18n.getLang() === 'en' ? 'zh-Hans' : 'en');
		} finally {
			languageButton.disabled = false;
		}
	});

	const modal = document.getElementById('help_modal');
	const openButton = document.getElementById('help_btn');
	const closeButton = document.getElementById('help_close');
	function closeHelp() {
		modal.hidden = true;
		openButton.focus();
	}
	openButton.addEventListener('click', function () {
		modal.hidden = false;
		closeButton.focus();
	});
	closeButton.addEventListener('click', closeHelp);
	modal.addEventListener('click', function (event) {
		if (event.target === modal) closeHelp();
	});
	document.addEventListener('keydown', function (event) {
		if (modal.hidden) return;
		if (event.key === 'Escape') closeHelp();
		if (event.key !== 'Tab') return;
		const controls = Array.from(modal.querySelectorAll('button, a[href]'));
		const first = controls[0];
		const last = controls[controls.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	});

	return { formatLog: formatLog };
})();

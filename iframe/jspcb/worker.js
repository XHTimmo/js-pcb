importScripts('/dist/router-core.js');

// The UI owns the Worker; the same solver is called directly by the headless adapter.
addEventListener('message', function (event) {
	try {
		jsPcbCore.solveLegacyParameters(event.data, {
			onEvent: function (message) {
				postMessage(message);
			},
		});
	} catch (error) {
		postMessage({ type: 'error', message: error && error.stack ? error.stack : String(error) });
	}
});

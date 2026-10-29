const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../src/core');

// This CLI calls the same pure core as the extension; no browser/Worker globals are simulated.
const fixtureDirectory = path.resolve(__dirname, '../../tests/fixtures');
const files =
	process.argv.length > 2
		? process.argv.slice(2).map((file) => path.resolve(file))
		: fs
				.readdirSync(fixtureDirectory)
				.filter((file) => file.endsWith('.dsn'))
				.map((file) => path.join(fixtureDirectory, file));
const outputDirectory = path.resolve(__dirname, '../../tmp');
fs.mkdirSync(outputDirectory, { recursive: true });

try {
	assert.ok(files.length, 'Usage: node iframe/jspcb/test_runner.js <file.dsn> [...]');
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		const name = path.basename(file, '.dsn');
		let data, ses, report;
		if (/\(resolution\s+mil\s+1000\)/i.test(source)) {
			({ data, ses, report } = core.routeDsn(source, { solver: { timeoutSec: 30, seed: 1 } }));
			assert.notEqual(report.status, 'rejected', JSON.stringify(report.violations));
			assert.equal(report.skillVersion, null);
			assert.equal(report.imported, false);
		} else {
			// Preserve the legacy CLI path for already-normalized DSN inputs.
			const input = core.dsn2pcb(source, 2, 0);
			data = core.solveLegacyParameters([input, 30, 0, 1, 16, 1, 2, 1, 2, 1, 1]).data;
			ses = core.convertPcbToSes(data, core.parseDsnInfo(source), { gap: 2 });
		}
		assert.ok(data && ses, 'Missing routing output');
		assert.equal((ses.match(/\(padstack via0/g) || []).length, 1, 'Expected one via0 padstack declaration');
		assert.ok(ses.includes('(network_out') && ses.includes('(resolution'));
		assert.ok(!/NaN|Infinity/.test(ses), 'SES contains nonfinite coordinates');
		for (const name of core.parseDsnInfo(source).netNames) assert.ok(ses.includes('(net ' + name), 'Missing SES net: ' + name);
		fs.writeFileSync(path.join(outputDirectory, 'test_output_' + name + '.ses'), ses);
		if (report) fs.writeFileSync(path.join(outputDirectory, 'test_output_' + name + '.json'), JSON.stringify(report, null, 2));
		console.log(
			name +
				': ' +
				(report ? report.status + ', routed ' + report.coverage.routedNets + '/' + report.coverage.totalNets : 'legacy routing completed'),
		);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}

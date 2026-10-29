'use strict';
// Browser/Worker glue only. The core modules themselves never access globals or EDA.
const core = require('../core/index.js');
globalThis.jsPcbCore = core;
globalThis.js_pcb = Object.assign(globalThis.js_pcb || {}, core.engine, { dsn2pcb: core.dsn2pcb });
globalThis.normalizeDsn = core.normalizeDsn;
globalThis.parseDsnInfo = core.parseDsnInfo;
globalThis.convertPcbToSes = core.convertPcbToSes;

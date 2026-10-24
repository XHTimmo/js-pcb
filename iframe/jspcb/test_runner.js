const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- 模拟浏览器环境 ---
global.js_pcb = {};
global.window = global;
global.self = global;
// 某些脚本可能需要 require (如 dsn-normalizer.js)
global.require = require;
global.module = { exports: {} }; // Mock module

// 模拟 importScripts
global.importScripts = function(...files) {
    for (const file of files) {
        const filePath = path.join(__dirname, file);
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            // 使用 vm.runInThisContext 在全局作用域执行
            vm.runInThisContext(content, { filename: filePath });
            console.log(`Loaded ${file}`);
        } catch (e) {
            console.error(`Error loading script ${file}:`, e);
        }
    }
};

// 模拟 postMessage (用于接收 worker 输出)
let workerOutput = null;
global.postMessage = function(msg) {
    workerOutput = msg;
};

global.addEventListener = function(type, listener) {
    // 忽略
};

// --- 加载核心库 ---
// 顺序很重要
const libFiles = [
    'mymath.js',
    'layer.js',
    'router.js',
    'dsn2pcb.js',
    'dsn-normalizer.js',
    'pcb2ses.js'
];

console.log('Loading libraries...');
// 防止 dsn-normalizer.js 执行 CLI 逻辑
const originalArgv = process.argv;
process.argv = undefined;

for (const file of libFiles) {
    global.importScripts(file);
}

// 恢复 argv
process.argv = originalArgv;



// 加载 worker.js
// worker.js 会调用 importScripts 加载 mymath, layer, router，这是重复的但无害
// worker.js 定义了 pcb_thread
console.log('Loading worker.js...');
global.importScripts('worker.js');

// 确保 pcb_thread 可用
if (typeof pcb_thread !== 'function') {
    console.error('ERROR: pcb_thread not found!');
    process.exit(1);
}

// --- 测试流程 ---

async function runTest() {
    await testFile('示例.dsn');
    console.log('\n--------------------------------------------------\n');
    await testFile('jlc输出.dsn');
}

async function testFile(filename) {
    const dsnPath = path.resolve(__dirname, '..', 'jlc-file', filename);
    const sesOutputPath = path.resolve(__dirname, `test_output_${filename}.ses`);

    console.log(`\n--- Test Start: ${filename} ---`);
    console.log(`Input DSN: ${dsnPath}`);
    
    if (!fs.existsSync(dsnPath)) {
        console.error('DSN file not found!');
        return;
    }

    let dsnContent = fs.readFileSync(dsnPath, 'utf8');
    
    // 1. DSN 归一化（示例.dsn 是嘉立创格式；若已是标准格式则会原样返回）
    // 根据 main.js，用户勾选转换。
    console.log('Step 1: Normalizing EasyEDA DSN...');
    let normalizedDsn = dsnContent;
    let isDsnNormalized = true; // 假设是嘉立创格式
    try {
        normalizedDsn = global.normalizeDsn(dsnContent);
        console.log('Normalization successful. Preview (first 2000 chars):');
        console.log(normalizedDsn.substring(0, 2000));
        // Check for network section
        if (normalizedDsn.includes('(network')) {
            console.log('✅ Found (network ... ) section in normalized DSN');
        } else {
            console.log('❌ (network ... ) section MISSING in normalized DSN');
        }
    } catch (e) {

        console.error('Normalization failed or not needed:', e);
        isDsnNormalized = false;
    }

    // 2. 解析 DSN 到 PCB 数据
    console.log('Step 2: Parsing DSN to PCB data...');
    const gap = 2; // 默认值
    // dsn2pcb 需要标准 Specctra DSN（0.1um 坐标、F.Cu/B.Cu 层名）
    const pcbInputData = global.js_pcb.dsn2pcb(normalizedDsn, gap);
    console.log(`DEBUG: pcbInputData tracks count: ${pcbInputData[1].length}`);
    console.log(`DEBUG: PCB Dimensions: ${pcbInputData[0]}`);
    
    // 3. 运行布线
    console.log('Step 3: Running Router...');
    // 参数: [pcb_data, arg_t, arg_v, arg_s, arg_z, arg_r, arg_q, arg_d, arg_fr, arg_xr, arg_yr]
    // 使用默认参数，减少时间 arg_t = 5s (默认 600)
    const args = [
        pcbInputData,
        5,  // time limit (s)
        1,  // detailed output
        1,  // samples
        0,  // vias cost
        1,  // resolution (MUST BE > 0)
        0,  // quantization
        0,  // distance func
        6,  // flood range
        2,  // x range
        2   // y range
    ];

    workerOutput = null;
    pcb_thread(args);

    if (!workerOutput) {
        console.error('Router failed to produce output!');
        return;
    }
    
    const finalPcbData = workerOutput;
    console.log(`DEBUG: finalPcbData tracks count: ${finalPcbData[1].length}`);
    console.log('Routing complete.');

    // 4. 导出 SES
    console.log('Step 4: Exporting SES...');
    // parseDsnInfo 需要传入 *转换后* 的 DSN 还是 *原始* DSN？
    // pcb2ses.js 的 parseDsnInfo 用来获取 netNames 和 minx/miny
    // 如果做了归一化，minx/miny 用原始 DSN 的值（dsn2pcb 内部会平移坐标，导出时需要还原）
    // 但是 pcb2ses.js 现在的 calculateGlobalBounds 是从 parseDsnInfo 内部调用的
    // 我们应该传给它 normalizedDsn 还是 dsnContent?
    // main.js 中: const dsnInfo = parseDsnInfo(originalFile); 传入的是原始文件内容
    // 所以这里应该传 dsnContent (原始 JLC DSN)
    
    const dsnInfo = global.parseDsnInfo(dsnContent); 
    dsnInfo.fileName = path.basename(filename, '.dsn');
    dsnInfo.isDsnNormalized = isDsnNormalized;

    // 检查 parseDsnInfo 的结果
    console.log(`Parsed DSN Info: NetNames Count = ${dsnInfo.netNames.length}`);
    console.log(`Bounds: [${dsnInfo.minx}, ${dsnInfo.miny}, ${dsnInfo.maxy}]`);

    const sesContent = global.convertPcbToSes(finalPcbData, dsnInfo, { gap: gap });
    
    fs.writeFileSync(sesOutputPath, sesContent, 'utf8');
    console.log(`SES written to ${sesOutputPath}`);
    console.log('DEBUG: SES Content Preview (first 500 chars):');
    console.log(sesContent.substring(0, 500));

    // 5. 分析结果
    analyzeResults(dsnContent, sesContent, dsnInfo);
}

function analyzeResults(dsnContent, sesContent, dsnInfo) {
    console.log('\n--- Analysis Results ---');
    
    // 1. 网络名对比
    // pcb2ses.js 已经解析了 dsnInfo.netNames
    const expectedNets = dsnInfo.netNames;
    
    // 从 SES 提取网络名
    const sesNetMatches = sesContent.match(/\(net\s+"?([^"\s]+)"?/g) || [];
    const actualNets = sesNetMatches.map(s => {
        const m = s.match(/\(net\s+"?([^"\s]+)"?/);
        return m ? m[1].replace(/^"|"$/g, '') : '';
    });

    console.log(`Expected Nets (DSN): ${expectedNets.length}`);
    console.log(`Actual Nets (SES): ${actualNets.length}`);

    const missing = expectedNets.filter(n => !actualNets.includes(n));
    const extra = actualNets.filter(n => !expectedNets.includes(n));

    if (missing.length > 0) {
        console.log('❌ MISSING Nets in SES:', missing);
    } else {
        console.log('✅ All DSN nets present in SES.');
    }

    if (extra.length > 0) {
        console.log('⚠️  Extra Nets in SES (might be auto-generated):', extra);
    }

    // 2. 坐标范围检查
    // 简单的正则提取 SES 中的 path 坐标
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const pathLines = sesContent.split('\n').filter(l => l.includes('(path'));
    let pointCount = 0;
    
    for (const line of pathLines) {
        // (path layer width x1 y1 x2 y2 ...)
        const parts = line.trim().replace(/[()]/g, '').split(/\s+/);
        // parts[0]=path, parts[1]=layer, parts[2]=width, parts[3]=x1...
        for (let i = 3; i < parts.length; i+=2) {
            const x = parseFloat(parts[i]);
            const y = parseFloat(parts[i+1]);
            if (!isNaN(x)) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
            }
            if (!isNaN(y)) {
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
            pointCount++;
        }
    }

    if (pointCount === 0) {
        console.log('⚠️  No paths found in SES output.');
    } else {
        console.log(`Coordinate Range: X[${minX}, ${maxX}], Y[${minY}, ${maxY}]`);
        
        // 检查是否有异常值
        if (minX < -1000000 || maxX > 10000000 || minY < -1000000 || maxY > 10000000) {
            console.log('❌ Coordinates seem out of bounds!');
        } else {
            console.log('✅ Coordinates seem reasonable.');
        }
    }
}

runTest();

/**
 * EasyEDA Pro DSN 归一化（mil 坐标 -> 0.1µm 坐标）
 * 把嘉立创EDA专业版导出的 DSN 调整为 JS-PCB/dsn2pcb 期望的标准 Specctra DSN
 */

function normalizeDsn(dsnContent) {
    // 解析 S-expression
    const tokens = tokenize(dsnContent);
    let pos = { index: 0 };
    const tree = parseExpr(tokens, pos);
    
    // 转换树结构
    const converted = convertTree(tree);
    
    // 输出为字符串
    return stringify(converted, 0);
}

// 词法分析
function tokenize(str) {
    const tokens = [];
    let i = 0;
    while (i < str.length) {
        const ch = str[i];
        if (ch === '(' || ch === ')') {
            tokens.push(ch);
            i++;
        } else if (ch === '"') {
            // 带引号的字符串
            let s = '"';
            i++;
            while (i < str.length && str[i] !== '"') {
                s += str[i];
                i++;
            }
            s += '"';
            i++;
            tokens.push(s);
        } else if (/\s/.test(ch)) {
            i++;
        } else {
            // 普通 token
            let s = '';
            while (i < str.length && !/[\s()]/.test(str[i])) {
                s += str[i];
                i++;
            }
            tokens.push(s);
        }
    }
    return tokens;
}

// 语法分析
function parseExpr(tokens, pos) {
    if (tokens[pos.index] === '(') {
        pos.index++;
        const list = [];
        while (tokens[pos.index] !== ')') {
            list.push(parseExpr(tokens, pos));
        }
        pos.index++;
        return list;
    } else {
        return tokens[pos.index++];
    }
}

// 转换树结构
function convertTree(tree) {
    if (!Array.isArray(tree) || tree[0] !== 'PCB' && tree[0] !== 'pcb') {
        return tree;
    }
    
    const result = ['pcb'];
    
    // 文件名
    const fileName = tree[1] || '"converted.dsn"';
    result.push(fileName);
    
    // 添加 parser 部分
    result.push([
        'parser',
        ['string_quote', '"'],
        ['space_in_quoted_tokens', 'on'],
        ['host_cad', '"EasyEDA Pro (converted)"'],
        ['host_version', '"1.0"']
    ]);
    
    // 查找并转换各部分
    const networkChildren = [];
    
    for (let i = 2; i < tree.length; i++) {
        const node = tree[i];
        if (!Array.isArray(node)) continue;
        
        const type = node[0];
        if (type === 'parser') {
            // 跳过原有 parser，已添加新的
            continue;
        } else if (type === 'resolution') {
            // 转换分辨率：mil -> um
            result.push(['resolution', 'um', '10']);
            result.push(['unit', 'um']);
        } else if (type === 'structure') {
            result.push(convertStructure(node));
        } else if (type === 'placement') {
            result.push(convertPlacement(node));
        } else if (type === 'library') {
            result.push(convertLibrary(node));
        } else if (type === 'network') {
            // 提取 network 内容
            const converted = convertNetwork(node);
            for (let k = 1; k < converted.length; k++) {
                networkChildren.push(converted[k]);
            }
        } else if (type === 'net') {
            // 顶层 net 放入 network
            networkChildren.push(convertNet(node));
        } else if (type === 'class') {
            // 顶层 class 放入 network
            networkChildren.push(convertClass(node));
        } else if (type === 'wiring') {
            result.push(node);
        }
    }
    
    // 添加合并后的 network 节点
    if (networkChildren.length > 0) {
        const netNode = ['network'];
        networkChildren.forEach(c => netNode.push(c));
        result.push(netNode);
    }
    
    return result;
}

// mil 转 um (1 mil = 25.4 um)
// JLC DSN: resolution mil 1000，坐标如 1687.45 表示 1687.45 mil
// 标准 Specctra DSN（KiCad 风格）: resolution um 10，坐标是 0.1um
// 转换公式: mil_value * 25.4 * 10 = mil_value * 254
function milToUm(milValue) {
    const num = parseFloat(milValue);
    if (isNaN(num)) return milValue;
    // JLC DSN 坐标已经是 mil 值 (如 1687.45 mil)
    // 转换到 0.1um 单位: 1687.45 * 25.4 * 10 = 428612
    return Math.round(num * 254);
}

// 转换 structure
function convertStructure(node) {
    const result = ['structure'];
    
    for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (!Array.isArray(child)) continue;
        
        const type = child[0];
        if (type === 'layer') {
            // 转换层名
            const layerName = child[1];
            let newName = layerName;
            if (layerName === 'TopLayer') newName = 'F.Cu';
            else if (layerName === 'BottomLayer') newName = 'B.Cu';
            
            const newLayer = ['layer', newName];
            for (let j = 2; j < child.length; j++) {
                newLayer.push(child[j]);
            }
            result.push(newLayer);
        } else if (type === 'boundary') {
            // 转换边界坐标
            result.push(convertBoundary(child));
        } else if (type === 'via') {
            // 保留原来的 via 名称（EasyEDA 导出为 via0）。
            // 这样布线器会使用 DSN 里真实的过孔 padstack 尺寸，
            // 而不是写死的尺寸，导出 SES 时也能保持与设计一致。
            result.push(child);
        } else if (type === 'rule') {
            // 转换规则，mil -> um
            result.push(convertRule(child));
        } else if (type === 'grid') {
            // 跳过 grid
            continue;
        } else {
            result.push(child);
        }
    }
    
    return result;
}

// 转换边界
function convertBoundary(node) {
    const result = ['boundary'];
    
    for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (Array.isArray(child) && child[0] === 'path') {
            const newPath = ['path', 'pcb', '0'];
            // 转换坐标
            for (let j = 3; j < child.length; j++) {
                newPath.push(String(milToUm(child[j])));
            }
            result.push(newPath);
        } else {
            result.push(child);
        }
    }
    
    return result;
}

// 转换规则
function convertRule(node) {
    const result = ['rule'];
    
    for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (Array.isArray(child)) {
            const type = child[0];
            if (type === 'width' || type === 'clear' || type === 'clearance') {
                const newChild = [type === 'clear' ? 'clearance' : type];
                for (let j = 1; j < child.length; j++) {
                    if (typeof child[j] === 'string' && !isNaN(parseFloat(child[j]))) {
                        newChild.push(String(milToUm(child[j])));
                    } else {
                        newChild.push(child[j]);
                    }
                }
                result.push(newChild);
            } else {
                result.push(child);
            }
        }
    }
    
    return result;
}

// 转换 placement - 保持 JLC 的单一 component 结构，因为 pin 引用是 u1-xxx 格式
function convertPlacement(node) {
    const result = ['placement'];
    
    for (let i = 1; i < node.length; i++) {
        const comp = node[i];
        if (!Array.isArray(comp) || comp[0] !== 'component') continue;
        
        const compName = comp[1] || 'u1';
        const newComp = ['component', compName];
        
        // 查找 place
        for (let j = 2; j < comp.length; j++) {
            const place = comp[j];
            if (Array.isArray(place) && place[0] === 'place') {
                const placeName = place[1] || compName;
                const x = milToUm(place[2] || 0);
                const y = milToUm(place[3] || 0);
                const side = place[4] || 'front';
                const rotation = place[5] || 0;
                
                newComp.push(['place', placeName, String(x), String(y), side, String(rotation), ['PN', placeName]]);
            }
        }
        
        result.push(newComp);
    }
    
    // 如果没有找到有效的 placement，添加一个虚拟的
    if (result.length === 1) {
        result.push([
            'component',
            'u1',
            ['place', 'u1', '0', '0', 'front', '0', ['PN', 'u1']]
        ]);
    }
    
    return result;
}

// 转换 library
function convertLibrary(node) {
    const result = ['library'];
    
    // 收集所有 image 和 padstack
    const images = [];
    const padstacks = [];
    
    for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (!Array.isArray(child)) continue;
        
        if (child[0] === 'image') {
            images.push(convertImage(child));
        } else if (child[0] === 'padstack') {
            padstacks.push(convertPadstack(child));
        }
    }
    
    // 添加转换后的内容
    images.forEach(img => result.push(img));
    padstacks.forEach(ps => result.push(ps));
    
    // 添加标准 via padstack。
    // 坐标系是 um*10，24 mil（0.6096 mm）过孔对应 6096；
    // 原来写 889（=0.0889 mm）会让布线器按过小的过孔判断间距，
    // 而导出 SES 时又按 24 mil 写过孔，导致导入后出现间距/短路问题。
    result.push([
        'padstack', '"Via[0-1]_889:635_um"',
        ['shape', ['circle', 'F.Cu', '6096']],
        ['shape', ['circle', 'B.Cu', '6096']],
        ['attach', 'off']
    ]);
    result.push([
        'padstack', '"Via[0-1]_889:0_um"',
        ['shape', ['circle', 'F.Cu', '6096']],
        ['shape', ['circle', 'B.Cu', '6096']],
        ['attach', 'off']
    ]);
    
    return result;
}

// 转换 image
function convertImage(node) {
    const result = ['image', node[1]];
    
    for (let i = 2; i < node.length; i++) {
        const child = node[i];
        if (!Array.isArray(child)) continue;
        
        if (child[0] === 'pin') {
            // 转换 pin 坐标
            const newPin = ['pin', child[1], child[2]];
            if (child.length > 3) newPin.push(String(milToUm(child[3])));
            if (child.length > 4) newPin.push(String(milToUm(child[4])));
            result.push(newPin);
        } else if (child[0] === 'outline') {
            result.push(convertOutline(child));
        } else {
            result.push(child);
        }
    }
    
    return result;
}

// 转换 outline
function convertOutline(node) {
    const result = ['outline'];
    
    for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (Array.isArray(child) && child[0] === 'path') {
            const newPath = ['path', 'signal', String(milToUm(child[2] || 0))];
            for (let j = 3; j < child.length; j++) {
                newPath.push(String(milToUm(child[j])));
            }
            result.push(newPath);
        } else {
            result.push(child);
        }
    }
    
    return result;
}

// 转换 padstack
function convertPadstack(node) {
    const result = ['padstack', node[1]];
    
    for (let i = 2; i < node.length; i++) {
        const child = node[i];
        if (!Array.isArray(child)) continue;
        
        if (child[0] === 'shape') {
            result.push(convertShape(child));
        } else {
            result.push(child);
        }
    }
    
    result.push(['attach', 'off']);
    return result;
}

// 转换 shape
function convertShape(node) {
    const result = ['shape'];
    
    for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (!Array.isArray(child)) {
            result.push(child);
            continue;
        }
        
        const type = child[0];
        if (type === 'circle') {
            // 转换层名和尺寸
            let layer = child[1];
            if (layer === 'TopLayer') layer = 'F.Cu';
            else if (layer === 'BottomLayer') layer = 'B.Cu';
            
            result.push(['circle', layer, String(milToUm(child[2] || 0))]);
        } else if (type === 'rect') {
            let layer = child[1];
            if (layer === 'TopLayer') layer = 'F.Cu';
            else if (layer === 'BottomLayer') layer = 'B.Cu';
            
            const coords = [];
            for (let j = 2; j < child.length; j++) {
                coords.push(String(milToUm(child[j])));
            }
            result.push(['rect', layer, ...coords]);
        } else if (type === 'polygon') {
            let layer = child[1];
            if (layer === 'TopLayer') layer = 'F.Cu';
            else if (layer === 'BottomLayer') layer = 'B.Cu';
            
            const newPoly = ['polygon', layer];
            for (let j = 2; j < child.length; j++) {
                newPoly.push(String(milToUm(child[j])));
            }
            result.push(newPoly);
        } else if (type === 'path') {
            let layer = child[1];
            if (layer === 'TopLayer') layer = 'F.Cu';
            else if (layer === 'BottomLayer') layer = 'B.Cu';
            
            const newPath = ['path', layer, String(milToUm(child[2] || 0))];
            for (let j = 3; j < child.length; j++) {
                newPath.push(String(milToUm(child[j])));
            }
            result.push(newPath);
        } else {
            result.push(child);
        }
    }
    
    return result;
}

// 转换 network
function convertNetwork(node) {
    const result = ['network'];
    
    for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (!Array.isArray(child)) continue;
        
        if (child[0] === 'net') {
            result.push(convertNet(child));
        } else if (child[0] === 'class') {
            result.push(convertClass(child));
        }
    }
    
    return result;
}

// 转换 net
function convertNet(node) {
    const result = ['net', node[1]];
    
    for (let i = 2; i < node.length; i++) {
        const child = node[i];
        if (Array.isArray(child) && child[0] === 'pins') {
            // 保持 pin 引用格式: u1-xxx (JS-PCB 需要这种格式来解析)
            const newPins = ['pins'];
            for (let j = 1; j < child.length; j++) {
                newPins.push(child[j]);
            }
            result.push(newPins);
        } else {
            result.push(child);
        }
    }
    
    return result;
}

// 转换 class
function convertClass(node) {
    const result = ['class'];

    // 类名
    if (node.length > 1) {
        result.push(node[1] === "''" ? 'kicad_default' : node[1]);
    }

    // 网络列表：EasyEDA 写成 (class GND 'GND' ...)，网络名带单引号。
    // 必须把网络名写回 class 节点，dsn2pcb 才能建立 "网络 -> 线宽/间距" 的映射；
    // 同时去掉单引号，否则 'GND' 与 net 名 GND 对不上。
    const netNames = [];
    const children = [];
    for (let i = 2; i < node.length; i++) {
        const child = node[i];
        if (typeof child === 'string' && !child.startsWith('(')) {
            const name = child.replace(/^'+|'+$/g, '');
            if (name) netNames.push(name);
        } else if (Array.isArray(child)) {
            if (child[0] === 'circuit') {
                children.push([
                    'circuit',
                    ['use_via', '"Via[0-1]_889:635_um"']
                ]);
            } else if (child[0] === 'rule') {
                children.push(convertRule(child));
            }
        }
    }
    // stringify 只会输出数组前面的普通值，所以网络名必须排在子节点之前
    result.push(...netNames);
    result.push(...children);

    return result;
}

// 输出为字符串
function stringify(tree, indent) {
    if (!Array.isArray(tree)) {
        return tree;
    }
    
    const spaces = '  '.repeat(indent);
    const innerSpaces = '  '.repeat(indent + 1);
    
    // 简单列表在一行
    const isSimple = tree.every(item => !Array.isArray(item)) && tree.length < 6;
    
    if (isSimple) {
        return '(' + tree.join(' ') + ')';
    }
    
    let result = '(' + tree[0];
    
    // 第一个元素后面可能跟着简单值
    let i = 1;
    while (i < tree.length && !Array.isArray(tree[i])) {
        result += ' ' + tree[i];
        i++;
    }
    
    // 剩余的复杂元素
    for (; i < tree.length; i++) {
        result += '\n' + innerSpaces + stringify(tree[i], indent + 1);
    }
    
    result += '\n' + spaces + ')';
    return result;
}

// 主函数 - 用于命令行
if (typeof process !== 'undefined' && process.argv) {
    const fs = require('fs');
    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        console.log('用法: node dsn-normalizer.js <输入.dsn> [输出.dsn]');
        console.log('将嘉立创EDA专业版导出的 DSN 归一化为 JS-PCB 可用的标准 Specctra DSN');
        process.exit(1);
    }
    
    const inputFile = args[0];
    const outputFile = args[1] || inputFile.replace('.dsn', '_converted.dsn');
    
    try {
        const content = fs.readFileSync(inputFile, 'utf-8');
        const converted = normalizeDsn(content);
        fs.writeFileSync(outputFile, converted, 'utf-8');
        console.log(`归一化完成: ${outputFile}`);
    } catch (err) {
        console.error('归一化失败:', err.message);
        process.exit(1);
    }
}

// 导出供浏览器使用
if (typeof window !== 'undefined') {
    window.normalizeDsn = normalizeDsn;
}

// 导出供模块使用
if (typeof module !== 'undefined') {
    module.exports = { normalizeDsn };
}

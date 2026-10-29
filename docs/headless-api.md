# 无头布线 API / Headless routing API

布线器独立于 Skill。Skill、脚本、命令行和可见界面均可使用共享核心；只有调用方明确传入的附加约束才会生效。省略 `rules` 时按 DSN 规则布线，报告的 `skillVersion` 为 `null`，`ruleChecks` 为空。

## 架构与入口

- `src/core/`：CommonJS 纯核心，包含 DSN 解析、求解、固定铜/禁布区、连通性与几何检查、SES 生成。无 DOM、IFrame、消息收发、EDA 或 Skill 加载。
- `src/headless/service.ts`：EDA 适配器，选择并核验目标、导出 DSN、调用核心、按需写出文件。
- `iframe/jspcb/`：可见界面和 Worker 适配器，调用同一核心，保留历史记录、手动操作、双语与导入确认。

`activate()` 在启动完成时注册两个接口，无需先打开布线窗口：

```js
return await external.jspcb.getCapabilities();
```

```js
return await external.jspcb.routeCurrentPcb({
  mode: 'dry-run',
  target: { pcbUuid: '目标 PCB UUID' },
  solver: { timeoutSec: 30, seed: 1234 }
});
```

`target` 可省略以使用当前 PCB，也可传 `{ boardName: '板名' }`。目标必须属于当前工程；显式指定目标时可从主页或原理图调用。适配器使用 `openDocument()` 返回的标签页 ID 激活目标，再核验实际 PCB，并在 DSN 导出后再次检查文档身份。

外部接口要求客户端支持 `sys_ExternalApi`；旧客户端仍可使用普通界面。扩展 UUID 保持 `fe81c92e8cae445f9e4e4117058555f5`。CLI 的调用超时应大于求解预算，例如：

```sh
easyeda-pro invoke --session <SESSION_ID> --ext-uuid eda --timeout 60000 --code 'return await external.jspcb.routeCurrentPcb({mode:"dry-run",solver:{timeoutSec:30,seed:1234}});'
```

需同时检查 CLI 外层 `ok` 和返回报告的 `status`；传输成功不等于布线成功。

完整输入与报告类型见 [src/core/types.ts](../src/core/types.ts)。未知参数和非法数值会被拒绝。

## 普通调用与 Skill 约束

普通调用不需要 Skill、Skill 版本或 `rules`：

```js
const { routeDsn } = require('./src/core');
const fs = require('node:fs');
const source = fs.readFileSync('tests/fixtures/three-pin.dsn', 'utf8');
const { report, ses } = routeDsn(source, { solver: { seed: 1234 } });
console.log(report.status, report.coverage);
```

Skill 可以显式传入规则。例如以下调用只请求铜距和板边间距检查，并记录调用方版本：

```js
return await external.jspcb.routeCurrentPcb({
  mode: 'dry-run',
  rules: {
    skillVersion: '0.1.7',
    copperClearanceMil: 6,
    edgeCopperGapMil: 10
  }
});
```

`skillVersion` 只是审计元数据，不会加载 Skill、自动增加规则或证明完整符合该版本规范。Skill 必须传入它要求的全部强制约束；不可只挑选当前支持的字段来宣称完整合规。`ruleId` 使用约束字段名，不冒充未经核验的 PCB-004、PCB-007～010 完整规范。

| 字段 / 能力                                       | 当前实现                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `copperClearanceMil`                              | 求解时使用 DSN 与请求值中较大的间距；结果检查网络间铜和异网焊盘      |
| `edgeCopperGapMil`                                | 求解时使用较大板边间距；结果检查外框、内孔和铜半径                   |
| `allowedTurnAnglesDeg`、`forbidRightAngle`        | 检查结果中的平面铜线折角和分支交点；不保证求解器能生成满足条件的候选 |
| `padExit`                                         | 不支持；拒绝请求，`nonOrthogonalPadExits: null`                      |
| `cornerStyle: 'chamfer45' / 'arc'`                | 不支持主动倒角/圆弧构造；拒绝请求                                    |
| `viaSilkClearanceMil`、`viaTestPointClearanceMil` | 未收集所需 EDA 几何；拒绝请求                                        |
| `fixedRoutes`                                     | 支持指定网络、宽度和单层直线段的不可重布铜路径                       |
| `keepouts`                                        | 支持简单多边形，指定铜层或 `all`；`kind: 'copper' / 'via'`           |
| `preserveExistingRoutes: true`                    | 尚未自动采集完整的既有直线、圆弧和过孔；拒绝请求                     |
| `mode: 'import'`                                  | 首版禁用；拒绝请求，不调用导入、PCB 保存或 DRC                       |

对未实现的必选约束，报告返回 `rejected` 和 `unsupported`，不会当作检查通过。角度定义为线段间的转向角，直线不计，分支交点也参加检查；此定义不替代外部 Skill 的完整语义。

## 固定路径、禁布区与网络选择

所有输入坐标、宽度和间距均为 **原始 DSN 的 mil 坐标**，不是预览网格坐标、毫米或未转换的 EDA 画布坐标。层可使用 DSN 铜层顺序的零基索引，或原始层名；`TopLayer` / `BottomLayer` 也接受 `F.Cu` / `B.Cu` 别名。

以下例子对应 `tests/fixtures/fixed-crossing.dsn`：

```js
const options = {
	solver: { seed: 7, samples: 2 },
	nets: { include: ['SIGNAL'], priority: { SIGNAL: 10 } },
	constraints: {
		fixedRoutes: [
			{
				id: 'power-loop',
				net: 'POWER',
				layer: 'TopLayer',
				protected: true,
				segments: [{ start: [20, 60], end: [100, 60], width: 4 }],
			},
		],
		keepouts: [
			{
				id: 'antenna',
				layer: 'all',
				kind: 'copper',
				clearanceMil: 2,
				polygon: [
					[10, 10],
					[30, 10],
					[30, 30],
					[10, 30],
				],
			},
		],
	},
};
```

固定路径在求解前进入碰撞模型，重试、采样和删除生成线路时均保留；同网可接入，异网必须避让。已完全通过固定铜连接的网络也计为布通。固定路径冲突会返回 `FIXED_ROUTE_CONFLICT`、网络名及相关对象 ID。SES 按明确网络名分组，固定路径无需通过坐标反推网络。

`nets.include` 省略表示选择所有电气网络，空数组表示不新增布线；`exclude` 优先于 `include`。未知网络名会拒绝请求。排除网络的焊盘和显式固定铜仍参与避让，覆盖率只统计所选网络。较大的 `priority` 优先尝试，仍受重试和可布通性限制。

**DSN 中既有的 `wiring` 不会自动成为受保护路径。** 若存在，报告返回 `EXISTING_ROUTES_NOT_PRESERVED` 提示；需要保护的铜必须明确传入 `fixedRoutes`。原始 PCB 始终不被此接口修改。

约束 `id` 可由调用方提供，省略时生成确定性的局部 ID。报告中的生成线路和焊盘 ID 是 DSN 局部标识，不是可直接回写的 EDA 图元 UUID。

## 报告、预算与文件

- `status`：`dry-run` 表示所有所选网络物理连通且已实现的检查通过；`partial` 表示未完全布通、取消或预算结束；输入、约束、几何或输出失败为 `rejected`。首版不会返回 `imported`。
- `routing.status`：独立描述 `not-run`、`complete`、`partial`、`timeout` 或 `cancelled`。
- `coverage`：根据导线、过孔、固定铜与焊盘的实际接触关系计算，不能仅凭求解器的完成标记判定。
- `geometry`：已测量的线段、过孔、斜线段和直角交点数量；未测量项为 `null`。直角数包含分支交点，固定铜也计入几何。
- `ruleChecks`：只记录请求的附加规则，分别标出 `enforced` 与 `validation`；状态使用 `passed / failed / unsupported / not-checked`。
- `imported`、`execution.imported` 和 `execution.saved`：首版始终为 `false`，其中 `saved` 指 PCB 文档保存，不表示文件输出。
- `routerCommit`：构建时的核心版本；工作区修改构建带 `-dirty`，直接运行未打包源码为 `unversioned`。

无头 `timeoutSec` 默认 30 秒，范围 0.001～1800，跨全部采样共享截止时间，EDA 导出耗时也计入剩余预算。当前使用周期性截止检查，不能抢占正在等待的 SDK 调用或每个解析/校验操作；它不是对任意平台调用的硬实时超时。原有可见界面继续按每个采样单独计时，默认 3600 秒，0 表示不限时。

`seed` 可复现随机顺序；遇到时间截止时仍可能因机器速度得到不同结果。默认网格上限 `maxNodes` 为 1600 万，可设为 1～6400 万；超过上限会在分配网格前拒绝。输入 DSN 限 1000 万字符，固定线段限 2000 条。

```js
output: {
  saveSesPath: 'C:/.../projects/MyBoard/routed.ses',
  saveReportPath: 'C:/.../projects/MyBoard/routing.json',
  includeSes: true
}
```

文件目录应已存在且属于 EDA 文件 API 可写范围；两个路径必须不同。输出使用非交互文件 API，检查返回布尔值和异常。仅成功写出的路径才进入 `artifacts`；被拒绝的候选不写出 SES。预检即拒绝的请求直接返回报告，不创建输出文件。文件输出不是事务：例如 SES 已保存而报告写入失败时，返回失败并保留已写 SES 的路径。`includeSes` 省略时不把大段 SES 放入返回 JSON。

本接口当前接受 `(resolution mil 1000)` 的嘉立创EDA DSN。SES 过孔仍使用单一圆形通孔模型；产生过孔且铜层多于两层、外径不一致或源过孔形状不受支持时返回 `UNSUPPORTED_VIA_MODEL`。孔径、阻焊、丝印、测试点和真实 EDA DRC 不在本版本验证范围。安装后在真实客户端中的外部注册、SES 导入与 DRC 仍需另行验证。

## English

The router has **no Skill dependency**. The visible UI, the EDA headless adapter and Node callers share `src/core/`. Omitting `rules` uses DSN rules, returns `skillVersion: null` and leaves `ruleChecks` empty. A Skill supplies explicit constraints through the same API as any other caller. Its version is audit metadata, not a conformance certificate.

Startup registers `external.jspcb.getCapabilities()` and `external.jspcb.routeCurrentPcb(options)` without opening an IFrame. An explicit `target: { pcbUuid }` or `{ boardName }` can be selected from a schematic or homepage; an omitted target requires an active PCB. Targets are checked against the current project and verified after activation and DSN export. Older clients without `sys_ExternalApi` retain the ordinary UI workflow.

The examples above show plain routing, explicit rule requests, fixed routes, keepouts and file output. See [types.ts](../src/core/types.ts) for the complete schema. All constraint geometry uses original DSN **mil coordinates**. Layer numbers follow zero-based DSN copper-layer order; exact names are also accepted. Network include/exclude/priority controls do not depend on Skill. Excluded pads and supplied fixed copper remain obstacles.

Protected straight segments retain their exact geometry through retries and samples, connect their own net, obstruct other nets and keep explicit net names in SES. Existing DSN wiring is **not automatically preserved**. Pass required copper explicitly as `fixedRoutes`; `preserveExistingRoutes: true` is rejected until full collection is implemented.

Copper and board-edge gaps are applied during solving and checked afterward. Turn-angle and right-angle requests validate candidates, including branch junctions; they do not force the solver to construct a compliant route. Pad exit leads, explicit chamfer/arc construction, via-to-silkscreen and via-to-test-point checks are unsupported and reject the request. A Skill must supply all its mandatory requirements rather than silently dropping unsupported rules.

This release supports **dry-run only**. `mode: 'import'` is rejected; it never imports SES, saves the PCB or runs PCB DRC. Reports separate routing outcome, constraint checks, coverage and execution. Coverage is checked against physical copper/pad connectivity. Unmeasured geometry is `null`, and local object IDs are not EDA primitive UUIDs.

The headless deadline defaults to 30 seconds across all samples and includes elapsed DSN-export time. Checks are cooperative and cannot preempt pending SDK calls or every parsing/validation operation. Set the external CLI timeout above the routing budget. The visible UI retains its existing per-sample timeout. Seeded order is repeatable, but time-limited results can still vary by machine. Grid allocation defaults to 16 million nodes and is bounded before allocation.

Optional artifacts use noninteractive file writes and check failures; only successful paths appear in the report. SES is not written for rejected candidates. Early preflight failures create no files. Output is not transactional, and `execution.saved` refers to the PCB document, not artifact files. Set `includeSes: true` only when SES text is needed in the returned JSON.

Headless DSN input currently requires `resolution mil 1000`. Via output is limited to one uniform circular through-via model on two copper layers; unsupported via results are rejected. Drill, mask, silkscreen, test-point and actual EDA DRC validation remain outside this release. Live-client external registration, import and DRC still require separate validation.

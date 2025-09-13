# FCT Miner

交互式 FCT 代币挖矿工具，内置实时看板，支持主网（mainnet）与测试网（Sepolia）。
An interactive FCT token miner with real-time dashboard interface for both mainnet and Sepolia testnet.

## Quick Start（快速开始）

1) 安装依赖（若未安装 pnpm，可用 npm 代替）

```bash
pnpm install
# 如果没有 pnpm：
npm install
```

2) 配置钱包与网络

```env
PRIVATE_KEY=0x... # 你的钱包私钥（0x + 64位十六进制）
NETWORK=sepolia   # 或 mainnet（主网）

# 可选：Gas 价格乘数（默认 1.5，表示 +50% 缓冲以便更快确认）
# GAS_PRICE_MULTIPLIER=1.5
```

3) 为钱包充值

- Sepolia：前往 https://sepoliafaucet.com/ 领取测试 ETH
- Mainnet：向你的钱包地址转入真实 ETH

4) 启动挖矿

```bash
# 在当前网络上挖矿
npm run mine

# 指定网络挖矿
npm run mine:sepolia
npm run mine:mainnet
```

## Available Commands（可用命令）

### Mining（挖矿）

```bash
npm run mine              # 在当前网络挖矿
npm run mine:sepolia      # 切到 Sepolia 并挖矿
npm run mine:mainnet      # 切到主网并挖矿
```

### Network Management（网络管理）

```bash
npm run network           # 交互式切换网络
npm run network:show      # 查看当前网络
npm run network:sepolia   # 切换至 Sepolia 测试网
npm run network:mainnet   # 切换至主网
```

### Other Tools（其他工具）

```bash
npm run swap              # FCT 兑换（仅主网）
npm run l2hash            # L1 -> L2 哈希转换工具
pnpm auto:trade           # 独立自动交易进程（卖 FCT -> WETH）
pnpm smoke:swap           # 烟囱测试：小额+宽松 minOut 验证 approve+路径+Router
pnpm test:mine:sepolia    # Sepolia 小额挖矿（产出 NDJSON + 写账本）
pnpm test:mine:mainnet:dry# 主网参数检查（不发交易，打印 calldata/data gas）
pnpm test:trade:dry       # 交易侧 dry-run，打印单行 JSON 判定
pnpm test:trade:smoke     # 主网极小额烟囱（simulate -> 发送，打印 tx_hash）
pnpm trade:live           # 主网实盘小额，常驻循环（带指数退避）
```

## Network Configuration（网络配置）

挖矿器会根据选择的网络自动适配：

### Sepolia Testnet（测试网）

- 用途：测试与开发（成本低）
- ETH 来源：https://sepoliafaucet.com/
- 特性：Gas 低、无交易对
- 浏览器：https://sepolia.explorer.facet.org

### Mainnet（主网）

- 用途：正式挖矿
- ETH 来源：需要真实 ETH
- 特性：功能完整（支持交易与价格数据）
- 浏览器：https://explorer.facet.org

## Environment Variables（环境变量）

```env
# 必填
PRIVATE_KEY=0x...         # 你的钱包私钥

# 网络
NETWORK=sepolia           # 可选：mainnet / sepolia

# 可选：更快确认的 Gas 价格乘数
GAS_PRICE_MULTIPLIER=1.5  # 默认 1.5（相当于 +50% 缓冲）

# 可选：自定义 RPC（若默认不稳定可覆盖）
L1_RPC_URL=...
FACET_RPC_URL=...

## Value vs Gas（本金与手续费）

在以太坊主网挖 FCT 时，请清晰地区分：
- value_eth（挖矿本金）：随交易一起发送到 Facet 的 ETH，用于挖矿/销毁/换取 FCT，不是 L1 手续费。
- fee_eth（L1 手续费）：支付给以太坊验证者的 gas 费用，约等于 `gas_limit × gas_price`。

工具在 dry-run 与发送前都会分别打印两者及合计：
- `value_eth`：本金（由 `--value-eth` 或 `VALUE_ETH` 指定；未指定则为 0）
- `gas_price_gwei`、`gas_limit≈`、`fee_eth≈`
- `total_est_eth≈` = `value_eth + fee_eth`（仅提示，不会自动扣款）

命令行参数（亦可用同名 ENV 变量覆盖）：
- `--value-eth`：挖矿本金（ETH）
- `--gas-multiplier`：气价乘数（默认 1.5）
- `--gwei-max | --gwei-min`：气价上下界
- `--cap-eth`：若 `fee + value` 超出上限则跳过（dry-run 显示 `SKIP(over_cap)`）

dry-run JSON 示例：
```json
{
  "dry_mine": {
    "kb": 1,
    "calldata_bytes": 864,
    "data_gas_est": 34560,
    "gas_price_gwei": 76.12,
    "fee_eth": "0.004237000",
    "value_eth": "0.010000000",
    "total_est_eth": "0.014237000",
    "cap_eth": "0.015000000",
    "decision": "OK"
  }
}
```

## Auto Trader（自动交易模块）

目标：不影响现有挖矿 CLI，新增独立常驻的自动交易进程，实现产出记账后按止盈阈值分批卖出 FCT（DRY_RUN 支持）。

1) 增补 .env（地址全部来自 .env，严禁硬编码）：

```env
# Facet L2 RPC（可省略，默认用 FACET_RPC_URL）
RPC_URL=...

# Uniswap V2 组件地址（FCT/WETH）
ROUTER=0x...
PAIR=0x...
TOKEN_FCT=0x...
TOKEN_WETH=0x...
FCT_DECIMALS=18
WETH_DECIMALS=18

# 交易参数
SLIPPAGE_BPS=100
TAKE_PROFIT=0.12
MIN_TRADE_FCT=1000000000000000000
CHUNK_PCT=0.2
DRY_RUN=true
LEDGER_PATH=./autotrader-ledger.json
POLL_MS=30000
```

2) 启动

```bash
pnpm auto:trade   # DRY_RUN=true 时仅模拟与打印参数，不会发送交易
```

3) 烟囱测试（链路打通）：

```bash
pnpm smoke:swap   # 极小额+宽松滑点，先 simulate 后（可选）write
```

4) 分段测试命令

挖矿侧（互不依赖交易模块）：

```bash
pnpm test:mine:sepolia          # 在 Sepolia 小额挖矿，结束输出 NDJSON 并写入账本
pnpm test:mine:mainnet:dry      # 主网 dry-run，打印 calldata 大小与 data gas 估算
```

交易侧（从账本读取 `inventoryFCT/wacEthPerFCT`）：

```bash
pnpm test:trade:dry             # 仅报价与判定，单行 JSON 输出
pnpm test:trade:smoke           # 主网极小额：simulate 成功后发送并打印 tx_hash
pnpm trade:live                 # 主网实盘小额常驻，指数退避
```

Dry-run 输出示例：

```text
{"px":"1234000000000000","wac":"1100000000000000","hit_tp":true,"reason":"tp_met","amount_in":"24691357800000000000","min_out":"30000000000000000","allowance":"0","balance":"123456789000000000000"}
```

Smoke 成功日志示例：

```text
{"tx_hash":"0xabc...def","gas_used_est":"145000","path":["0x4200…0006","0x1673…4DcE"],"amount_in":"1000000000000000","amount_out_min":"12345"}
```

日志说明：
- [PRICE] 打印 pair 推导价（ETH/FCT）、WAC、库存。
- [TRADE] 在 writeContract 前先 simulateContract；打印 router/pair/token0/1/balance/allowance/amountIn/amountOutMin/deadline/path。
- [ERR] 捕获并打印 BaseError.shortMessage 与 e.walk() 栈；自动指数退避（30s→60s→120s…，上限 10min）。

账本：`LEDGER_PATH`（JSON）包含 `{ inventoryFCT, wacEthPerFCT }` 两字段；成交后仅减少库存，WAC 不变。
```

自动模式相关（若使用 AUTO_MODE）：

```env
AUTO_MODE=true            # 开启自动模式（非交互）
AUTO_LOOP=true            # 自动循环执行
AUTO_DYNAMIC_SIZE=true    # 在 25/50/75/100KB 之间自适应挑选

# 门槛（可选）
MAX_L1_GWEI=...            # L1 Gas 价格上限（gwei）
MAX_COST_PER_FCT_USD=...   # 单枚 FCT 成本上限（美元）
MIN_EFFICIENCY_PERCENT=... # 最低挖矿效率（%）
MIN_BALANCE_ETH=...        # 低于该余额则等待
CHECK_INTERVAL_SEC=60      # 轮询间隔秒数

# 等待放宽策略（可选）
AUTO_RELAX_AFTER_CYCLES=5   # 连续等待 N 次后开始放宽
AUTO_RELAX_STEP_PERCENT=10  # 每个周期放宽比例（%）

# 支出控制（SPEND_MODE=cap 时二选一）
SPEND_CAP_ETH=0.02          # 会话最多花费 ETH
# AUTO_TARGET_TXS=3         # 目标交易笔数（自动推算预算）
```

## How It Works（工作原理）

1. 数据生成：构造优化的挖矿数据载荷
2. Gas 估算：计算 L1 Gas 成本与 FCT 产出
3. 价格分析：从 https://eth-price.facet.org 获取 ETH 实时价格
4. 交易执行：向 Facet Inbox 发送 L1 交易
5. 确认流程：等待 L1 与 Facet 网络确认

## Dashboard Interface（看板界面）

实时看板显示：

- 系统信息：网络、钱包地址（完整便于复制）、余额、ETH 价格
- 挖矿进度：实时交易计数、累计 ETH 消耗、FCT 产出
- 当前交易：状态更新（preparing -> submitting -> confirming -> completed）
- 统计：挖矿速率、FCT 平均成本、预计剩余时间
- 交互元素：可点击的交易哈希，直接打开区块浏览器

## Features（功能特性）

- Interactive Dashboard：交互式看板，实时统计与进度跟踪
- Clean Terminal Interface：清晰的终端界面、彩色状态更新
- Clickable Transaction Hashes：可点击交易哈希（Cmd/Ctrl+点击打开浏览器）
- Multi-Network Support：支持主网/测试网一键切换
- Real-Time Pricing：实时 ETH 价格（Facet API）
- Gas Optimization：高效率（95%+）Gas 使用
- Market Analysis：成本对比与 FDV 估算
- Trading Integration：“兑换 vs 挖矿”对比（主网）
- Robust Error Handling：完善的回退与超时处理
- Flexible Mining Sizes：预设与自定义大小任选
- Spending Controls：预算上限或全额挖矿

## Mining Economics（挖矿经济学）

挖矿器会计算：

- FCT 产出：取决于 L1 calldata 的 Gas 消耗
- 挖矿成本：用于交易费用的 ETH 燃烧量
- 效率：产出相关 Gas 占比（与固定开销对比）
- 市场指标：单枚 FCT 成本、完全稀释估值（FDV）

## Requirements（环境要求）

- Node.js 18+
- pnpm（推荐）或 npm
- 用于支付 Gas 的 ETH（测试网或主网）

提示：若未安装 pnpm，可用 `npm run ...` 代替所有 `pnpm run ...` 命令。也可以先运行 PowerShell 脚本进行自检与初始化：

```powershell
powershell -ExecutionPolicy Bypass -File fct-miner/verify-setup.ps1 -InitEnv -Install -Network sepolia
```

## Best Practice .env（推荐配置示例）

示例 1：测试网稳定运行（建议先用 Sepolia 验证流程）

```env
PRIVATE_KEY=0x...              # 你的钱包私钥
NETWORK=sepolia                # 测试网

GAS_PRICE_MULTIPLIER=1.5       # 提高打包成功率

# 自动模式（非交互）
AUTO_MODE=true
AUTO_LOOP=true
AUTO_DYNAMIC_SIZE=true         # 25/50/75/100KB 自适应

# 观察型门槛（可按需调整）
CHECK_INTERVAL_SEC=30          # 30 秒重评估
MIN_BALANCE_ETH=0.001          # 余额不足则等待（可去 faucet 领）
```

示例 2：主网谨慎运行（成本敏感）

```env
PRIVATE_KEY=0x...
NETWORK=mainnet

GAS_PRICE_MULTIPLIER=1.5

AUTO_MODE=true
AUTO_LOOP=true
AUTO_DYNAMIC_SIZE=true

# 成本/效率门槛（按环境调整，避免过严导致久等）
MAX_COST_PER_FCT_USD=0.005     # 单枚 FCT 成本上限（示例值）
MIN_EFFICIENCY_PERCENT=90      # 至少 90% gas 用于产出

# 等待放宽策略：连等 N 次后，逐步放宽阈值
AUTO_RELAX_AFTER_CYCLES=5
AUTO_RELAX_STEP_PERCENT=10

# 可选：限制总支出（两种方式二选一）
SPEND_CAP_ETH=0.02             # 本次最多花 0.02 ETH
# AUTO_TARGET_TXS=3            # 目标发 3 笔（自动估算所需预算）
```

提示：若默认 RPC 不稳定，可覆盖：

```env
L1_RPC_URL=...
FACET_RPC_URL=...
```

### 环境变量速查（中文）

- 基础必填
  - `PRIVATE_KEY`: 你的钱包私钥（0x+64位十六进制）
  - `NETWORK`: 运行网络 `mainnet` 主网 | `sepolia` 测试网
- 自动模式
  - `AUTO_MODE`/`AUTO_LOOP`: 开启自动模式与循环
  - `AUTO_DYNAMIC_SIZE`: 在候选 KB 内自动择优
  - `AUTO_MIN_SIZE_KB`/`AUTO_MAX_SIZE_KB`: KB 范围；可选步长 `AUTO_SIZE_STEP_KB`（默认 25）
- 预算与上限
  - `SPEND_MODE`: `cap`=按上限预算 | `all`=用全部余额（预留1%）
  - `SPEND_CAP_ETH`: 会话总预算上限（ETH，仅 `cap` 有效）
  - `MINE_MAX_ETH_PER_TX`: 每笔“手续费”上限（ETH），超出则自动“缩KB”
- 气价与估价
  - `MAX_L1_GWEI`: L1 气价上限（gwei）；`MINE_L1_BASEFEE_MAX_GWEI`（可选 baseFee 上限）
  - `CHECK_INTERVAL_SEC`: 等待/轮询间隔（秒）
  - `GAS_PRICE_MULTIPLIER`: 气价乘数（默认 1.5）；或改用 `USE_NODE_GAS=true`
  - `GAS_PRICE_FLOOR_GWEI`: 气价地板，避免过低长时间 pending
- 成本/效率闸
  - `MAX_COST_PER_FCT_USD`: 单枚 FCT 成本上限（美元）
  - `MIN_EFFICIENCY_PERCENT`: 最低效率（%）
  - `DYNAMIC_COST_GATE`/`DYNAMIC_WINDOW_PCT`: 启用“期望成本”动态窗口闸（如 0.05=+5%）
- 演练与日志
  - `DRY_RUN`: 演练模式（不发交易，仅打印估算）
  - `STOP_ON_TX_FAIL`: 失败是否停止会话
  - `NO_CLEAR`/`PLAIN_UI`: 控制台清屏 / 纯文本 UI
- 干跑测试（不发交易）
  - `TEST_MINE_KB`: 干跑的 KB；或命令行使用 `--kb`（支持小数）/`--bytes`（精确字节）
  - 干跑会输出 `data_gas_est` 与中文行“fee≈…（≈…U）”
- 自动卖出（Auto-trader）
  - `TAKE_PROFIT`: 止盈阈值（相对 WAC，如 0.12=+12%）
  - `SLIPPAGE_BPS`: 滑点（基点），200=2%
  - `CHUNK_PCT`: 每次卖出的库存比例（0~1）
  - `MIN_TRADE_FCT`: 最小成交数量（FCT wei）
  - `POLL_MS`: 轮询间隔（毫秒）
- 时序策略（回退）
  - `USE_FCT_TIMING`: 启用时机判定（缺索引器时）
  - `MAX_PROGRESS_TO_MINE`/`MIN_BLOCKS_LEFT`/`ALPHA`: 时机与回推上限参数
  - `TARGET_FCT_WEI`/`MINTED_FCT_WEI`: 回退目标/已挖（FCT-wei）
- DEX 地址（主网）
  - `ROUTER`/`PAIR`: 路由/交易对
  - `TOKEN_FCT`/`TOKEN_WETH`: 代币地址（WFCT/WETH）
  - `ROUTER_WETH`: （可选）覆盖路由读取到的 WETH 地址
  - `RPC_URL`: Facet L2 RPC（交易侧优先）
- 其他可选（进阶）
  - `VALUE_ETH`: 挖矿“本金”（ETH，发送给 Facet；与 gas 不同）
  - `GWEI_MIN`/`GWEI_MAX`: 气价上下界（gwei），越界则跳过
  - `CAP_ETH`: 若预计 `fee+value` 超出，则跳过
  - `GWEI_HARD_CEILING`: 放宽时的气价硬帽（gwei）
  - `MAX_CYCLE_SHARE`: 单轮最多占用比例（自动上限）
  - `EDGE_WARN_USD`/`COOLDOWN_MIN`: 回执复盘判弱与冷却分钟数

## FAQ / Troubleshooting（常见问题与排查）

- pnpm 未安装，提示“pnpm 不是内部或外部命令”
  - 用 npm 代替：在 `fct-miner` 目录执行 `npm install`，再 `npm run mine:sepolia` / `npm run mine:mainnet`
  - 或安装 pnpm：`corepack enable && corepack prepare pnpm@10.11.0 --activate`，或 `npm i -g pnpm`

- 一直提示 Waiting（等待）
  - 开启自适应与放宽：`AUTO_DYNAMIC_SIZE=true`，设置 `AUTO_RELAX_AFTER_CYCLES` 与 `AUTO_RELAX_STEP_PERCENT`
  - 放宽门槛：适度提高 `MAX_L1_GWEI` / `MAX_COST_PER_FCT_USD` 或降低 `MIN_EFFICIENCY_PERCENT`
  - 缩短轮询：`CHECK_INTERVAL_SEC=30`

- 余额不足导致等待
  - 充值 ETH；或临时降低 `MIN_BALANCE_ETH`

- 交易长期 Pending 或确认慢
  - 略增 `GAS_PRICE_MULTIPLIER`（如 1.6~1.8）；检查当下 L1 Gas；更换更稳的 `L1_RPC_URL`

- 收不到价格数据（ETH 价格 API 报错）
  - 程序会使用回退价格（默认 3500）；可稍微放宽 `MAX_COST_PER_FCT_USD` 以避免误判

- Windows PowerShell 执行策略限制
  - 用一次性绕过：`powershell -ExecutionPolicy Bypass -File ...`

- 切换网络
  - `npm run network:sepolia` 或 `npm run network:mainnet`，或直接编辑 `.env` 的 `NETWORK`

- 覆盖/自定义 RPC
  - 在 `.env` 设置 `L1_RPC_URL`、`FACET_RPC_URL`

- 单笔失败就停止
  - 设置 `STOP_ON_TX_FAIL=false` 可在失败后继续下一笔（默认 true）

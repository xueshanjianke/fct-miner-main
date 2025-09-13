import chalk from "chalk";
import { createSpinner } from "nanospinner";
import { formatEther, formatGwei, createPublicClient, http } from "viem";
import { getLatestEthPerFctViaEvents, watchPairPrice } from "./autotrader/pricing";
import { getNetworkConfig } from "./config.js";
import { getFctMintRate } from "@0xfacet/sdk/utils";

// ------------------------------
// 文件概述（中文注释）
// ------------------------------
// 实时挖矿看板：展示系统/会话统计、当前交易状态、进度与速率等。
// 提供动画与倒计时辅助输出，便于观察挖矿进展。

interface MiningStats {
  totalTransactions: number;
  totalETHSpent: bigint;
  totalFCTMinted: bigint;
  remainingBudget: bigint;
  sessionTarget: bigint;
  currentBalance: bigint;
  ethPrice: number;
  avgCostPerFCT: number;
  estimatedTimeLeft: string;
  miningRate: number; // FCT per hour
  walletAddress?: string; // for live balance fetch
  lastGasUsed?: bigint;
  lastGasPrice?: bigint;
  // 实时市场价格（事件优先，储备回退）
  marketEthPerFctFp18?: bigint;
  marketUsd?: number;
  priceSource?: 'sync' | 'swap' | 'fallback';
  slippageBps?: number;
}

interface TransactionProgress {
  current: number;
  total: number;
  status: "preparing" | "submitting" | "confirming" | "completed" | "failed";
  ethCost: bigint;
  fctMinted: bigint;
  hash?: string;
}

// 挖矿看板类：维护会话统计并负责渲染
export class MiningDashboard {
  private stats: MiningStats;
  private currentTx: TransactionProgress | null = null;
  private startTime: number = Date.now();
  private intervalId: NodeJS.Timeout | null = null;
  private l1Client = createPublicClient({ chain: getNetworkConfig().l1Chain, transport: http(getNetworkConfig().l1RpcUrl) });
  private facetClient = createPublicClient({ chain: getNetworkConfig().facetChain, transport: http(getNetworkConfig().facetRpcUrl) });
  private lastBalanceFetch = 0;
  private cachedL1Eth: bigint = 0n;
  private cachedL2Fct: bigint = 0n;
  private unwatchPrice: (() => void) | null = null;

  // 初始化统计信息（允许覆盖默认值）
  constructor(initialStats: Partial<MiningStats>) {
    this.stats = {
      totalTransactions: 0,
      totalETHSpent: 0n,
      totalFCTMinted: 0n,
      remainingBudget: 0n,
      sessionTarget: 0n,
      currentBalance: 0n,
      ethPrice: 0,
      avgCostPerFCT: 0,
      estimatedTimeLeft: "calculating...",
      miningRate: 0,
      ...initialStats,
    };
  }

  // 启动画面与定时刷新
  start() {
    this.render();
    this.startLiveUpdates();
  }

  // 停止定时刷新
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.unwatchPrice) {
      try { this.unwatchPrice(); } catch {}
      this.unwatchPrice = null;
    }
  }

  // 更新会话统计并重新计算派生指标
  updateStats(newStats: Partial<MiningStats>) {
    this.stats = { ...this.stats, ...newStats };
    this.calculateDerivedStats();
  }

  // 开始跟踪一笔交易，预估本会话预计总笔数（按目标预算/单笔成本粗估）
  startTransaction(txData: Omit<TransactionProgress, "current" | "total">) {
    this.currentTx = {
      current: this.stats.totalTransactions + 1,
      total: Math.ceil(
        Number(this.stats.sessionTarget) / Number(txData.ethCost)
      ),
      ...txData,
    };
  }

  // 更新当前交易的状态/哈希/产出等
  updateTransaction(updates: Partial<TransactionProgress>) {
    if (this.currentTx) {
      this.currentTx = { ...this.currentTx, ...updates };
    }
  }

  // 完成一笔交易：累加统计、扣减预算/余额，并清空当前交易
  completeTransaction(ethSpent: bigint, fctMinted: bigint) {
    this.stats.totalTransactions++;
    this.stats.totalETHSpent += ethSpent;
    this.stats.totalFCTMinted += fctMinted;
    this.stats.remainingBudget -= ethSpent;
    this.stats.currentBalance -= ethSpent;
    this.currentTx = null;
    this.calculateDerivedStats();
  }

  // 计算派生指标：FCT 产出速率、平均成本、预计剩余时间等
  private calculateDerivedStats() {
    const elapsedHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
    this.stats.miningRate =
      elapsedHours > 0
        ? Number(formatEther(this.stats.totalFCTMinted)) / elapsedHours
        : 0;

    if (this.stats.totalFCTMinted > 0n) {
      const totalSpentUSD =
        Number(formatEther(this.stats.totalETHSpent)) * this.stats.ethPrice;
      this.stats.avgCostPerFCT =
        totalSpentUSD / Number(formatEther(this.stats.totalFCTMinted));
    }

    // Estimate time left based on current rate
    if (this.stats.miningRate > 0 && this.stats.remainingBudget > 0n) {
      const remainingETH = Number(formatEther(this.stats.remainingBudget));
      const estimatedETHPerHour =
        Number(formatEther(this.stats.totalETHSpent)) / elapsedHours;
      const hoursLeft =
        estimatedETHPerHour > 0 ? remainingETH / estimatedETHPerHour : 0;

      if (hoursLeft < 1) {
        this.stats.estimatedTimeLeft = `${Math.round(hoursLeft * 60)}m`;
      } else {
        this.stats.estimatedTimeLeft = `${Math.round(hoursLeft)}h ${Math.round(
          (hoursLeft % 1) * 60
        )}m`;
      }
    }
  }

  // 定时刷新看板
  private startLiveUpdates() {
    // 启动价格订阅（一次）
    if (!this.unwatchPrice) {
      try {
        watchPairPrice((u) => {
          this.stats.marketEthPerFctFp18 = u.ethPerFctFp18;
          this.stats.priceSource = u.source;
          this.stats.slippageBps = u.slippageBps;
          if (this.stats.ethPrice && this.stats.marketEthPerFctFp18 != null) {
            const ethPerFct = Number(this.stats.marketEthPerFctFp18) / 1e18;
            this.stats.marketUsd = ethPerFct * this.stats.ethPrice;
          }
        }).then((un) => { this.unwatchPrice = un; }).catch(() => {});
        // 预热一次（最近事件/回退）
        getLatestEthPerFctViaEvents(1000).then((ev) => {
          this.stats.marketEthPerFctFp18 = ev.ethPerFctFp18;
          this.stats.priceSource = ev.source;
          this.stats.slippageBps = ev.slippageBps;
          if (this.stats.ethPrice) {
            const ethPerFct = Number(ev.ethPerFctFp18) / 1e18;
            this.stats.marketUsd = ethPerFct * this.stats.ethPrice;
          }
        }).catch(() => {});
      } catch {}
    }

    this.intervalId = setInterval(() => {
      this.calculateDerivedStats();
      this.render();
    }, 1000);
  }

  // 渲染整页（头/进度/统计/当前交易/页脚）
  private render() {
    { const NO_CLEAR = String(process.env.NO_CLEAR || "").toLowerCase() === "true"; if (!NO_CLEAR) console.clear(); }
    this.renderHeader();
    // 在头部下方标注 L1 网络类型（主网/测试网）
    try {
      const net = (getNetworkConfig && getNetworkConfig()) || null;
      const n = (net && net.l1Chain && net.l1Chain.name) ? String(net.l1Chain.name).toLowerCase() : "";
      const l1Label = n.includes("sepolia") ? "测试网 (Sepolia)" : "主网 (Mainnet)";
      console.log(`${chalk.gray("L1 网络:")} ${chalk.yellow.bold(l1Label)}`);
      if (this.stats.lastGasUsed != null && this.stats.lastGasPrice != null) {
        const gasWei = (this.stats.lastGasUsed ?? 0n) * (this.stats.lastGasPrice ?? 0n);
        const gasEth = Number(formatEther(gasWei));
        const gasUsd = gasEth * this.stats.ethPrice;
        console.log(`${chalk.gray("上次成本:")} ${chalk.yellow.bold(gasEth.toFixed(6))} ETH (${chalk.yellow.bold("$" + gasUsd.toFixed(2))})`);
      }
    } catch {}
    this.renderProgress();
    this.renderStats();
    this.renderCurrentTransaction();
    this.renderFooter();
  }

  // 标题栏：网络与版本装饰
  private renderHeader() {
    const PLAIN = String(process.env.PLAIN_UI || "").toLowerCase() === "true";
    if (PLAIN) {
      const borderWidth = 79;
      const text = "FCT MINER v2.0";
      const padding = Math.floor((borderWidth - text.length) / 2);
      const remainder = borderWidth - text.length - padding;
      const centeredText = " ".repeat(padding) + text + " ".repeat(remainder);
      const top = "+" + "-".repeat(borderWidth) + "+";
      const mid = "|" + centeredText + "|";
      console.log(chalk.hex("#00FF00")(top));
      console.log(chalk.hex("#00FF88")(mid));
      console.log(chalk.hex("#00FF00")(top));
      return;
    }
    const borderWidth = 79;
    const text = "FCT MINER v2.0";
    const padding = Math.floor((borderWidth - text.length) / 2);
    const remainder = borderWidth - text.length - padding;
    const centeredText = " ".repeat(padding) + text + " ".repeat(remainder);

    console.log(chalk.hex("#00FF00")("╔" + "═".repeat(borderWidth) + "╗"));
    console.log(
      chalk.hex("#00FF00")("║") +
        chalk.hex("#00FF88").bold(centeredText) +
        chalk.hex("#00FF00")("║")
    );
    console.log(chalk.hex("#00FF00")("╚" + "═".repeat(borderWidth) + "╝"));
  }

  // 预算进度条（已花费 / 目标）
  private renderProgress() {
    const progressWidth = 60;
    const spent = Number(formatEther(this.stats.totalETHSpent));
    const target = Number(formatEther(this.stats.sessionTarget));
    const progress = target > 0 ? Math.min(spent / target, 1) : 0;

    const filled = Math.round(progress * progressWidth);
    const empty = progressWidth - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    const percentage = Math.round(progress * 100);

    console.log(`\n${chalk.cyan("进度:")} ${chalk.yellow(percentage + "%")}`);
    console.log(`${chalk.green(bar)}`);
    console.log(
      `${chalk.white(
        formatEther(this.stats.totalETHSpent).slice(0, 8)
      )} / ${chalk.white(
        formatEther(this.stats.sessionTarget).slice(0, 8)
      )} ETH`
    );
  }

  // 会话统计：交易数、余额、ETH/FCT 累计、均价与速率
  private renderStats() {
    console.log(`\n${chalk.cyan("挖矿统计:")}`);

    // Live wallet balances (L1 ETH / L2 FCT)
    if (this.stats.walletAddress) {
      const now = Date.now();
      if (now - this.lastBalanceFetch > 5000) {
        this.lastBalanceFetch = now;
        const addr = this.stats.walletAddress as `0x${string}`;
        Promise.allSettled([
          this.l1Client.getBalance({ address: addr }),
          this.facetClient.getBalance({ address: addr }),
        ]).then((res) => {
          if (res[0].status === "fulfilled") this.cachedL1Eth = res[0].value as bigint;
          if (res[1].status === "fulfilled") this.cachedL2Fct = res[1].value as bigint;
        }).catch(() => {});
      }
      const fmt6 = (wei: bigint) => {
        const s = formatEther(wei);
        const [i, f = ""] = s.split(".");
        const n = Number(s);
        if (n > 0 && n < 1e-6) return "<0.000001";
        return i + "." + f.padEnd(6, "0").slice(0, 6);
      };
      const cfg = getNetworkConfig();
      const l1Label = `${cfg.l1Chain.name}`;
      console.log(`  ${chalk.white(`L1(${l1Label}) ETH 余额:`)} ${chalk.yellow.bold(fmt6(this.cachedL1Eth))} ETH`);
      console.log(`  ${chalk.white("L2 FCT 余额:")} ${chalk.magenta.bold(fmt6(this.cachedL2Fct))} FCT`);
    }

    console.log(`  交易笔数: ${chalk.green.bold(this.stats.totalTransactions)}`);
    const fmt6 = (wei: bigint) => {
      const s = formatEther(wei);
      const [i, f = ""] = s.split(".");
      return i + "." + f.padEnd(6, "0").slice(0, 6);
    };
    console.log(`  ${chalk.white("会话余额(估算):")} ${chalk.yellow.bold(fmt6(this.stats.currentBalance))} ETH`);
    console.log(`  已花费 ETH: ${chalk.red.bold(formatEther(this.stats.totalETHSpent).slice(0, 8))} ETH`);
    console.log(`  ETH 价格: ${chalk.green.bold("$" + this.stats.ethPrice.toFixed(0))}`);
    // 市场价格（ETH/FCT 与 USD）
    if (this.stats.marketEthPerFctFp18 != null) {
      const ethPerFct = Number(this.stats.marketEthPerFctFp18) / 1e18;
      const usd = (this.stats.ethPrice || 0) * ethPerFct;
      const src = this.stats.priceSource === 'swap' ? chalk.yellow('SWAP') : this.stats.priceSource === 'sync' ? chalk.cyan('SYNC') : chalk.gray('FALLBACK');
      const slip = this.stats.slippageBps != null ? `  slip=${this.stats.slippageBps}bps` : '';
      console.log(`  市场价格: ETH/FCT=${chalk.white(ethPerFct.toFixed(8))}  (~${chalk.green("$" + usd.toFixed(6))})  ${src}${slip}`);
    }
    console.log(`  已挖 FCT: ${chalk.magenta.bold(formatEther(this.stats.totalFCTMinted).slice(0, 8))} FCT`);
    console.log(`  平均成本: ${chalk.yellow.bold("$" + this.stats.avgCostPerFCT.toFixed(3) + "/FCT")}`);
    console.log(`  速率: ${chalk.cyan.bold(this.stats.miningRate.toFixed(1) + " FCT/小时")}`);
    console.log(`  预计剩余: ${chalk.blue.bold(this.stats.estimatedTimeLeft)}`);

    // 最近一次 Gas（若可用）
    if (this.stats.lastGasUsed != null && this.stats.lastGasPrice != null) {
      const gasWei = (this.stats.lastGasUsed ?? 0n) * (this.stats.lastGasPrice ?? 0n);
      const gasEth = Number(formatEther(gasWei));
      const gasUsd = gasEth * this.stats.ethPrice;
      console.log(
        `  ${chalk.white("最近一次 Gas:")} ${chalk.yellow.bold((this.stats.lastGasUsed ?? 0n).toString())} gas @ ${chalk.yellow.bold(formatGwei(this.stats.lastGasPrice ?? 0n))} gwei  ≈ ${chalk.yellow.bold(gasEth.toFixed(6))} ETH (${chalk.yellow.bold("$" + gasUsd.toFixed(2))})`
      );
    }
  }

  // 当前交易：状态、可点击哈希、产出等
  private renderCurrentTransaction() {
    if (!this.currentTx) {
      console.log(`\n${chalk.gray("Waiting for next transaction...")}`);
      return;
    }

    const statusColors = {
      preparing: chalk.blue,
      submitting: chalk.yellow,
      confirming: chalk.magenta,
      completed: chalk.green,
      failed: chalk.red,
    };

    const statusTexts = {
      preparing: "Preparing",
      submitting: "Submitting",
      confirming: "Confirming",
      completed: "Completed",
      failed: "Failed",
    };

    console.log(`\n${chalk.cyan("Transaction #" + this.currentTx.current)}`);
    console.log(
      `  Status: ${statusColors[this.currentTx.status](
        statusTexts[this.currentTx.status]
      )}`
    );

    if (this.currentTx.hash) {
      const networkConfig = getNetworkConfig();
      const explorerUrl = `${networkConfig.facetChain.blockExplorers.default.url}/tx/${this.currentTx.hash}`;
      const shortHash =
        this.currentTx.hash.slice(0, 10) +
        "..." +
        this.currentTx.hash.slice(-8);

      // Make the hash clickable with OSC 8 escape sequences for modern terminals
      const clickableHash = `\u001b]8;;${explorerUrl}\u001b\\${chalk.blue(
        shortHash
      )}\u001b]8;;\u001b\\`;
      console.log(`  Hash: ${clickableHash}`);
    }

    if (
      this.currentTx.status === "completed" &&
      this.currentTx.fctMinted > 0n
    ) {
      console.log(
        `  FCT Mined: ${chalk.green.bold(
          formatEther(this.currentTx.fctMinted).slice(0, 8)
        )} FCT`
      );
    }
  }

  // 页脚：运行时长与退出提示
  private renderFooter() {
    const runtime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    const seconds = runtime % 60;

    const uptime = `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

    console.log(
      `\n${chalk.gray("Uptime:")} ${chalk.cyan(uptime)} | ${chalk.gray(
        "Press Ctrl+C to stop"
      )}`
    );
  }

  // Animation helpers
  // 简易动画：轮播状态帧
  showMiningAnimation() {
    const frames = ["◐", "◓", "◑", "◒"];
    let frameIndex = 0;

    return setInterval(() => {
      process.stdout.write(
        `\r${chalk.cyan(frames[frameIndex])} ${chalk.red(
          "BREACH_IN_PROGRESS"
        )}... `
      );
      frameIndex = (frameIndex + 1) % frames.length;
    }, 150);
  }

  // 简易倒计时：显示距下一笔交易的剩余秒数
  showCountdown(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      let remaining = seconds;
      const countdownInterval = setInterval(() => {
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          process.stdout.write(`\r${" ".repeat(50)}\r`);
          resolve();
          return;
        }

        process.stdout.write(
          `\r${chalk.cyan("Next transaction in:")} ${chalk.yellow.bold(
            remaining
          )}s`
        );
        remaining--;
      }, 1000);
    });
  }
}

// 读取并封装当前挖矿状态（用于策略模块）
export async function getMintState(): Promise<{
  rateNow: bigint;
  target: bigint;
  minted: bigint;
  blocksElapsed: number;
}> {
  const cfg = getNetworkConfig();
  const facetClient = createPublicClient({ chain: cfg.facetChain, transport: http(cfg.facetRpcUrl) });
  const [rateNow, block] = await Promise.all([
    getFctMintRate(cfg.l1Chain.id),
    facetClient.getBlock({}),
  ]);
  const epoch = Number(process.env.EPOCH_BLOCKS ?? 500);
  const blocksElapsed = Number(block.number ?? 0n) % Math.max(1, epoch);
  const target = process.env.TARGET_FCT_WEI ? BigInt(process.env.TARGET_FCT_WEI) : 0n;
  const minted = process.env.MINTED_FCT_WEI ? BigInt(process.env.MINTED_FCT_WEI) : 0n;
  return { rateNow, target, minted, blocksElapsed };
}

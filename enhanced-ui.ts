import chalk from "chalk";

// ------------------------------
// 文件概述（中文注释）
// ------------------------------
// 终端 UI 辅助：封装常用的输出样式（标题/系统信息/选项等），
// 用以替代零散的 console.log，保持界面一致性与可读性。

// Enhanced logging functions to replace console.log calls
export const ui = {
  // Clear screen and show animated header
  showHeader: (network?: string, wallet?: string) => {
    // 清屏并输出头部装饰（版本/主题边框）
    const NO_CLEAR = String(process.env.NO_CLEAR || "").toLowerCase() === "true";
    if (!NO_CLEAR) console.clear();

    const borderWidth = 79;
    const text = "FCT MINER v2.0";
    const padding = Math.floor((borderWidth - text.length) / 2);
    const remainder = borderWidth - text.length - padding;
    const centeredText = " ".repeat(padding) + text + " ".repeat(remainder);

    // Plain ASCII UI to avoid garbled borders on some consoles
    const PLAIN = String(process.env.PLAIN_UI || "").toLowerCase() === "true";
    if (PLAIN) {
      const top = "+" + "-".repeat(borderWidth) + "+";
      const mid = "|" + centeredText + "|";
      console.log(chalk.hex("#00FF00")(top));
      console.log(chalk.hex("#00FF88")(mid));
      console.log(chalk.hex("#00FF00")(top));
      console.log("");
      return;
    }

    console.log(chalk.hex("#00FF00")("╔" + "═".repeat(borderWidth) + "╗"));
    console.log(
      chalk.hex("#00FF00")("║") +
        chalk.hex("#00FF88").bold(centeredText) +
        chalk.hex("#00FF00")("║")
    );
    console.log(chalk.hex("#00FF00")("╚" + "═".repeat(borderWidth) + "╝"));
    console.log("");
  },

  showSystemInfo: (
    network?: string,
    wallet?: string,
    balance?: string, // L1 ETH
    ethPrice?: number,
    balanceUsd?: number,
    fctBalance?: string // L2 FCT
  ) => {
    // 显示系统信息：网络/地址/余额/价格/折算美元
    console.log(chalk.cyan("系统信息 System Info:"));

    if (network) {
      console.log(`  网络 Network: ${chalk.yellow.bold(network)}`);
    }

    if (wallet) {
      console.log(`  钱包地址 Wallet: ${chalk.white(wallet)}`);
    }

    if (balance) console.log(`  钱包 L1 ETH 余额: ${chalk.green.bold(balance + " ETH")}`);
    if (fctBalance) console.log(`  钱包 L2 FCT 余额: ${chalk.magenta.bold(fctBalance + " FCT")}`);

    if (ethPrice) {
      console.log(
        `  ETH 价格 Price: ${chalk.green.bold("$" + ethPrice.toFixed(2))}`
      );
    }

    if (balanceUsd) {
      console.log(
        `  余额折美元 Balance USD: ${chalk.yellow.bold("$" + balanceUsd.toFixed(2))}`
      );
    }

    console.log("");
  },

  showMiningOptions: () => {
    // 挖矿大小选择提示
    console.log(chalk.cyan("选择挖矿大小 Select Mining Size:"));
    console.log(chalk.gray("每笔交易的 calldata 大小 | How much calldata to use per transaction:"));
    console.log("");
  },

  showMiningSelection: (label: string, size: string) => {
    // 展示已选的挖矿大小
    console.log(
      `${chalk.green("已选择 Selected:")} ${chalk.white.bold(
        label + " (" + size + ") 挖矿 mining"
      )}`
    );
    console.log("");
  },

  showSpendingOptions: (costEth: string, costUsd: string) => {
    // 展示预算选项与单笔成本提示
    console.log(chalk.cyan("支出选项 Spending Options:"));
    console.log(
      chalk.gray(`预计每笔成本 ~${costEth} ETH (${costUsd}) | Each tx ~${costEth} ETH (${costUsd})`)
    );
    console.log(
      `  ${chalk.yellow("1.")} ${chalk.white("花费全部 ETH | Spend ALL ETH in wallet")}`
    );
    console.log(`  ${chalk.yellow("2.")} ${chalk.white("设置支出上限 | Set a spending cap")}`);
    console.log("");
  },

  showSpendingChoice: (choice: string, details?: string) => {
    // 展示最终的预算选择（全额/封顶）
    if (choice === "all") {
      console.log(
        `${chalk.green("将花费全部 ETH | Will spend ALL ETH")} ${chalk.gray(details || "")}`
      );
    } else {
      console.log(
        `${chalk.green("最多花费 | Will spend up to")} ${chalk.yellow.bold(details || "")}`
      );
    }
    console.log("");
  },

  // 实时价格输出（事件/储备回退）
  showPriceUpdate: (params: { source: 'sync' | 'swap' | 'fallback'; ethPerFctFp18: bigint; slippageBps?: number }) => {
    try {
      const { source, ethPerFctFp18, slippageBps } = params;
      const src = source === 'swap' ? chalk.yellow('SWAP') : source === 'sync' ? chalk.cyan('SYNC') : chalk.gray('FALLBACK');
      const ethPerFct = Number(ethPerFctFp18) / 1e18;
      const priceStr = isFinite(ethPerFct) ? ethPerFct.toFixed(8) : '0';
      const slipStr = (slippageBps == null) ? '' : `  slip=${slippageBps}bps`;
      console.log(`${chalk.green('[MARKET]')} ${src}  ETH/FCT=${chalk.white(priceStr)}${slipStr}`);
    } catch {}
  },
};

export default ui;

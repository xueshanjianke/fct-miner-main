import {
  createWalletClient,
  createPublicClient,
  http,
  formatEther,
  formatGwei,
  toBytes,
  toHex,
  maxUint256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as dotenv from "dotenv";
import * as readline from "readline";
import {
  computeFacetTransactionHash,
  getFctMintRate,
  sendRawFacetTransaction,
} from "@0xfacet/sdk/utils";
import { FACET_INBOX_ADDRESS } from "@0xfacet/sdk/constants";
import { compareMiningVsSwapping, getSwapQuote } from "./facet-swapper";
import { getNetworkConfig, getCurrentNetwork, isMainnet, STRATEGY } from "./config";
import ui from "./enhanced-ui";
import { getLatestEthPerFctViaEvents, watchPairPrice } from "./autotrader/pricing";
import { MiningDashboard } from "./mining-dashboard";
import chalk from "chalk";

// CLI helper: read --flag or --flag=value
function cliArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (idx === -1) return undefined;
  const tok = process.argv[idx];
  if (tok.includes("=")) return tok.split("=")[1];
  return process.argv[idx + 1];
}


async function assertL1ContextAndBalance() {
  // 1) 鎵撳嵃鍦板潃 + 閾綢D + RPC锛岀‘璁よ鐨勬槸璋併€佸湪鍝潯閾?
  const [chainId, addr, bal] = await Promise.all([
    publicClient.getChainId(),
    Promise.resolve(account.address),
    publicClient.getBalance({ address: account.address, blockTag: "latest" }), // 寮哄埗 latest
  ]);

  console.log("[BALANCE] address =", addr);
  console.log("[BALANCE] l1RpcUrl =", networkConfig.l1RpcUrl);
  console.log("[BALANCE] chainId =", chainId, " expected =", networkConfig.l1Chain.id);
  console.log("[BALANCE] value(ETH) =", formatEther(bal));

  // 2) 閾綢D涓嶄竴鑷寸洿鎺ユ姤璀︼紙姣斿浣犱互涓烘槸 mainnet锛屽疄闄呰繛浜?sepolia锛?
  if (chainId !== networkConfig.l1Chain.id) {
    /*
    console.log(
      chalk.red(
        `鈿狅笍  褰撳墠杩炴帴鐨勯摼ID=${chainId}锛屼絾閰嶇疆鏈熸湜=${networkConfig.l1Chain.id}銆傝妫€鏌?getNetworkConfig()/L1_RPC_URL 鏄惁鎸囧悜浜嗘纭綉缁溿€俙
      )
    );
    */
  }
  return bal;
}


dotenv.config();
startMarketTickerIfEnabled();

// ------------------------------
// 鏂囦欢姒傝堪锛堜腑鏂囨敞閲婏級
// ------------------------------
// 杩欐槸涓€涓敤浜庢寲鎺?FCT锛團acet Compute Token锛夌殑 CLI 宸ュ叿銆?
// - 鏀寔浜や簰妯″紡涓庤嚜鍔ㄦā寮忥紙AUTO_MODE锛?
// - 鍦ㄤ互澶潑 L1 涓婂彂閫佹惡甯?mineBoost 鏁版嵁鐨勪氦鏄擄紝浠庤€屽湪 Facet L2 渚ц幏寰?FCT 閾搁€?
// - 鍐呯疆瀹炴椂鐪嬫澘锛圡iningDashboard锛夛紝灞曠ず浣欓銆佽繘搴︺€佸崟娆?骞冲潎鎴愭湰绛?
// - 鑷姩妯″紡鍙寜闃堝€硷紙gas 浠锋牸/鏁堢巼/鎴愭湰锛変笌鈥滄斁瀹界瓥鐣モ€濊繘琛岃嚜閫傚簲绛夊緟涓庢墽琛?
//
// 鍏抽敭娴佺▼锛氫及绠楁垚鏈?-> 鍙戦€?L1 浜ゆ槗 -> 绛夊緟 Facet 纭 -> 缁熻涓庡睍绀虹粨鏋?
// 涓昏澶栭儴渚濊禆锛歷iem锛堥摼浜や簰锛夈€丂0xfacet/sdk锛堝彂閫?Facet 浜ゆ槗锛夈€乨otenv锛堢幆澧冨彉閲忥級

// Get network configuration
const networkConfig = getNetworkConfig();
const VALUE_ETH = Number(process.env.VALUE_ETH || cliArg("--value-eth") || "0");
const GWEI_MIN = process.env.GWEI_MIN ? Number(process.env.GWEI_MIN) : (cliArg("--gwei-min") ? Number(cliArg("--gwei-min")) : undefined);
const GWEI_MAX = process.env.GWEI_MAX ? Number(process.env.GWEI_MAX) : (cliArg("--gwei-max") ? Number(cliArg("--gwei-max")) : undefined);
const CAP_ETH = process.env.CAP_ETH ? Number(process.env.CAP_ETH) : (cliArg("--cap-eth") ? Number(cliArg("--cap-eth")) : undefined);

// -------- Auto-mode helpers --------
function envBool(name: string, def = false): boolean {
  // 璇诲彇甯冨皵鍨嬬幆澧冨彉閲忥紝鏀寔锛?/true/yes/y 涓?0/false/no/n
  const v = (process.env[name] || "").toLowerCase().trim();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return def;
}

function envNumber(name: string, def?: number): number | undefined {
  // 璇诲彇 number 鍨嬬幆澧冨彉閲忥紙鍙负绌鸿繑鍥為粯璁わ級
  const v = process.env[name];
  if (v == null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function envInt(name: string, def?: number): number | undefined {
  // 璇诲彇鏁存暟鍨嬬幆澧冨彉閲忥紙鍙负绌鸿繑鍥為粯璁わ級
  const v = process.env[name];
  if (v == null || v.trim() === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// 鑷姩妯″紡涓庨槇鍊兼帶鍒讹紙鏉ヨ嚜 .env 鐨勫彲閫夐」锛?
const AUTO_MODE = envBool("AUTO_MODE", false);
const AUTO_LOOP = envBool("AUTO_LOOP", false);
const AUTO_SIZE_KB = envNumber("SIZE_KB", 100) as number; // default 100KB
const AUTO_SPEND_MODE = (process.env.SPEND_MODE || "cap").toLowerCase(); // 'all' | 'cap'
const AUTO_SPEND_CAP_ETH = envNumber("SPEND_CAP_ETH"); // required if mode=cap
const AUTO_TARGET_TXS = envInt("AUTO_TARGET_TXS"); // optional: derive cap from N txs
const MAX_L1_GWEI = envNumber("MAX_L1_GWEI");
const MAX_COST_PER_FCT_USD = envNumber("MAX_COST_PER_FCT_USD");
const MIN_EFFICIENCY_PERCENT = envNumber("MIN_EFFICIENCY_PERCENT");
const MIN_BALANCE_ETH = envNumber("MIN_BALANCE_ETH");
const CHECK_INTERVAL_SEC = envNumber("CHECK_INTERVAL_SEC", 60) as number;
const STOP_ON_TX_FAIL = envBool("STOP_ON_TX_FAIL", true);

// L1 gas 中文门控 + 单笔上限（可选）
const MINE_L1_GWEI_MIN = envNumber("MINE_L1_GWEI_MIN");
const MINE_L1_GWEI_MAX = envNumber("MINE_L1_GWEI_MAX");
const MINE_L1_BASEFEE_MAX_GWEI = envNumber("MINE_L1_BASEFEE_MAX_GWEI");
const MINE_L1_CHECK_INTERVAL_SEC = envInt("MINE_L1_CHECK_INTERVAL_SEC", 60) as number;
const MINE_L1_MAX_WAIT_SEC = envInt("MINE_L1_MAX_WAIT_SEC", 180) as number; // 默认3分钟
const MINE_MAX_ETH_PER_TX = envNumber("MINE_MAX_ETH_PER_TX"); // ETH

// Auto-tuning controls
// 鑷€傚簲閫夋嫨澶у皬涓庘€滅瓑寰呮斁瀹解€濈瓥鐣ユ帶鍒?
const AUTO_DYNAMIC_SIZE = envBool("AUTO_DYNAMIC_SIZE", true);
const AUTO_RELAX_AFTER_CYCLES = (envInt("AUTO_RELAX_AFTER_CYCLES", 5) as number) || 5;
const AUTO_RELAX_STEP_PERCENT = (envNumber("AUTO_RELAX_STEP_PERCENT", 10) as number) || 10; // each extra cycle
const AUTO_MIN_SIZE_KB = (envInt("AUTO_MIN_SIZE_KB", 25) as number) || 25;
const AUTO_MAX_SIZE_KB = (envInt("AUTO_MAX_SIZE_KB", 100) as number) || 100;
const AUTO_SIZE_STEP_KB = (envInt("AUTO_SIZE_STEP_KB", 25) as number) || 25;

// Optional caps/toggles
const GWEI_HARD_CEILING = envNumber("GWEI_HARD_CEILING");
const MAX_CYCLE_SHARE = envNumber("MAX_CYCLE_SHARE");
const EDGE_WARN_USD = envNumber("EDGE_WARN_USD", 10);
const COOLDOWN_MIN = envNumber("COOLDOWN_MIN", 30);

// Lightweight market smoothing + discount state
let __emaMktUsd: number | undefined;
let __lastDiscountPass = false;
let __edgeHistory: number[] = [];
let __cooldownUntil = 0;
function smoothMktUsd(usd?: number, alpha = 0.2): number | undefined {
  if (usd == null || !isFinite(usd) || usd <= 0) return __emaMktUsd;
  __emaMktUsd = __emaMktUsd == null ? usd : alpha * usd + (1 - alpha) * __emaMktUsd;
  return __emaMktUsd;
}

// Rough estimator (avoid heavy multi‑KB scans before we decide to proceed)
function estimateCostUsdRough(kb: number, baseFeeWei: bigint, gasMult: number, rateNow: bigint, ethUsd: number): number {
  const bytes = Math.max(0, Math.floor(kb) * 1024 - 160);
  const dataGas = BigInt(bytes) * 40n; // worst‑case non‑zero byte
  const totalGas = dataGas + 21000n;
  const adj = BigInt(Math.floor(Number(baseFeeWei) * (isFinite(gasMult) && gasMult > 0 ? gasMult : 1)));
  const estBurnWei = totalGas * adj;
  const inputWei = (totalGas - 21000n) * baseFeeWei;
  const mintedFctWei = inputWei * (rateNow > 0n ? rateNow : 1n);
  if (mintedFctWei === 0n) return Number.POSITIVE_INFINITY;
  const ethPerFct = Number(estBurnWei) / Number(mintedFctWei) * 1e18;
  return ethPerFct * ethUsd; // USD/FCT
}

function snapToAllowedKb(kb: number): number {
  const minKb = AUTO_MIN_SIZE_KB;
  const maxKb = AUTO_MAX_SIZE_KB;
  const step = AUTO_SIZE_STEP_KB;
  if (!isFinite(kb) || kb <= minKb) return minKb;
  let v = Math.min(Math.max(Math.floor(kb / step) * step, minKb), maxKb);
  return v;
}

// 鍔ㄦ€佹垚鏈槇鍊硷紙闅忔寲鐭跨巼鍙樺寲锛?
const DYNAMIC_COST_GATE = envBool("DYNAMIC_COST_GATE", false);
const DYNAMIC_WINDOW_PCT = envNumber("DYNAMIC_WINDOW_PCT", 0.05) as number; // 鍏佽楂樹簬鈥滄湡鏈涙垚鏈€濈殑鐧惧垎姣旂獥鍙ｏ紙榛樿+5%锛?

// Helper function to prompt user for input
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY not found in .env file");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

// FCT max supply in wei
const FCT_MAX_SUPPLY = 1646951661163841381479607357n;

// L1 鍏叡瀹㈡埛绔紙鐢ㄤ簬璇诲彇閾剧姸鎬佷笌 gas 浠锋牸绛夛級
const publicClient = createPublicClient({
  chain: networkConfig.l1Chain,
  transport: http(networkConfig.l1RpcUrl),
});

// Get Facet chain configuration from network config
const facetChain = networkConfig.facetChain;

// Facet L2 鍏叡瀹㈡埛绔紙鐢ㄤ簬绛夊緟 Facet 渚т氦鏄撶‘璁?璇诲彇 Facet 浜ゆ槗瀛楁锛?
const facetClient = createPublicClient({
  chain: facetChain,
  transport: http(networkConfig.facetRpcUrl),
});

// L1 閽卞寘瀹㈡埛绔紙鐢ㄤ簬瀹為檯鍙戦€?L1 浜ゆ槗锛?
const walletClient = createWalletClient({
  account,
  chain: networkConfig.l1Chain,
  transport: http(networkConfig.l1RpcUrl),
});

// Uniswap V2 pairs (mainnet only for FCT trading)
const FCT_WETH_PAIR = networkConfig.fctWethPair;

const UNISWAP_V2_PAIR_ABI = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
]);

async function getEthPriceInUsd(): Promise<number> {
  // 浠?Facet 鎻愪緵鐨勪环鏍兼帴鍙ｈ幏鍙?ETH/USD锛涘け璐ユ椂浣跨敤鍥為€€浠锋牸锛堟彁鍗囧仴澹€э級
  try {
    // Use Facet's ETH price API
    const response = await fetch("https://eth-price.facet.org");
    if (!response.ok) {
      throw new Error("HTTP error! status: " + response.status);
    }
    const data = await response.json();
    const price = parseFloat(data.priceInUSD);

    if (isNaN(price) || price <= 0) {
      throw new Error("Invalid price data received");
    }

    return price;
  } catch (error) {
    console.error("Failed to fetch ETH price from Facet API:", error);
    console.log("Using fallback ETH price");
    return 3500; // Fallback price
  }
}

async function getFctMarketPrice(): Promise<{ priceInEth: bigint; priceInUsd: number; } | null> {
  if (!isMainnet()) return null;
  try {
    const ev = await getLatestEthPerFctViaEvents(1000);
    const priceInEth = ev.ethPerFctFp18;
    const ethPrice = await getEthPriceInUsd();
    const priceInUsd = Number(formatEther(priceInEth)) * ethPrice;
    return { priceInEth, priceInUsd };
  } catch {
    return null;
  }
}

function createMineBoostData(sizeInBytes: number): Uint8Array {
  // 鐢熸垚鐢ㄤ簬 mineBoost 鐨勬暟鎹紙绠€鍗曢噸澶嶆ā寮忥級锛屾暟鎹ぇ灏忓奖鍝?calldata gas锛屼粠鑰屽奖鍝?FCT 閾搁€犻噺
  const data = new Uint8Array(sizeInBytes);
  const pattern = "FACETMINE";
  const encoder = new TextEncoder();
  const patternBytes = encoder.encode(pattern);

  for (let i = 0; i < data.length; i++) {
    data[i] = patternBytes[i % patternBytes.length];
  }

  return data;
}

function calculateDataGas(data: Uint8Array): bigint {
  // 鎸?calldata 计价：零=10 gas/字节，非零=40 gas/字节
  let zeroBytes = 0n;
  let nonZeroBytes = 0n;

  for (const b of data) { if (b === 0) zeroBytes++; else nonZeroBytes++; }

  return zeroBytes * 10n + nonZeroBytes * 40n;
}

function formatCostPerFct(ethPerFct: bigint, ethPriceUsd: number): string {
  // 灏嗏€滄瘡鏋?FCT 鐨?ETH 鎴愭湰鈥濊浆鎹负浜虹被鍙鐨勭編鍏冨瓧绗︿覆
  const ethAmount = Number(formatEther(ethPerFct));
  const usdAmount = ethAmount * ethPriceUsd;

  if (usdAmount < 0.0001) {
    return "<$0.0001 per FCT";
  } else if (usdAmount < 0.01) {
    return "$" + usdAmount.toFixed(5) + " per FCT";
  } else {
    return "$" + usdAmount.toFixed(4) + " per FCT";
  }
}

async function selectMiningSize(
  ethPriceUsd: number
): Promise<{ selectedSize: number; estimatedCostPerTx: bigint } | null> {
  // 浜や簰妯″紡涓嬶細缁欑敤鎴峰睍绀鸿嫢骞插浐瀹氬ぇ灏忥紙25/50/75/100KB锛夌殑鎴愭湰浼扮畻锛屼緵閫夋嫨
  // Define size options (capped at 100KB)
  const sizeOptions = [
    { label: "Small", size: 25 * 1024, kb: 25 },
    { label: "Medium", size: 50 * 1024, kb: 50 },
    { label: "Large", size: 75 * 1024, kb: 75 },
    { label: "XL", size: 100 * 1024, kb: 100 },
  ];

  // Get current base fee for estimates (same as actual transaction)
  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;
  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER || cliArg("--gas-multiplier") || 1.5);
  const adjustedBaseFee = BigInt(
    Math.floor(Number(baseFee) * gasPriceMultiplier)
  );

  // Get FCT mint rate
  const fctMintRate = await getFctMintRate(networkConfig.l1Chain.id);

  // Calculate and display each option
  const optionCosts: bigint[] = [];
  for (let i = 0; i < sizeOptions.length; i++) {
    const option = sizeOptions[i];
    const overheadBytes = 160;
    const mineBoostSize = option.size - overheadBytes;

    // Estimate gas costs
    const baseExecutionGas = 21000n;
    const estimatedInputCostGas =
      calculateDataGas(new Uint8Array(mineBoostSize).fill(70)) +
      baseExecutionGas; // EIP-2028 estimation
    const estimatedEthBurn = estimatedInputCostGas * adjustedBaseFee;
    const inputCostWei = estimatedInputCostGas * baseFee;
    const fctMintAmount = inputCostWei * fctMintRate;

    optionCosts.push(estimatedEthBurn);

    const costEth = Number(formatEther(estimatedEthBurn));
    const costUsd = costEth * ethPriceUsd;
    const fctAmount = Number(formatEther(fctMintAmount));
    const costPerFct = fctAmount > 0 ? costUsd / fctAmount : 0;

    console.log(
      "  " +
        (i + 1) +
        ". " +
        option.label.padEnd(8) +
        " (" + option.kb + "KB)  - " +
        formatEther(estimatedEthBurn).padStart(8) +
        " ETH ($" + costUsd.toFixed(2).padStart(5) + "), ~" +
        fctAmount.toFixed(0).padStart(4) +
        " FCT"
    );
    /* console.log(
      chalk.red(
        "WARNING: 当前连接的链ID=" +
          chainId +
          "，但配置期望=" +
          networkConfig.l1Chain.id +
          "。请检查 getNetworkConfig()/L1_RPC_URL 是否指向了正确网络。"
      )
    ); */
  }

  console.log("  5. Custom     (specify KB, max 100)");

  const choice = await prompt("\nChoose option (1-5): ");

  if (choice === "1" || choice === "2" || choice === "3" || choice === "4") {
    const selectedIndex = parseInt(choice) - 1;
    const selectedOption = sizeOptions[selectedIndex];
    ui.showMiningSelection(selectedOption.label, selectedOption.kb + "KB");
    return {
      selectedSize: selectedOption.size,
      estimatedCostPerTx: optionCosts[selectedIndex],
    };
  } else if (choice === "5") {
    const customInput = await prompt("Enter KB size (1-100): ");
    const customKb = parseInt(customInput);

    if (isNaN(customKb) || customKb < 1 || customKb > 100) {
      console.log("Invalid size. Must be between 1-100 KB");
      return null;
    }

    const customSize = customKb * 1024;

    // Calculate cost for custom size
    const overheadBytes = 160;
    const mineBoostSize = customSize - overheadBytes;
    const baseExecutionGas = 21000n;
    const estimatedInputCostGas =
      calculateDataGas(new Uint8Array(mineBoostSize).fill(70)) +
      baseExecutionGas;
    const estimatedEthBurn = estimatedInputCostGas * adjustedBaseFee;

    ui.showMiningSelection("Custom", customKb + "KB");
    return {
      selectedSize: customSize,
      estimatedCostPerTx: estimatedEthBurn,
    };
  } else {
    console.log("Invalid choice");
    return null;
  }
}

async function getEstimatesForSizeKb(kb: number, ethPriceUsd: number) {
  // 鏍规嵁鎸囧畾澶у皬锛圞B锛夎繘琛屼及绠楋細
  // - estimatedEthBurn锛氶璁?L1 ETH 娑堣€?
  // - fctMintAmount锛氶璁?FCT 閾搁€犻噺锛堟寜褰撳墠 baseFee 涓庨€熺巼锛?
  // - costPerFctUsd锛氬崟鏋?FCT 鎴愭湰锛堢編鍏冿級
  // - efficiencyPercent锛氭晥鐜囷紙calldata gas / 鎬?gas锛?
  const customKb = Math.min(Math.max(Math.floor(kb), 1), 100);
  const customSize = customKb * 1024;

  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;
  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER || cliArg("--gas-multiplier") || 1.5);
  const adjustedBaseFee = BigInt(Math.floor(Number(baseFee) * gasPriceMultiplier));

  const overheadBytes = 160;
  const mineBoostSize = customSize - overheadBytes;

  const baseExecutionGas = 21000n;
  const estimatedInputCostGas =
    calculateDataGas(new Uint8Array(mineBoostSize).fill(70)) + baseExecutionGas;
  const estimatedEthBurn = estimatedInputCostGas * adjustedBaseFee;

  const inputCostWei = (estimatedInputCostGas - baseExecutionGas) * baseFee;
  const fctMintRate = await getFctMintRate(networkConfig.l1Chain.id);
  const fctMintAmount = inputCostWei * fctMintRate;

  const ethPerFct = fctMintAmount > 0n ? (estimatedEthBurn * 10n ** 18n) / fctMintAmount : 0n;
  const costPerFctUsd = Number(formatEther(ethPerFct)) * ethPriceUsd;

  const efficiencyPercent =
    (Number(estimatedInputCostGas - baseExecutionGas) / Number(estimatedInputCostGas)) * 100;

  return {
    sizeBytes: customSize,
    estimatedEthBurn,
    fctMintAmount,
    ethPerFct,
    costPerFctUsd,
    efficiencyPercent,
    baseFee,
    adjustedBaseFee,
  };
}

type SizeEstimate = Awaited<ReturnType<typeof getEstimatesForSizeKb>> & { kb: number };

async function pickBestSizeAndEstimates(
  ethPriceUsd: number,
  opts: {
    maxCostPerFctUsd?: number;
    minEfficiencyPercent?: number;
    minKb?: number;
    maxKb?: number;
  } = {}
): Promise<SizeEstimate | null> {
  // 鑷姩妯″紡涓嬶細鍦ㄥ厑璁哥殑 KB 鍊欓€夛紙25/50/75/100锛変腑鎷╀紭锛堝敖閲忔弧瓒虫垚鏈?鏁堢巼闂ㄦ锛屽け璐ュ垯閫夋嫨褰撳墠鏈€浼樺閫夛級
  const minKb = Math.max(AUTO_MIN_SIZE_KB, opts.minKb ?? AUTO_MIN_SIZE_KB);
  const maxKb = Math.min(AUTO_MAX_SIZE_KB, opts.maxKb ?? AUTO_MAX_SIZE_KB);
  const candidates: number[] = [];
  for (let kb = minKb; kb <= maxKb; kb += AUTO_SIZE_STEP_KB) candidates.push(kb);

  let best: SizeEstimate | null = null;
  for (const kb of candidates) {
    const est = await getEstimatesForSizeKb(kb, ethPriceUsd);
    const meetsCost =
      opts.maxCostPerFctUsd == null || est.costPerFctUsd <= opts.maxCostPerFctUsd;
    const meetsEff =
      opts.minEfficiencyPercent == null || est.efficiencyPercent >= opts.minEfficiencyPercent;

    // Prefer options that meet both constraints; otherwise keep best-efficiency fallback
    if (meetsCost && meetsEff) {
      if (!best || est.costPerFctUsd < best.costPerFctUsd) {
        best = { ...est, kb };
      }
    } else if (!best) {
      // As a fallback when none meet constraints, keep the most efficient so far
      best = { ...est, kb };
    } else {
      // Keep the candidate with lower cost/FCT when no candidate meets constraints yet
      if (best && est.costPerFctUsd < best.costPerFctUsd) {
        best = { ...est, kb };
      }
    }
  }

  return best;
}

async function miningLoop(
  spendCap: bigint,
  ethPriceUsd: number,
  dataSize: number
) {
  // 鍗曟浼氳瘽涓诲惊鐜細鍦ㄩ绠楋紙spendCap锛夊唴杩炵画鍙戦€佷氦鏄擄紝瀹炴椂鏇存柊浠〃鐩樹笌缁熻
  const balance = await publicClient.getBalance({ address: account.address });

  // Initialize dashboard
  const dashboard = new MiningDashboard({
    sessionTarget: spendCap,
    currentBalance: balance,
    ethPrice: ethPriceUsd,
    remainingBudget: spendCap,
  });

  dashboard.start();

  let totalSpent = 0n;
  let totalFctMinted = 0n;
  let transactionCount = 0;

  try {
    while (totalSpent < spendCap) {
      transactionCount++;

      // Estimate transaction cost
      const estimatedCost = await estimateTransactionCost(
        dataSize,
        ethPriceUsd
      );

      // Check if we have enough for another transaction
      if (totalSpent + estimatedCost > spendCap) {
        break;
      }

      // Start transaction in dashboard
      dashboard.startTransaction({
        status: "preparing",
        ethCost: estimatedCost,
        fctMinted: 0n,
      });

      try {
        const result = await mineFacetTransactionWithDashboard(
          ethPriceUsd,
          dataSize,
          dashboard
        );

        if (result) {
          totalSpent += result.ethSpent;
          totalFctMinted += result.fctMinted;

          // Update dashboard with completed transaction
          dashboard.completeTransaction(result.ethSpent, result.fctMinted);

          // Check if we have enough for another transaction
          if (totalSpent + estimatedCost > spendCap) {
            break;
          }
        } else {
          dashboard.updateTransaction({ status: "failed" });
          break;
        }
      } catch (error) {
        dashboard.updateTransaction({ status: "failed" });
        console.error("Transaction " + transactionCount + " failed:", error);
        if (STOP_ON_TX_FAIL) {
          break;
        } else {
          continue;
        }
      }
    }
  } finally {
    dashboard.stop();
    await showFinalSummary(
      totalSpent,
      totalFctMinted,
      ethPriceUsd,
      transactionCount
    );
  }
}

async function estimateTransactionCost(
  dataSize: number,
  ethPriceUsd: number
): Promise<bigint> {
  // 浠呯敤浜庨浼板崟绗旀垚鏈紙鐢ㄤ簬鏄惁杩樿兘缁х画涓嬩竴绗旂殑鍒ゆ柇锛夛紝瀹為檯鎴愭湰浠ヤ氦鏄撳洖鎵т负鍑?
  const overheadBytes = 160;
  const mineBoostSize = dataSize - overheadBytes;
  const mineBoostData = createMineBoostData(mineBoostSize);

  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;
  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const adjustedBaseFee = BigInt(
    Math.floor(Number(baseFee) * gasPriceMultiplier)
  );

  const baseExecutionGas = 21000n;
  const estimatedInputCostGas = calculateDataGas(mineBoostData) + baseExecutionGas;

  return estimatedInputCostGas * adjustedBaseFee;
}

async function mineFacetTransactionWithDashboard(
  ethPriceUsd: number,
  dataSize: number,
  dashboard: MiningDashboard
): Promise<{
  facetHash: string;
  l1Hash: string;
  ethSpent: bigint;
  fctMinted: bigint;
  costPerFct: bigint;
} | null> {
  // 閫氳繃 SDK 缁勮骞跺彂閫佹惡甯?mineBoost 鐨?L1 浜ゆ槗锛岄殢鍚庣瓑寰?Facet 渚х‘璁わ紝
  // 骞朵粠 Facet 浜ゆ槗瀵硅薄涓鍙栧疄闄呴摳閫犵殑 FCT 鏁伴噺锛涘湪鐪嬫澘涓睍绀鸿繘搴︿笌缁撴灉
  const actualDataSize = dataSize || 100 * 1024;
  const overheadBytes = 160;
  const mineBoostSize = actualDataSize - overheadBytes;
  const mineBoostData = createMineBoostData(mineBoostSize);

  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const blk0 = await publicClient.getBlock();
  const baseFee0 = blk0.baseFeePerGas || (await publicClient.getGasPrice());
  const maxPriorityFeePerGas0 = 0n;
  const maxFeePerGas0 = BigInt(
    Math.floor(Number(baseFee0) * gasPriceMultiplier)
  );

  dashboard.updateTransaction({ status: "submitting" });

  try {
    const l1Nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    // Pre‑send logging: separate value (principal) vs L1 gas
    const estGas = calculateDataGas(mineBoostData) + 21000n;
    const estFeeWei = estGas * maxFeePerGas0;
    const valueWei = VALUE_ETH > 0 ? BigInt(Math.floor(VALUE_ETH * 1e18)) : 0n;
    const totalWei = estFeeWei + valueWei;
    console.log(
      chalk.cyan(
        `[PRE-SEND] value_eth=${formatEther(valueWei)} gas_price_gwei=${formatGwei(maxFeePerGas0)} gas_limit≈${estGas.toString()} fee_eth≈${formatEther(estFeeWei)} total_est_eth≈${formatEther(totalWei)}`
      )
    );
    const { l1TransactionHash, facetTransactionHash } =
      await sendRawFacetTransaction(
        networkConfig.l1Chain.id,
        account.address,
        {
          to: account.address,
          value: valueWei,
          data: "0x",
          mineBoost: toHex(mineBoostData),
        },
        (l1Transaction) => {
          return (walletClient as any).sendTransaction({
            ...l1Transaction,
            account,
            maxFeePerGas: maxFeePerGas0,
            maxPriorityFeePerGas: maxPriorityFeePerGas0,
            nonce: l1Nonce,
          } as any);
        }
      );

    dashboard.updateTransaction({
      status: "confirming",
      hash: facetTransactionHash,
    });

    // Wait for L1 receipt and compute actual ETH burned (gasUsed * effectiveGasPrice)
    const l1Receipt = await publicClient.waitForTransactionReceipt({
      hash: l1TransactionHash as `0x${string}`,
    });
    const actualGasUsed = l1Receipt.gasUsed ?? 0n;
    const actualGasPrice = (l1Receipt as any).effectiveGasPrice ?? maxFeePerGas0;
    const actualEthBurned = actualGasUsed * actualGasPrice;

    // Wait for confirmation with timeout
    const facetReceipt = await facetClient.waitForTransactionReceipt({
      hash: facetTransactionHash as `0x${string}`,
      timeout: 60_000,
    });

    const facetTx = await facetClient.getTransaction({
      hash: facetTransactionHash as `0x${string}`,
    });

    let actualFctMinted = 0n;
    if (facetTx && "mint" in facetTx && facetTx.mint) {
      actualFctMinted = BigInt(facetTx.mint as string | number | bigint);
    }

    // actualEthBurned computed from L1 receipt above
    const actualEthPerFct =
      actualFctMinted > 0n
        ? (actualEthBurned * 10n ** 18n) / actualFctMinted
        : 0n;

    dashboard.updateTransaction({
      status: "completed",
      fctMinted: actualFctMinted,
    });

    // Receipt review: compute realized edge and trigger cooldown if consistently weak
    try {
      const actualCostUsdPerFct = Number(formatEther(actualEthPerFct)) * ethPriceUsd;
      const mkt = await getFctMarketPrice().catch(() => null);
      const mktUsdSmoothed = smoothMktUsd(mkt?.priceInUsd ?? undefined) ?? (mkt?.priceInUsd ?? 0);
      if (mktUsdSmoothed > 0) {
        const edge = mktUsdSmoothed - actualCostUsdPerFct;
        __edgeHistory.push(edge);
        if (__edgeHistory.length > 5) __edgeHistory.shift();
        const last3 = __edgeHistory.slice(-3);
        const weak = last3.length === 3 && last3.every((x) => x < (EDGE_WARN_USD ?? 10));
        if (weak && COOLDOWN_MIN && COOLDOWN_MIN > 0) {
          __cooldownUntil = Date.now() + Math.floor(COOLDOWN_MIN * 60_000);
          console.warn(chalk.yellow(`[cooldown] weak edge; pausing ~ ${COOLDOWN_MIN} min`));
        }
        if (process.argv.includes("--explain")) {
          console.log(chalk.gray(`[EXPLAIN] realizedUSD=${actualCostUsdPerFct.toFixed(6)} mktUSD=${mktUsdSmoothed.toFixed(6)} edge=${edge.toFixed(6)}`));
        }
      }
    } catch {}

    return {
      facetHash: facetTransactionHash,
      l1Hash: l1TransactionHash,
      ethSpent: actualEthBurned,
      fctMinted: actualFctMinted,
      costPerFct: actualEthPerFct,
    };
  } catch (error) {
    dashboard.updateTransaction({ status: "failed" });
    return null;
  }
}

async function mineFacetTransaction(
  ethPriceUsd?: number,
  dataSize?: number
): Promise<{
  facetHash: string;
  l1Hash: string;
  ethSpent: bigint;
  fctMinted: bigint;
  costPerFct: bigint;
} | null> {
  // 鏃х増/闈炵湅鏉垮皝瑁呯殑鎸栫熆閫昏緫锛堜繚鐣欑敤浜庤缁嗘棩蹇楄緭鍑轰笌瀵规瘮锛?
  const actualDataSize = dataSize || 100 * 1024; // Default to 100KB if not specified
  const overheadBytes = 160;
  const mineBoostSize = actualDataSize - overheadBytes;

  // Get prices (use provided price or fetch new one)
  const currentEthPriceUsd = ethPriceUsd || (await getEthPriceInUsd());
  console.log("ETH Price: $" + currentEthPriceUsd.toFixed(2));

  const fctMarketPrice = await getFctMarketPrice();
  if (fctMarketPrice) {
    console.log(
      "FCT Market Price (Uniswap V2): " +
        formatEther(fctMarketPrice.priceInEth) +
        " ETH ($" + fctMarketPrice.priceInUsd.toFixed(6) + ")"
    );
  }

  const mineBoostData = createMineBoostData(mineBoostSize);
  const dataGas = calculateDataGas(mineBoostData);

  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;

  // Get FCT mint rate for estimation (note: actual mining amount is non-deterministic)
  const fctMintRate = await getFctMintRate(networkConfig.l1Chain.id);

  // Estimate calldata cost for display purposes
  const baseExecutionGas = 21000n;
  const estimatedInputCostGas =
    calculateDataGas(mineBoostData) + baseExecutionGas;
  const inputCostWei = (estimatedInputCostGas - baseExecutionGas) * baseFee;
  const fctMintAmount = inputCostWei * fctMintRate;

  // Get gas price multiplier for accurate cost calculation
  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const adjustedBaseFee = BigInt(
    Math.floor(Number(baseFee) * gasPriceMultiplier)
  );

  // Estimate total ETH burn for display (actual will be handled by SDK)
  const estimatedEthBurn = estimatedInputCostGas * adjustedBaseFee;

  console.log("\nGas Estimates:");
  console.log("  Data gas:", dataGas.toString(), "gas");
  // 显示零/非零字节占比
  try { let z=0,nz=0; for (const b of mineBoostData) { if (b===0) z++; else nz++; } const tot=z+nz; console.log("  Payload bytes:", String(tot), "(zero:", String(z), ", non-zero:", String(nz), ")"); } catch {}
  console.log("  Estimated L1 gas:", estimatedInputCostGas.toString(), "gas");
  console.log("  Base fee:", formatGwei(baseFee), "gwei");
  console.log(
    "  Adjusted fee (+" + Math.round((gasPriceMultiplier - 1) * 100) + "%):",
    formatGwei(adjustedBaseFee),
    "gwei"
  );
  console.log("  Input cost:", estimatedInputCostGas.toString(), "gas units");
  console.log("  Input cost in ETH:", formatEther(inputCostWei), "ETH");
  console.log(
    "  FCT mint rate:",
    fctMintRate.toString(),
    "FCT-wei per ETH-wei"
  );

  // Calculate price correctly: ETH per FCT (cost to get 1 FCT)
  const ethPerFct =
    fctMintAmount > 0n ? (estimatedEthBurn * 10n ** 18n) / fctMintAmount : 0n;

  // Calculate fully diluted valuation
  const fctPriceUsd = Number(formatEther(ethPerFct)) * currentEthPriceUsd;
  const maxSupplyInFct = Number(formatEther(FCT_MAX_SUPPLY));
  const fullyDilutedValue = maxSupplyInFct * fctPriceUsd;

  console.log("\nExpected Results:");
  const ethBurnUsd = Number(formatEther(estimatedEthBurn)) * currentEthPriceUsd;
  console.log(
    "  ETH to burn:",
    formatEther(estimatedEthBurn),
    "ETH",
    "($" + ethBurnUsd.toFixed(2) + ")"
  );
  console.log("  FCT to mint:", formatEther(fctMintAmount), "FCT");
  console.log("  Cost per FCT:", formatEther(ethPerFct), "ETH");
  console.log(
    "  Cost per FCT (USD):",
    formatCostPerFct(ethPerFct, currentEthPriceUsd)
  );

  // Calculate and display overhead
  // L1 overhead is just the base transaction cost (21000 gas)
  // Everything else (all calldata) contributes to FCT minting
  // Note: baseExecutionGas and actualCalldataGas are already defined above
  const calldataEthCost = inputCostWei; // Already calculated above
  const executionEthCost = baseExecutionGas * baseFee;
  const calldataEthUsd =
    Number(formatEther(calldataEthCost)) * currentEthPriceUsd;
  const executionEthUsd =
    Number(formatEther(executionEthCost)) * currentEthPriceUsd;
  const efficiencyPercent =
    (Number(estimatedInputCostGas - baseExecutionGas) /
      Number(estimatedInputCostGas)) *
    100;

  console.log("\nCost Breakdown:");
  console.log(
    "  Calldata cost (generates FCT):",
    formatEther(calldataEthCost),
    "ETH",
    "($" + calldataEthUsd.toFixed(2) + ")"
  );
  console.log(
    "  L1 base cost (21k gas):",
    formatEther(executionEthCost),
    "ETH",
    "($" + executionEthUsd.toFixed(2) + ")"
  );
  console.log(
    "  Mining efficiency:",
    efficiencyPercent.toFixed(1) + "%",
    "(" + (100 - efficiencyPercent).toFixed(1) + "% overhead)"
  );

  // Compare with market price
  if (fctMarketPrice) {
    const miningPremium =
      ((Number(formatEther(ethPerFct)) -
        Number(formatEther(fctMarketPrice.priceInEth))) /
        Number(formatEther(fctMarketPrice.priceInEth))) *
      100;
    if (miningPremium > 0) {
      console.log(
        "   Mining cost is " + miningPremium.toFixed(1) + "% above market price"
      );
    } else {
      console.log(
        "  Mining cost is " + Math.abs(miningPremium).toFixed(1) + "% below market price"
      );
    }
  }

  // Compare mining vs swapping (mainnet only)
  if (isMainnet()) {
    await compareMiningVsSwapping(estimatedEthBurn, fctMintAmount, ethPerFct);
  }
  console.log("\nMarket Valuation:");
  console.log("  FCT Max Supply:", maxSupplyInFct.toLocaleString(), "FCT");
  console.log(
    "  Fully Diluted Valuation:",
    "$" + fullyDilutedValue.toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })
  );

  console.log("\nSending transaction...");

  // Get current gas price and apply multiplier to avoid getting stuck
  const blk1 = await publicClient.getBlock();
  const baseFee1 = blk1.baseFeePerGas || (await publicClient.getGasPrice());
  const maxPriorityFeePerGas1 = 0n;
  const maxFeePerGas1 = BigInt(
    Math.floor(Number(baseFee1) * gasPriceMultiplier)
  );

  console.log("Gas price strategy:");
  console.log(
    "  Current network gas price:",
    formatGwei(currentGasPrice),
    "gwei"
  );
  console.log(
    "  Boosted gas price (+" +
      Math.round((gasPriceMultiplier - 1) * 100) +
      "% buffer):",
    formatGwei(maxFeePerGas1),
    "gwei"
  );

  try {
    if (IS_DRY_RUN) {
      console.log("[DRY_RUN] 将模拟发送，不会广播交易。");
      const estGas = estimatedInputCostGas;
      const estEth = estGas * maxFeePerGas1;
      console.log("[DRY_RUN] 估算gas=", estGas.toString(), " 估算ETH=", formatEther(estEth));
      const estEthPerFct = fctMintAmount > 0n ? (estEth * 10n ** 18n) / fctMintAmount : 0n;
      return {
        facetHash: "0xDRYRUN",
        l1Hash: "0xDRYRUN",
        ethSpent: estEth,
        fctMinted: fctMintAmount,
        costPerFct: estEthPerFct,
      };
    }
    // Get current nonce before sending
    const l1Nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    // Use SDK to send the Facet transaction with mine boost
    const { l1TransactionHash, facetTransactionHash } =
      await sendRawFacetTransaction(
        networkConfig.l1Chain.id,
        account.address,
        {
          to: account.address,
          value: (VALUE_ETH && VALUE_ETH > 0) ? BigInt(Math.floor(VALUE_ETH * 1e18)) : 0n,
          data: "0x",
          mineBoost: toHex(mineBoostData),
        },
        (l1Transaction) => {
          return (walletClient as any).sendTransaction({
            ...l1Transaction,
            account,
            maxFeePerGas: maxFeePerGas1,
            maxPriorityFeePerGas: maxPriorityFeePerGas1,
            nonce: l1Nonce,
          } as any);
        }
      );

    console.log("L1 transaction hash:", l1TransactionHash);
    console.log("L1 transaction nonce:", l1Nonce);
    console.log("Facet transaction hash:", facetTransactionHash);
    const facetHash = facetTransactionHash;
    console.log("Waiting for Facet confirmation...");

    let actualFctMinted = 0n;
    let actualEthBurned = estimatedEthBurn; // Fallback to estimate
    let actualGasUsed = estimatedInputCostGas; // Fallback to estimate
    let actualGasPrice = maxFeePerGas1; // Use the cap we set
    let isConfirmed = false;

    try {
      const facetReceipt = await facetClient.waitForTransactionReceipt({
        hash: facetHash as `0x${string}`,
        timeout: 60_000, // 60 second timeout
      });

      // Get the full transaction to access the mint field
      const facetTx = await facetClient.getTransaction({
        hash: facetHash as `0x${string}`,
      });

      // The Facet transaction has a 'mint' field with the actual FCT minted
      if (facetTx && "mint" in facetTx && facetTx.mint) {
        actualFctMinted = BigInt(facetTx.mint as string | number | bigint);
        isConfirmed = true;
        console.log("Facet transaction confirmed");
        console.log("  Facet block:", facetReceipt.blockNumber);
        console.log(
          "  Actual FCT minted:",
          formatEther(actualFctMinted),
          "FCT"
        );
      } else {
        // Fallback to estimated amount if mint field not found
        console.log(
          "Warning: Could not find mint field, using estimated amount"
        );
        actualFctMinted = fctMintAmount;
      }
    } catch (error) {
      console.log(
        "Facet confirmation timeout after 60 seconds - stopping mining"
      );
      console.log(
        "   L1 transaction may have failed or Facet indexing is delayed"
      );
      return null;
    }

    // Calculate actual price: ETH per FCT
    const actualEthPerFct =
      actualFctMinted > 0n
        ? (actualEthBurned * 10n ** 18n) / actualFctMinted
        : 0n;

    if (isConfirmed) {
      console.log("\nTransaction Confirmed!");
    } else {
      console.log("\n鈴?Transaction Submitted (pending confirmation)");
    }
    console.log("L1 Hash:", l1TransactionHash);
    console.log("L1 Nonce:", l1Nonce);
    console.log("Facet Hash:", facetHash);
    console.log("\nActual Results:");
    console.log("  Gas used:", actualGasUsed.toString());
    console.log("  Gas price:", formatGwei(actualGasPrice), "gwei");
    // Calculate actual fully diluted valuation
    const actualFctPriceUsd =
      Number(formatEther(actualEthPerFct)) * currentEthPriceUsd;
    const maxSupplyInFct = Number(formatEther(FCT_MAX_SUPPLY));
    const actualFdv = maxSupplyInFct * actualFctPriceUsd;

    const actualEthBurnUsd =
      Number(formatEther(actualEthBurned)) * currentEthPriceUsd;
    console.log(
      "  ETH burned:",
      formatEther(actualEthBurned),
      "ETH",
      "($" + actualEthBurnUsd.toFixed(2) + ")"
    );
    console.log("  FCT minted:", formatEther(actualFctMinted), "FCT");
    console.log("  Actual cost per FCT:", formatEther(actualEthPerFct), "ETH");
    console.log(
      "  Actual cost per FCT (USD):",
      formatCostPerFct(actualEthPerFct, currentEthPriceUsd)
    );
    console.log("\nActual Market Metrics:");
    console.log(
      "  Fully Diluted Valuation (FDV):",
      "$" + actualFdv.toLocaleString(undefined, { maximumFractionDigits: 0 })
    );

    // Return transaction results
    return {
      facetHash,
      l1Hash: l1TransactionHash,
      ethSpent: actualEthBurned,
      fctMinted: actualFctMinted,
      costPerFct: actualEthPerFct,
    };
  } catch (error) {
    console.error("Transaction failed:", error);
    return null;
  }
}

/*
async function showFinalSummary(
  totalSpent: bigint,
  totalFctMinted: bigint,
  ethPriceUsd: number,
  transactionCount: number
) {
  // 浼氳瘽缁撴潫鏃剁殑鎬荤粨闈㈡澘锛氬睍绀轰氦鏄撶瑪鏁般€丒TH/FCT 鎬昏銆佸潎浠蜂笌闅愬惈 FDV
  const NO_CLEAR = String(process.env.NO_CLEAR || "").toLowerCase() === "true";
  if (!NO_CLEAR) console.clear();

  // Keep the same header as always
  const borderWidth = 79;
  const text = "FCT MINER v2.0";
  const padding = Math.floor((borderWidth - text.length) / 2);
  const remainder = borderWidth - text.length - padding;
  const centeredText = " ".repeat(padding) + text + " ".repeat(remainder);

  console.log(chalk.hex("#00FF00")("鈺? + "鈺?.repeat(borderWidth) + "鈺?));
  console.log(
    chalk.hex("#00FF00")("鈺?) +
      chalk.hex("#00FF88").bold(centeredText) +
      chalk.hex("#00FF00")("鈺?)
  );
  console.log(chalk.hex("#00FF00")("鈺? + "鈺?.repeat(borderWidth) + "鈺?));
  console.log("");

  const totalSpentUSD = Number(formatEther(totalSpent)) * ethPriceUsd;
  const avgCostPerFct =
    totalFctMinted > 0n
      ? totalSpentUSD / Number(formatEther(totalFctMinted))
      : 0;

  console.log(chalk.cyan("\nFinal Results:"));
  console.log(
    "  " + chalk.white("Transactions:") + " " + chalk.green.bold(transactionCount)
  );
  console.log(
    "  " +
      chalk.white("ETH Spent:") +
      " " +
      chalk.yellow.bold(formatEther(totalSpent).slice(0, 8)) +
      " ETH"
  );
  console.log(
    "  " +
      chalk.white("USD Spent:") +
      " " +
      chalk.yellow.bold("$" + totalSpentUSD.toFixed(2))
  );
  console.log(
    "  " +
      chalk.white("FCT Mined:") +
      " " +
      chalk.green.bold(formatEther(totalFctMinted).slice(0, 8)) +
      " FCT"
  );
  console.log(
    "  " +
      chalk.white("Avg Cost:") +
      " " +
      chalk.magenta.bold("$" + avgCostPerFct.toFixed(4)) +
      " per FCT"
  );

  if (totalFctMinted > 0n) {
    const maxSupplyInFct = Number(formatEther(FCT_MAX_SUPPLY));
    const impliedFDV = maxSupplyInFct * avgCostPerFct;
    console.log(
      "  " +
        chalk.white("Implied FDV:") +
        " " +
        chalk.blue.bold(
          "$" +
            impliedFDV.toLocaleString(undefined, { maximumFractionDigits: 0 })
        )
    );
  }

  console.log(chalk.green("\nSession completed successfully!"));
  console.log(chalk.gray("Press any key to exit..."));
}

// 尝试从外部 JSON 获取周期信息（可选）：progress、blocksLeft、minted、target
async function getCycleInfo(): Promise<{
  progress?: number; // 0..1
  blocksLeft?: number;
  minted?: bigint;
  target?: bigint;
} | null> {
  try {
    const url = (process.env.FCT_FYI_JSON_URL || STRATEGY.fctFyiJsonUrl) as string | undefined;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const minted = j.minted ? BigInt(j.minted) : undefined;
    const target = j.target ? BigInt(j.target) : undefined;
    const progress = j.progress != null ? Number(j.progress) : (minted != null && target != null && Number(target) > 0 ? Number(minted) / Number(target) : undefined);
    const blocksLeft = j.blocksLeft != null ? Number(j.blocksLeft) : (j.blocksElapsed != null ? Math.max(0, 500 - Number(j.blocksElapsed)) : undefined);
    return { progress, blocksLeft, minted, target };
  } catch { return null; }
}

function usdPerFctFromMarket(ev: { priceInEth: bigint; priceInUsd: number }): number {
  // 事件价格已提供 USD/FCT
  return ev.priceInUsd;
}

function estUsdPerFct(ethPerFctFp18: bigint, ethUsd: number): number {
  return Number(formatEther(ethPerFctFp18)) * ethUsd;
}
*/

async function showFinalSummary(
  totalSpent: bigint,
  totalFctMinted: bigint,
  ethPriceUsd: number,
  transactionCount: number
) {
  const NO_CLEAR = String(process.env.NO_CLEAR || "").toLowerCase() === "true";
  if (!NO_CLEAR) console.clear();

  const borderWidth = 79;
  const text = "FCT MINER v2.0";
  const padding = Math.floor((borderWidth - text.length) / 2);
  const remainder = borderWidth - text.length - padding;
  const centeredText = " ".repeat(padding) + text + " ".repeat(remainder);

  // Simple ASCII header to avoid Unicode border issues
  const top = "+" + "-".repeat(borderWidth) + "+";
  const mid = "|" + centeredText + "|";
  console.log(chalk.hex("#00FF00")(top));
  console.log(chalk.hex("#00FF88")(mid));
  console.log(chalk.hex("#00FF00")(top));
  console.log("");

  const totalSpentUSD = Number(formatEther(totalSpent)) * ethPriceUsd;
  const avgCostPerFct =
    totalFctMinted > 0n ? totalSpentUSD / Number(formatEther(totalFctMinted)) : 0;

  console.log(chalk.cyan("\nFinal Results:"));
  console.log(
    "  " + chalk.white("Transactions:") + " " + chalk.green.bold(transactionCount)
  );
  console.log(
    "  " +
      chalk.white("ETH Spent:") +
      " " +
      chalk.yellow.bold(formatEther(totalSpent).slice(0, 8)) +
      " ETH"
  );
  console.log(
    "  " + chalk.white("USD Spent:") + " " + chalk.yellow.bold("$" + totalSpentUSD.toFixed(2))
  );
  console.log(
    "  " +
      chalk.white("FCT Mined:") +
      " " +
      chalk.green.bold(formatEther(totalFctMinted).slice(0, 8)) +
      " FCT"
  );
  console.log(
    "  " + chalk.white("Avg Cost:") + " " + chalk.magenta.bold("$" + avgCostPerFct.toFixed(4)) + " per FCT"
  );

  if (totalFctMinted > 0n) {
    const maxSupplyInFct = Number(formatEther(FCT_MAX_SUPPLY));
    const impliedFDV = maxSupplyInFct * avgCostPerFct;
    console.log(
      "  " +
        chalk.white("Implied FDV:") +
        " " +
        chalk.blue.bold("$" + impliedFDV.toLocaleString(undefined, { maximumFractionDigits: 0 }))
    );
  }

  console.log(chalk.green("\nSession completed successfully!"));
  console.log(chalk.gray("Press any key to exit..."));
}

async function main() {
  // 绋嬪簭鍏ュ彛锛?
  // - 闈炶嚜鍔ㄦā寮忥細杩涘叆浜や簰寮忎細璇?
  // - 鑷姩妯″紡锛氭寜闃堝€硷紙Gas/鏁堢巼/鎴愭湰/浣欓锛変笌鏀惧绛栫暐杩涜鍛ㄦ湡鎬ц瘎浼颁笌鎵ц
  if (!AUTO_MODE) {
    await startMiningSession();
    return;
  }

  // Auto controller
  const loopForever = AUTO_LOOP;
  let waitCycles = 0;
  while (true) {
    ui.showHeader(getCurrentNetwork(), account.address);

    // Unified next-iteration scheduling to avoid deep `continue` usage
    let shouldNext = false;
    let nextDelayMs = CHECK_INTERVAL_SEC * 1000;
    const scheduleNext = (ms?: number) => {
      shouldNext = true;
      if (ms && ms > 0) nextDelayMs = ms;
    };

    // Get wallet balance
    const balance = await publicClient.getBalance({ address: account.address });
    const balanceEth = Number(formatEther(balance));
    if (MIN_BALANCE_ETH != null && balanceEth < MIN_BALANCE_ETH) {
      console.log(
        chalk.yellow(
          "Balance " +
            balanceEth +
            " ETH below MIN_BALANCE_ETH=" +
            MIN_BALANCE_ETH +
            ". Waiting... (cycle " +
            (waitCycles + 1) +
            ")"
        )
      );
      if (!loopForever) return;
      scheduleNext();
    }

    const ethPriceUsd = await getEthPriceInUsd();
    // Cooldown gate
    if (__cooldownUntil && Date.now() < __cooldownUntil) {
      console.log(chalk.yellow(`[GATE] cooldown active ~ ${Math.ceil((__cooldownUntil - Date.now())/1000)}s remaining`));
      if (!loopForever) return; scheduleNext();
    }

    // === Early Strategy Gate (timing + discount) to avoid heavy multi‑size estimates ===
    try {
      const blkEarly = await publicClient.getBlock();
      const baseFeeEarly = blkEarly.baseFeePerGas || (await publicClient.getGasPrice());
      const rateNow = await getFctMintRate(networkConfig.l1Chain.id);
      const cyc = await getCycleInfo();
      const progress = cyc?.progress;
      const blocksLeft = cyc?.blocksLeft;
      // timing windows
      if (STRATEGY.rateFloorWeiPerEth && rateNow < (STRATEGY.rateFloorWeiPerEth as bigint)) {
        if (!loopForever) return; scheduleNext();
      }
      if (progress != null && blocksLeft != null) {
        const earlyOK = progress <= (STRATEGY.maxProgress ?? 0.3) && blocksLeft >= (STRATEGY.minBlocksLeft ?? 250);
        const lateWeak = blocksLeft < (STRATEGY.bWait ?? 40) && progress < (STRATEGY.uWeak ?? 0.6);
        const nearCap = progress >= (STRATEGY.eHigh ?? 0.9);
        if (!earlyOK || lateWeak || nearCap) { if (!loopForever) return; scheduleNext(); }
      }
      // market discount (smoothed)
      const mkt = await getFctMarketPrice().catch(()=>null);
      const mktUsdSmoothed = smoothMktUsd(mkt?.priceInUsd ?? undefined);
      if (mktUsdSmoothed != null) {
        const kbProbe = (AUTO_DYNAMIC_SIZE ? (STRATEGY.perTxKB ?? AUTO_SIZE_KB) : AUTO_SIZE_KB) as number;
        const rough = estimateCostUsdRough(kbProbe, baseFeeEarly, Number(process.env.GAS_PRICE_MULTIPLIER ?? '1.5'), rateNow, ethPriceUsd);
        const cheaper = rough <= mktUsdSmoothed * (1 - (STRATEGY.targetDiscount ?? 0.2)) && (mktUsdSmoothed - rough) >= (STRATEGY.minAbsEdgeUsd ?? 50);
        __lastDiscountPass = !!cheaper;
        if (process.argv.includes("--explain")) {
          console.log(chalk.gray(`[EXPLAIN] roughUSD=${rough.toFixed(6)} mktUSD=${mktUsdSmoothed.toFixed(6)} edge=${(mktUsdSmoothed-rough).toFixed(6)}`));
        }
        if (!cheaper) { if (!loopForever) return; scheduleNext(); }
      }
    } catch {}

    // L1 Gas 中文门控（乘后gwei + baseFee）
    if (MINE_L1_GWEI_MIN != null || MINE_L1_GWEI_MAX != null || MINE_L1_BASEFEE_MAX_GWEI != null) {
      let waited = 0;
      while (true) {
        const blk = await publicClient.getBlock();
        const baseFee = blk.baseFeePerGas || (await publicClient.getGasPrice());
        const boosted = BigInt(Math.floor(Number(baseFee) * (Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5)));
        const gweiNow = Number(formatGwei(boosted));
        const baseGweiNow = Number(formatGwei(baseFee));
        const passMax = MINE_L1_GWEI_MAX == null || gweiNow <= MINE_L1_GWEI_MAX;
        const passBase = MINE_L1_BASEFEE_MAX_GWEI == null || baseGweiNow <= MINE_L1_BASEFEE_MAX_GWEI;
        if (MINE_L1_MAX_WAIT_SEC <= 0 || waited >= MINE_L1_MAX_WAIT_SEC) {
          console.log(chalk.yellow('[GATE] 当前 L1 Gas（乘后）=' + gweiNow.toFixed(6) + ' gwei，不在允许区间 [' + String(MINE_L1_GWEI_MAX ?? '-') + '] 或 baseFee=' + baseGweiNow.toFixed(6) + ' gwei 高于阈值 ' + String(MINE_L1_BASEFEE_MAX_GWEI ?? '-') + '，停止挖矿。'));
          if (!loopForever) return;
          await new Promise((r) => setTimeout(r, CHECK_INTERVAL_SEC * 1000));
          waitCycles++;
          continue;
        }
        console.log(chalk.yellow('[GATE] 当前 L1 Gas（乘后）=' + gweiNow.toFixed(6) + ' gwei，不在允许区间 [' + String(MINE_L1_GWEI_MAX ?? '-') + '] 或 baseFee=' + baseGweiNow.toFixed(6) + ' gwei 高于阈值 ' + String(MINE_L1_BASEFEE_MAX_GWEI ?? '-') + '，等待 ' + String(MINE_L1_CHECK_INTERVAL_SEC) + 's 后重试…'));
        await new Promise((r) => setTimeout(r, MINE_L1_CHECK_INTERVAL_SEC * 1000));
        waited += MINE_L1_CHECK_INTERVAL_SEC;
          continue;
        }
        console.log(
          chalk.yellow(
            '[GATE] 当前 L1 Gas（乘后）=' + gweiNow.toFixed(6) + ' gwei，不在允许区间 [' + String(MINE_L1_GWEI_MAX ?? '-') + '] 或 baseFee=' + baseGweiNow.toFixed(6) + ' gwei 高于阈值 ' + String(MINE_L1_BASEFEE_MAX_GWEI ?? '-') + '，等待 ' + String(MINE_L1_CHECK_INTERVAL_SEC) + 's 后重试…'
          )
        );
        await new Promise((r) => setTimeout(r, MINE_L1_CHECK_INTERVAL_SEC * 1000));
        waited += MINE_L1_CHECK_INTERVAL_SEC;
      }
    }

    // Gas price threshold check (L1)
    if (MAX_L1_GWEI != null) {
      const currentGas = await publicClient.getGasPrice();
      const currentGwei = Number(formatGwei(currentGas));
      // Apply relaxation if we've been waiting
      let effectiveMaxGwei = MAX_L1_GWEI;
      if (waitCycles >= AUTO_RELAX_AFTER_CYCLES) {
        const relaxSteps = waitCycles - AUTO_RELAX_AFTER_CYCLES + 1;
        const relaxFactor = 1 + (relaxSteps * AUTO_RELAX_STEP_PERCENT) / 100;
        effectiveMaxGwei = MAX_L1_GWEI * relaxFactor;
      }
      // Hard ceiling and discount‑linked relaxation
      if (GWEI_HARD_CEILING != null) effectiveMaxGwei = Math.min(effectiveMaxGwei, GWEI_HARD_CEILING);
      if (!__lastDiscountPass) effectiveMaxGwei = MAX_L1_GWEI;
      if (currentGwei > effectiveMaxGwei) {
      const note =
          effectiveMaxGwei !== MAX_L1_GWEI
            ? " (relaxed to " + effectiveMaxGwei.toFixed(2) + " gwei)"
            : "";
        console.log(
          chalk.yellow(
            "Gate: L1 gas " +
              currentGwei +
              " gwei > MAX_L1_GWEI " +
              MAX_L1_GWEI +
              note +
              ". Waiting... (cycle " +
              (waitCycles + 1) +
              ")"
          )
        );
        if (!loopForever) return;
        scheduleNext();
      }
    }

    // Pick size and estimate (adaptive if enabled)
    let effectiveMaxCost = MAX_COST_PER_FCT_USD ?? undefined;
    let effectiveMinEff = MIN_EFFICIENCY_PERCENT ?? undefined;
    if (waitCycles >= AUTO_RELAX_AFTER_CYCLES) {
      const relaxSteps = waitCycles - AUTO_RELAX_AFTER_CYCLES + 1;
      const relaxFactor = 1 + (relaxSteps * AUTO_RELAX_STEP_PERCENT) / 100;
      if (effectiveMaxCost != null) effectiveMaxCost = effectiveMaxCost * relaxFactor;
      if (effectiveMinEff != null) effectiveMinEff = Math.max(0, effectiveMinEff / relaxFactor);
    }

    let est: Awaited<ReturnType<typeof getEstimatesForSizeKb>> & { kb?: number };
    if (AUTO_DYNAMIC_SIZE) {
      const pick = await pickBestSizeAndEstimates(ethPriceUsd, {
        maxCostPerFctUsd: effectiveMaxCost,
        minEfficiencyPercent: effectiveMinEff,
      });
      if (!pick) {
        console.log(
          chalk.yellow(
            "Unable to compute estimates. Waiting... (cycle " +
              (waitCycles + 1) +
              ")"
          )
        );
        if (!loopForever) return;
        scheduleNext();
      }
      est = pick;
      console.log(
        chalk.gray(
          "Estimates: size=" +
            pick.kb +
            "KB, cost/tx=" +
            formatEther(pick.estimatedEthBurn) +
            " ETH, cost/FCT=$" +
            pick.costPerFctUsd.toFixed(6) +
            ", eff=" +
            pick.efficiencyPercent.toFixed(1) +
            "%"
        )
      );
    } else {
      est = await getEstimatesForSizeKb(AUTO_SIZE_KB, ethPriceUsd);
      console.log(
        chalk.gray(
          "Estimates: size=" +
            AUTO_SIZE_KB +
            "KB, cost/tx=" +
            formatEther(est.estimatedEthBurn) +
            " ETH, cost/FCT=$" +
            est.costPerFctUsd.toFixed(6) +
            ", eff=" +
            est.efficiencyPercent.toFixed(1) +
            "%"
        )
      );
    }

    // 单笔上限自动选型（若配置 MINE_MAX_ETH_PER_TX）
    if (MINE_MAX_ETH_PER_TX != null) {
      const capWei = BigInt(Math.floor(MINE_MAX_ETH_PER_TX * 1e18));
      let picked: Awaited<ReturnType<typeof getEstimatesForSizeKb>> & { kb?: number } = est as any;
      let pickedKb = (est as any).kb ?? AUTO_SIZE_KB;
      for (let kb = AUTO_MAX_SIZE_KB; kb >= AUTO_MIN_SIZE_KB; kb -= AUTO_SIZE_STEP_KB) {
        const e = await getEstimatesForSizeKb(kb, ethPriceUsd);
        if (e.estimatedEthBurn <= capWei) { picked = { ...e, kb }; pickedKb = kb; break; }
      }
      if (picked) {
        console.log(
          chalk.cyan(
            `[AUTO] 选定KB=${pickedKb} 估算成本≈${formatEther(picked.estimatedEthBurn)} ETH (cap=${formatEther(capWei)} ETH)`
          )
        );
        est = picked;
      }
    const EXPLAIN = process.argv.includes("--explain");
    if (EXPLAIN) {
      const kbSel = (est as any).kb ?? AUTO_SIZE_KB;
      console.log(chalk.gray("[EXPLAIN] kb=" + String(kbSel) + " estETH=" + formatEther(est.estimatedEthBurn) + " cost/FCT=$" + est.costPerFctUsd.toFixed(6)));
    }

    // --- 新增：择时/比价/周期条件 ---
    let shouldMine = true;
    const reasons: string[] = [];
    try {
      const rateNow = await getFctMintRate(networkConfig.l1Chain.id);
      if (STRATEGY.rateFloorWeiPerEth && rateNow < STRATEGY.rateFloorWeiPerEth) {
        shouldMine = false;
        reasons.push("mintRate 低于 RATE_FLOOR");
      }
      const cyc = await getCycleInfo();
      const progress = cyc?.progress;
      const blocksLeft = cyc?.blocksLeft;
      if (progress != null && blocksLeft != null) {
        const earlyOK = progress <= (STRATEGY.maxProgress ?? 0.3) && blocksLeft >= (STRATEGY.minBlocksLeft ?? 250);
        const lateWeak = blocksLeft < (STRATEGY.bWait ?? 40) && progress < (STRATEGY.uWeak ?? 0.6);
        const nearCap = progress >= (STRATEGY.eHigh ?? 0.9);
        if (!earlyOK || lateWeak || nearCap) {
          shouldMine = false;
          if (!earlyOK) reasons.push("周期不早(progress/blocksLeft)");
          if (lateWeak) reasons.push("尾段且进度偏低，等待下周期");
          if (nearCap) reasons.push("本周期接近打满");
        }
        // 不打爆上限 ethCapWei：((target-minted)/rateNow)*ALPHA，与单笔cap取最小，验证选定KB
        if (!cyc) {
          console.log(chalk.gray('[CYCLE] source=fallback-chain，无 minted/target，跳过不打爆校验'));
        } else if (cyc.minted != null && cyc.target != null && rateNow && Number(rateNow) > 0) {
          const alpha = STRATEGY.alpha ?? 0.9;
          const remaining = cyc.target > cyc.minted ? cyc.target - cyc.minted : 0n;
          const ethCapWeiBase = BigInt(Number(remaining) / Math.max(Number(rateNow), 1)) * BigInt(Math.floor(alpha*1e6)) / 1_000_000n;
          const capFromEnv = MINE_MAX_ETH_PER_TX != null ? BigInt(Math.floor(MINE_MAX_ETH_PER_TX * 1e18)) : undefined;
          let finalCap = capFromEnv != null ? (ethCapWeiBase > 0n ? (capFromEnv < ethCapWeiBase ? capFromEnv : ethCapWeiBase) : capFromEnv) : ethCapWeiBase;
          // Apply single-cycle share cap if configured
          if (MAX_CYCLE_SHARE != null && MAX_CYCLE_SHARE > 0) {
            const shareWei = BigInt(Math.floor(MAX_CYCLE_SHARE * Math.max(1, Number(remaining)) / Math.max(1, Number(rateNow))));
            if (shareWei > 0n) finalCap = finalCap != null ? (finalCap < shareWei ? finalCap : shareWei) : shareWei;
          }
          if (finalCap != null && finalCap > 0n) {
            if (est.estimatedEthBurn > finalCap) {
              let shrunk = null as any; let kbSel = (est as any).kb ?? AUTO_SIZE_KB;
              // Try ratio back-solve first and snap to allowed grid
              try {
                const ratio = Number(finalCap) / Math.max(1, Number(est.estimatedEthBurn));
                const kbCap = snapToAllowedKb(Math.max(AUTO_MIN_SIZE_KB, Math.floor(kbSel * ratio)));
                const e2 = await getEstimatesForSizeKb(kbCap, ethPriceUsd);
                if (e2.estimatedEthBurn <= finalCap) { shrunk = { ...e2, kb: kbCap }; }
              } catch {}
              // Fallback: step down search
              if (!shrunk) for (let kb = kbSel - AUTO_SIZE_STEP_KB; kb >= AUTO_MIN_SIZE_KB; kb -= AUTO_SIZE_STEP_KB) {
                const e2 = await getEstimatesForSizeKb(kb, ethPriceUsd);
                if (e2.estimatedEthBurn <= finalCap) { shrunk = { ...e2, kb }; break; }
              }
              if (shrunk) {
                console.log(chalk.cyan("[AUTO] shrink KB to " + String(shrunk.kb) + " cost≈" + formatEther(shrunk.estimatedEthBurn) + " ETH (cap=" + formatEther(finalCap) + " ETH)"));
                est = shrunk;
              } else {
                shouldMine = false; reasons.push('预计成本超过 ethCap 上限');
              }
            }
          }
        }
      }
      const mkt = await getFctMarketPrice();
      if (mkt) {
        const mktUsd = usdPerFctFromMarket(mkt);
        const estUsd = est.costPerFctUsd;
        const discount = STRATEGY.targetDiscount ?? 0.2;
        const minEdge = STRATEGY.minAbsEdgeUsd ?? 50;
    const cheaper = estUsd <= mktUsd * (1 - discount) && (mktUsd - estUsd) >= minEdge;
    if (process.argv.includes("--explain")) {
      console.log(chalk.gray(`[EXPLAIN] mktUSD=${mktUsd.toFixed(6)} estUSD=${estUsd.toFixed(6)} edge=${(mktUsd-estUsd).toFixed(6)}`));
    }
        if (!cheaper) {
          shouldMine = false;
          reasons.push("成本/FCT 未比市场便宜到目标幅度");
        }
      }
      // 效率门槛（补强）
      if ((STRATEGY.effDefault ?? 0.995) > 0) {
        const reqEff = (STRATEGY.effDefault ?? 0.995) * 100;
        if (est.efficiencyPercent < reqEff) {
          shouldMine = false;
          reasons.push("效率不足(eff低于阈值)");
        }
      }
    } catch {}

    if (!shouldMine) {
      console.log(chalk.yellow("[GATE] 挖矿条件未达标：" + reasons.join("；")));
      if (!loopForever) return;
      scheduleNext();


    }

    // Enforce gates with relaxed values
    if (effectiveMinEff != null && est.efficiencyPercent < effectiveMinEff) {
      const relaxNoteEff =
        effectiveMinEff !== MIN_EFFICIENCY_PERCENT
          ? " (relaxed to " + effectiveMinEff.toFixed(1) + "%)"
          : "";
      console.log(
        chalk.yellow(
          "Gate: Efficiency " +
            est.efficiencyPercent.toFixed(1) +
            "% < MIN_EFFICIENCY_PERCENT " +
            MIN_EFFICIENCY_PERCENT +
            relaxNoteEff +
            ". Waiting... (cycle " +
            (waitCycles + 1) +
            ")"
        )
      );
      if (!loopForever) return;
      scheduleNext();


    }

    if (DYNAMIC_COST_GATE) {
      const fctPerEth = Number(formatEther(await getFctMintRate(networkConfig.l1Chain.id)));
      const overhead = Math.max(0, 1 - est.efficiencyPercent / 100);
      const expectedCostUsd = (ethPriceUsd / Math.max(fctPerEth, 1e-12)) * (1 + overhead);
      const maxCostUsd = expectedCostUsd * (1 + (DYNAMIC_WINDOW_PCT ?? 0.05));
      if (est.costPerFctUsd > maxCostUsd) {
        console.log(
          chalk.yellow(
            "Gate: dynamic Cost/FCT $" +
              est.costPerFctUsd.toFixed(6) +
              " > allowed $" +
              maxCostUsd.toFixed(6) +
              " (expected $" +
              expectedCostUsd.toFixed(6) +
              ", overhead " +
              (overhead * 100).toFixed(2) +
              "%, window " +
              ((DYNAMIC_WINDOW_PCT ?? 0) * 100).toFixed(1) +
              "%). Waiting... (cycle " +
              (waitCycles + 1) +
              ")"
          )
        );
        scheduleNext();



      } else {
        // 鎵撳嵃閫氳繃鍔ㄦ€侀槇鍊肩殑淇℃伅锛屼究浜庤瀵?
        console.log(
          chalk.green(
            "Dynamic gate OK: cost/FCT $" +
              est.costPerFctUsd.toFixed(6) +
              " <= allowed $" +
              maxCostUsd.toFixed(6) +
              " (expected $" +
              expectedCostUsd.toFixed(6) +
              ", overhead " +
              (overhead * 100).toFixed(2) +
              "%, window " +
              ((DYNAMIC_WINDOW_PCT ?? 0) * 100).toFixed(1) +
              "% )"
          )
        );
      }
    } else if (effectiveMaxCost != null && est.costPerFctUsd > effectiveMaxCost) {
      const relaxNoteCost =
        effectiveMaxCost !== MAX_COST_PER_FCT_USD
          ? " (relaxed to $" + (effectiveMaxCost ?? 0).toFixed(6) + ")"
          : "";
      console.log(
        chalk.yellow(
          "Gate: Cost/FCT $" +
            est.costPerFctUsd.toFixed(6) +
            " > MAX_COST_PER_FCT_USD $" +
            MAX_COST_PER_FCT_USD +
            relaxNoteCost +
            ". Waiting... (cycle " +
            (waitCycles + 1) +
            ")"
        )
      );
      if (!loopForever) return;
      scheduleNext();
    }

    // If any gate scheduled the next iteration, honor it here
    if (shouldNext) {
      await new Promise((r) => setTimeout(r, nextDelayMs));
      waitCycles++;

    }

    if (!shouldNext) {
    // Determine spend cap
    let spendCap: bigint;
    if (AUTO_SPEND_MODE === "all") {
      const buffer = balance / 100n; // 1% buffer without float conversions
      spendCap = balance > buffer ? balance - buffer : balance;
      console.log(
        chalk.cyan(
          "Auto spend mode: ALL (cap " +
            formatEther(spendCap) +
            " ETH, buffer " +
            formatEther(buffer) +
            " ETH)"
        )
      );
    } else {
      const capEth = AUTO_SPEND_CAP_ETH ?? 0;
      if (!capEth || capEth <= 0) {
        if (AUTO_TARGET_TXS && AUTO_TARGET_TXS > 0) {
          // Derive cap from target tx count with 10% buffer
          const txs = BigInt(AUTO_TARGET_TXS);
          const buffered = (est.estimatedEthBurn * 11n) / 10n;
          spendCap = buffered * txs;
          console.log(
            chalk.cyan(
              "Auto spend cap from AUTO_TARGET_TXS=" +
                AUTO_TARGET_TXS +
                ": " +
                formatEther(spendCap) +
                " ETH"
            )
          );
        } else {
          console.log(chalk.red("SPEND_MODE=cap requires SPEND_CAP_ETH or AUTO_TARGET_TXS."));
          return;
        }
      } else {
        spendCap = BigInt(Math.floor(capEth * 1e18));
      }
      if (spendCap > balance) {
        console.log(
          chalk.red(
            "SPEND_CAP_ETH " + capEth + " exceeds wallet balance " + formatEther(balance)
          )
        );
        return;
      }
      // Ensure we can afford at least one transaction
      const minCap = (est.estimatedEthBurn * 11n) / 10n; // +10% buffer
      if (spendCap < minCap) {
        console.log(
          chalk.yellow(
            "Adjusting spend cap up to cover at least 1 tx: " +
              formatEther(minCap) +
              " ETH"
          )
        );
        spendCap = minCap;
        if (spendCap > balance) {
          // Leave small buffer
          const buffer = balance / 100n;
          if (balance > buffer) spendCap = balance - buffer; else spendCap = balance;
        }
      }
      console.log(
        chalk.cyan("Auto spend cap (final): " + formatEther(spendCap) + " ETH")
      );
    }

    // Run mining loop
    await miningLoop(spendCap, ethPriceUsd, est.sizeBytes);
    waitCycles = 0; // reset on successful run

    if (!loopForever) return;
    // Short cooldown before next cycle
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_SEC * 1000));
    }
  }
}

// 杞婚噺鍗曟鎸栫熆灏佽锛氭瀯閫犲ぇ payload 骞跺彂閫?Facet 浜ゆ槗锛岃繑鍥炲叧閿寚鏍?
export async function mineOnce(opts: {
  perTxKB: number;
  maxEthWei: bigint; // 褰撳墠绛栫暐寤鸿鐨勬渶澶ф姇鍏ワ紙鎸?rate 涓庡墿浣欎骇閲忔姌绠楋級锛岀敤浜庢棩蹇楀睍绀?
}): Promise<{
  receipt: { gasUsed: bigint; effectiveGasPrice: bigint };
  dataGas: bigint;
  baseFeePerGas: bigint;
  rateAtBlock: bigint;
  fctMintedWei: bigint;
}> {
  const actualKb = Math.max(1, Math.floor(opts.perTxKB));
  const dataSize = actualKb * 1024;
  const overheadBytes = 160;
  const mineBoostSize = dataSize - overheadBytes;
  const mineBoostData = createMineBoostData(mineBoostSize);

  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;
  const rateAtBlock = await getFctMintRate(networkConfig.l1Chain.id);

  const baseExecutionGas = 21000n;
  const inputGas = calculateDataGas(mineBoostData) + baseExecutionGas;
  const dataGas = inputGas - baseExecutionGas;

  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const blk3 = await publicClient.getBlock();
  const baseFee3 = blk3.baseFeePerGas || (await publicClient.getGasPrice());
  const maxPriorityFeePerGas3 = 0n;
  const maxFeePerGas3 = BigInt(Math.floor(Number(baseFee3) * gasPriceMultiplier));

  const l1Nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });

  const { l1TransactionHash, facetTransactionHash } = await sendRawFacetTransaction(
    networkConfig.l1Chain.id,
    account.address,
    {
      to: account.address,
      value: (VALUE_ETH && VALUE_ETH > 0) ? BigInt(Math.floor(VALUE_ETH * 1e18)) : 0n,
      data: "0x",
      mineBoost: toHex(mineBoostData),
    },
    (l1Transaction) => {
      return (walletClient as any).sendTransaction({
        ...l1Transaction,
        account,
        maxFeePerGas: maxFeePerGas3,
        maxPriorityFeePerGas: maxPriorityFeePerGas3,
        nonce: l1Nonce,
      } as any);
    }
  );

  const l1Receipt = await publicClient.waitForTransactionReceipt({ hash: l1TransactionHash as `0x${string}` });

  let minted: bigint = 0n;
  try {
    await facetClient.waitForTransactionReceipt({ hash: facetTransactionHash as `0x${string}`, timeout: 60_000 });
    const facetTx = await facetClient.getTransaction({ hash: facetTransactionHash as `0x${string}` });
    if (facetTx && "mint" in facetTx && facetTx.mint) {
      minted = BigInt(facetTx.mint as string | number | bigint);
    }
  } catch {}

  return {
    receipt: { gasUsed: l1Receipt.gasUsed ?? 0n, effectiveGasPrice: (l1Receipt as any).effectiveGasPrice ?? boostedGasPrice },
    dataGas,
    baseFeePerGas: baseFee,
    rateAtBlock,
    fctMintedWei: minted,
  };
}

async function startMiningSession() {
  ui.showHeader(getCurrentNetwork(), account.address);

  // Get wallet balance
  const balance = await publicClient.getBalance({
    address: account.address,
  });

  // Get ETH price for USD calculations
  const ethPriceUsd = await getEthPriceInUsd();
  const balanceUsd = Number(formatEther(balance)) * ethPriceUsd;

  // Show system info in dashboard style
  ui.showSystemInfo(
    getCurrentNetwork(),
    account.address,
    formatEther(balance),
    ethPriceUsd,
    balanceUsd
  );

  if (balance === 0n) {
    console.log(chalk.red("Error: Wallet has no ETH to spend"));
    return;
  }

  // Show mining options header
  ui.showMiningOptions();

  // Ask for mining size first so user knows transaction costs
  const sizeResult = await selectMiningSize(ethPriceUsd);
  if (!sizeResult) {
    console.log("Mining cancelled");
    return;
  }

  const { selectedSize, estimatedCostPerTx } = sizeResult;

  // Now ask for spend cap with knowledge of transaction costs
  ui.showSpendingOptions(
    formatEther(estimatedCostPerTx),
    "$" + (Number(formatEther(estimatedCostPerTx)) * ethPriceUsd).toFixed(2)
  );

  const spendChoice = await prompt("\nChoose option (1 or 2): ");

  let spendCap: bigint;

  if (spendChoice === "1") {
    // Leave a small buffer for gas on the final transaction
    const buffer = balance / 100n; // 1% buffer
    spendCap = balance > buffer ? balance - buffer : balance;
    ui.showSpendingChoice(
      "all",
      "(" +
        formatEther(spendCap) +
        " ETH, leaving " +
        formatEther(buffer) +
        " ETH buffer)"
    );
  } else if (spendChoice === "2") {
    const capInput = await prompt("Enter ETH spending cap (e.g., 0.01): ");
    const capFloat = parseFloat(capInput);

    if (isNaN(capFloat) || capFloat <= 0) {
      console.log("Invalid spending cap");
      return;
    }

    spendCap = BigInt(Math.floor(capFloat * 1e18)); // Convert to wei

    if (spendCap > balance) {
      console.log(
        "Spending cap (" +
          formatEther(spendCap) +
          " ETH) exceeds wallet balance (" +
          formatEther(balance) +
          " ETH)"
      );
      return;
    }

    const estimatedTxCount = Math.floor(
      Number(spendCap) / Number(estimatedCostPerTx)
    );
    ui.showSpendingChoice(
      "cap",
      formatEther(spendCap) + " ETH (~" + estimatedTxCount + " transactions)"
    );
  } else {
    console.log("Invalid choice");
    return;
  }

  // Start mining loop
  await miningLoop(spendCap, ethPriceUsd, selectedSize);
}

main().catch(console.error);




// 可选：在控制台显示实时市场价格（事件优先）
function startMarketTickerIfEnabled() {
  const enabled = String(process.env.MARKET_TICKER || 'true').toLowerCase() !== 'false';
  if (!enabled || !isMainnet()) return;
  watchPairPrice((u) => {
    ui.showPriceUpdate({ source: u.source, ethPerFctFp18: u.ethPerFctFp18, slippageBps: u.slippageBps });
  }).catch(() => {});
}



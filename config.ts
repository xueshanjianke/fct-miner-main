import { mainnet, sepolia } from "viem/chains";
import * as dotenv from "dotenv";

dotenv.config();

export type NetworkConfig = {
  l1Chain: typeof mainnet | typeof sepolia;
  l1RpcUrl: string;
  facetChain: {
    id: number;
    name: string;
    nativeCurrency: { decimals: number; name: string; symbol: string };
    rpcUrls: { default: { http: string[] }; public: { http: string[] } };
    blockExplorers: { default: { name: string; url: string } };
  };
  facetRpcUrl: string;
  fctWethPair?: string;
  wethAddress?: string;
  wfctAddress?: string;
  uniswapV2Router?: string;
  uniswapV2RouterImpl?: string;
  dex?: string;
  fctPair?: string;
  baseToken?: string;
};

const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  mainnet: {
    l1Chain: mainnet,
    l1RpcUrl: "https://ethereum-rpc.publicnode.com",
    facetChain: {
      id: 0xface7,
      name: "Facet",
      nativeCurrency: { decimals: 18, name: "Facet Compute Token", symbol: "FCT" },
      rpcUrls: {
        default: { http: ["https://mainnet.facet.org"] },
        public: { http: ["https://mainnet.facet.org"] },
      },
      blockExplorers: { default: { name: "Facet Explorer", url: "https://explorer.facet.org" } },
    },
    facetRpcUrl: "https://mainnet.facet.org",
    fctWethPair: "0x180eF813f5C3C00e37b002Dfe90035A8143CE233",
    wethAddress: "0x1673540243E793B0e77C038D4a88448efF524DcE",
    wfctAddress: "0x4200000000000000000000000000000000000006",
    uniswapV2Router: "0xf29e6E319Ac4ce8C100cFC02B1702eb3D275029e",
    uniswapV2RouterImpl: "0x833445067749E4f9B01f5eEc151Df9942B0C2a62",
    dex: "facetswap",
    fctPair: "0x180eF813f5C3C00e37b002Dfe90035A8143CE233",
    baseToken: "0x4200000000000000000000000000000000000006",
  },
  sepolia: {
    l1Chain: sepolia,
    l1RpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    facetChain: {
      id: 0xface71a,
      name: "Facet Sepolia",
      nativeCurrency: { decimals: 18, name: "Facet Compute Token", symbol: "FCT" },
      rpcUrls: {
        default: { http: ["https://sepolia.facet.org"] },
        public: { http: ["https://sepolia.facet.org"] },
      },
      blockExplorers: { default: { name: "Facet Sepolia Explorer", url: "https://sepolia.explorer.facet.org" } },
    },
    facetRpcUrl: "https://sepolia.facet.org",
  },
};

export function getNetworkConfig(): NetworkConfig {
  const network = process.env.NETWORK || "mainnet";
  const cfg = NETWORK_CONFIGS[network];
  if (!cfg) throw new Error(`Unsupported network: ${network}. Supported: ${Object.keys(NETWORK_CONFIGS).join(", ")}`);
  return {
    ...cfg,
    l1RpcUrl: process.env.L1_RPC_URL || cfg.l1RpcUrl,
    facetRpcUrl: process.env.FACET_RPC_URL || cfg.facetRpcUrl,
  };
}

export function getCurrentNetwork(): string {
  return process.env.NETWORK || "mainnet";
}

export function isMainnet(): boolean {
  return getCurrentNetwork() === "mainnet";
}

export function isSepolia(): boolean {
  return getCurrentNetwork() === "sepolia";
}

const env = process.env as Record<string, string | undefined>;
export const STRATEGY = {
  rateFloorWeiPerEth: env.RATE_FLOOR_WEI_PER_ETH ? BigInt(env.RATE_FLOOR_WEI_PER_ETH) : undefined,
  bWait: Number(env.B_WAIT ?? 40),
  uWeak: Number(env.U_WEAK ?? 0.6),
  alpha: Number(env.ALPHA ?? 0.9),
  eHigh: Number(env.E_HIGH ?? 0.9),
  perTxKB: Number(env.PER_TX_KB ?? 128),
  budgetEth: env.BUDGET_ETH ?? "0.5",
  loopIntervalMs: Number(env.LOOP_INTERVAL_MS ?? 12000),
  maxProgress: Number(env.MAX_PROGRESS ?? 0.3),
  weakProgress: Number(env.WEAK_PROGRESS ?? 0.6),
  effDefault: Number(env.EFF_DEFAULT ?? 0.995),
  targetDiscount: Number(env.TARGET_DISCOUNT ?? 0.2),
  minAbsEdgeUsd: Number(env.MIN_ABS_EDGE_USD ?? 50),
  slipMax: Number(env.SLIP_MAX ?? 0.008),
  grid: env.GRID ?? "2x:0.3,3x:0.3,5x:0.2",
  trailPct: Number(env.TRAIL_PCT ?? 0.12),
  tMaxHoldH: Number(env.T_MAX_HOLD_H ?? 168),
  minRoi: Number(env.MIN_ROI ?? 0.2),
  usePrivateRelay: env.USE_PRIVATE_RELAY === "true",
  minOutSafetyBps: Number(env.MIN_OUT_SAFETY_BPS ?? 50),
  maxProgressToMine: Number(env.MAX_PROGRESS_TO_MINE ?? 0.3),
  minBlocksLeft: Number(env.MIN_BLOCKS_LEFT ?? 250),
  fctFyiJsonUrl: env.FCT_FYI_JSON_URL,
  useFctTiming: env.USE_FCT_TIMING === "true",
} as const;



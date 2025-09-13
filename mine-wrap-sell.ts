import * as dotenv from 'dotenv';
import { formatEther, parseEther, toHex, createPublicClient, createWalletClient, http, parseAbi, encodeAbiParameters, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getNetworkConfig, isMainnet } from './config';
// Avoid importing facet-miner/facet-swapper at top-level to bypass their env guards.
import { sendRawFacetTransaction, getFctMintRate } from '@0xfacet/sdk/utils';
// NOTE: Avoid top-level import from facet-swapper to prevent env checks from exiting early.

dotenv.config();

function envBool(name: string, def = false): boolean {
  const v = (process.env[name] || '').toLowerCase().trim();
  if (['1','true','yes','y'].includes(v)) return true;
  if (['0','false','no','n'].includes(v)) return false;
  return def;
}

function envNum(name: string, def?: number): number | undefined {
  const v = process.env[name];
  if (v == null || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function wrapFCT(amountWei: bigint, { dryRun }: { dryRun: boolean }): Promise<void> {
  const net = getNetworkConfig();
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) {
    if (dryRun) {
      console.log('[WRAP] DRY_RUN=true and no PRIVATE_KEY -> skip wrap simulate');
      return;
    }
    throw new Error('PRIVATE_KEY is required in .env');
  }
  const account = privateKeyToAccount(pk);
  const client = createPublicClient({ chain: net.facetChain, transport: http(net.facetRpcUrl) });
  const wallet = createWalletClient({ account, chain: net.facetChain, transport: http(net.facetRpcUrl) });

  const wfctAddr = net.wfctAddress as `0x${string}`;
  const abi = parseAbi([
    'function deposit() payable',
    'function balanceOf(address) view returns (uint256)'
  ]);

  console.log('[WRAP] start', JSON.stringify({ wfct: wfctAddr, account: account.address, amount_fct: formatEther(amountWei) }));
  const native = await client.getBalance({ address: account.address });
  console.log('[WRAP] native FCT balance =', formatEther(native));
  if (native < amountWei) {
    console.log('[WRAP] insufficient native FCT for deposit; need', formatEther(amountWei));
    return;
  }
  const before = await client.readContract({ address: wfctAddr, abi, functionName: 'balanceOf', args: [account.address] }) as bigint;
  console.log('[WRAP] before balance WFCT =', formatEther(before));

  const { request } = await client.simulateContract({ address: wfctAddr, abi, functionName: 'deposit', account, value: amountWei });
  console.log('[SIMULATE] deposit ok');
  if (dryRun) {
    console.log('[WRAP] DRY_RUN=true -> skip sending');
    return;
  }
  const hash = await wallet.writeContract(request);
  console.log('[WRAP] tx sent:', hash);
  try {
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
    console.log('[WRAP] confirmed block', receipt.blockNumber);
  } catch (e) {
    console.log('[WRAP] wait timeout, re-checking balance...');
  }
  const after = await client.readContract({ address: wfctAddr, abi, functionName: 'balanceOf', args: [account.address] }) as bigint;
  console.log('[WRAP] after balance WFCT =', formatEther(after));
  if (after <= before) {
    console.log('[WRAP] balance unchanged; wrap may be pending or failed. Proceeding to sell step if balance is sufficient.');
  }
}

async function main() {
  const DRY_RUN = envBool('DRY_RUN', true);
  const net = getNetworkConfig();
  console.log('[PIPE] network =', (process.env.NETWORK || '').toLowerCase() || 'default', 'l1 =', net.l1Chain.id, 'facet =', net.facetChain.id);

  // 1) Mine once (L1 -> Facet mint)
  const kb = Math.max(1, Math.floor(envNum('PIPE_MINE_KB', envNum('AUTO_MIN_SIZE_KB', 1) || 1)!));
  const capEth = envNum('MINE_MAX_ETH_PER_TX', 0.001700456147) as number; // ~ $8 default
  const maxEthWei = BigInt(Math.floor(capEth * 1e18));

  let minted: bigint = 0n;
  if (DRY_RUN) {
    console.log('[MINE] DRY_RUN=true -> skip sending. Would mine', kb, 'KB with max', capEth, 'ETH');
  } else {
    console.log('[MINE] start perTxKB=', kb, 'capETH=', capEth);
    const r = await mineOnceLite({ perTxKB: kb });
    const spentWei = (r.gasUsed ?? 0n) * (r.effectiveGasPrice ?? 0n);
    minted = r.fctMintedWei ?? 0n;
    console.log('[MINE] spentWei=', spentWei.toString(), 'mintedFCT=', formatEther(minted));
  }

  // 2) Wrap FCT -> WFCT (Facet L2)
  const wrapAmtStr = process.env.WRAP_FCT_AMOUNT || process.env.WRAP_AMOUNT_FCT;
  const wrapAmt = wrapAmtStr ? parseEther(wrapAmtStr) : (minted > 0n ? minted : parseEther('0.001'));
  await wrapFCT(wrapAmt, { dryRun: DRY_RUN });

  // 3) Sell WFCT -> WETH (mainnet only)
  if (!isMainnet()) {
    console.log('[SELL] skip: not on mainnet');
    return;
  }

  const minTradeFct = parseEther(String(envNum('MIN_TRADE_FCT', 0.001) || 0.001));
  const maxSlipBps = Math.max(1, Math.min(10_000, Math.floor(envNum('CHUNK_PCT', 0.8)! * 100))) || 80; // if CHUNK_PCT=0.8 -> 80 bps
  const safetyBps = Math.max(0, Math.min(5_000, Math.floor(envNum('MINOUT_SAFETY_BPS', 50)!)));

  if (DRY_RUN) {
    console.log('[SELL] DRY_RUN=true -> simulate slicing');
    try {
      // Lightweight on-chain reserves read without importing facet-swapper
      const pair = (net as any).fctWethPair as `0x${string}` | undefined;
      if (!pair) throw new Error('No pair configured');
      const client = createPublicClient({ chain: net.facetChain, transport: http(net.facetRpcUrl) });
      const UNISWAP_V2_PAIR_ABI = parseAbi([
        'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
      ]);
      const [RxFCT, RyETH] = await (async () => {
        const r = await client.readContract({ address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves' }) as readonly [bigint,bigint,bigint];
        // facet-swapper assumes token0=WETH, token1=FCT; adapt to that order
        // Here we trust config pair ordering as in facet-swapper (reserve0=WETH, reserve1=FCT)
        const reserve0 = r[0];
        const reserve1 = r[1];
        const Rx = reserve1; // FCT
        const Ry = reserve0; // ETH
        return [Rx, Ry] as const;
      })();
      const slices = (function splitForSlippage(totalWFCT: bigint, Rx: bigint, Ry: bigint, maxSlippageBps: number): bigint[] {
        if (totalWFCT <= 0n) return [];
        if (Rx <= 0n || Ry <= 0n) return [totalWFCT];
        const bps = Math.max(1, Math.min(10_000, Math.floor(maxSlippageBps)));
        let approxSlice = (Rx * BigInt(bps)) / 10_000n;
        if (approxSlice <= 0n) approxSlice = 1n;
        let num = Number((totalWFCT + approxSlice - 1n) / approxSlice);
        const MAX_SLICES = 50;
        if (num > MAX_SLICES) num = MAX_SLICES;
        if (num < 1) num = 1;
        const base = totalWFCT / BigInt(num);
        let rem = totalWFCT % BigInt(num);
        const out: bigint[] = [];
        for (let i = 0; i < num; i++) { const extra = rem > 0n ? 1n : 0n; if (rem > 0n) rem -= 1n; out.push(base + extra); }
        return out.filter(x => x > 0n);
      })(minTradeFct, RxFCT, RyETH, maxSlipBps);
      console.log('[SELL] slices for', formatEther(minTradeFct), 'FCT =', slices.length);
    } catch (e) {
      console.log('[SELL] quote failed (maybe testnet):', e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // Live sell: sell at least MIN_TRADE_FCT (or the wrapped amount if different env)
  const sellAmtStr = process.env.SELL_WFCT_AMOUNT;
  const sellAmtCfg = sellAmtStr ? parseEther(sellAmtStr) : minTradeFct;
  // Clamp to available WFCT balance
  const net2 = getNetworkConfig();
  const pk2 = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  const account2 = pk2 ? privateKeyToAccount(pk2) : undefined;
  const client2 = account2 ? createPublicClient({ chain: net2.facetChain, transport: http(net2.facetRpcUrl) }) : undefined;
  const wfctAddr2 = net2.wfctAddress as `0x${string}`;
  let sellAmt = sellAmtCfg;
  try {
    if (client2 && account2) {
      const abi2 = parseAbi(['function balanceOf(address) view returns (uint256)']);
      const bal = await client2.readContract({ address: wfctAddr2, abi: abi2, functionName: 'balanceOf', args: [account2.address] }) as bigint;
      if (bal <= 0n) { console.log('[SELL] no WFCT balance, skip sell'); return; }
      if (bal < sellAmt) { console.log('[SELL] clamp to available WFCT:', formatEther(bal)); sellAmt = bal; }
    }
  } catch {}
  if (sellAmt <= 0n) {
    console.log('[SELL] nothing to sell');
    return;
  }

  console.log('[SELL] start amount WFCT =', formatEther(sellAmt), 'maxSlipBps =', maxSlipBps, 'safetyBps =', safetyBps);
  // Defer import to avoid top-level env checks in facet-swapper
  const txHash = await sellWfctLite(sellAmt, safetyBps);
  console.log('[SELL] sent tx:', txHash);
}

main().catch((e) => { console.error('[ERROR] pipeline failed', e); process.exit(1); });

// Minimal local miner to avoid importing facet-miner.ts (which imports facet-swapper at top level)
async function mineOnceLite(opts: { perTxKB: number }): Promise<{ gasUsed: bigint; effectiveGasPrice: bigint; fctMintedWei?: bigint }>{
  const net = getNetworkConfig();
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error('PRIVATE_KEY is required in .env');
  const account = privateKeyToAccount(pk);
  const l1 = createPublicClient({ chain: net.l1Chain, transport: http(net.l1RpcUrl) });
  const l2 = createPublicClient({ chain: net.facetChain, transport: http(net.facetRpcUrl) });
  const wallet = createWalletClient({ account, chain: net.l1Chain, transport: http(net.l1RpcUrl) });

  const kb = Math.max(1, Math.floor(opts.perTxKB));
  const overhead = 160;
  const bytes = Math.max(0, kb * 1024 - overhead);
  const payload = new Uint8Array(bytes);
  payload.fill(0xaa);

  const base = await l1.getBlock();
  const baseFee = base.baseFeePerGas || (await l1.getGasPrice());
  const mult = Number(process.env.GAS_PRICE_MULTIPLIER ?? '1.0');
  const priorityGwei = Number(process.env.PRIORITY_GWEI ?? '1');
  const priorityWei = BigInt(Math.floor(Math.max(0, priorityGwei) * 1e9));
  const baseAdj = BigInt(Math.floor(Number(baseFee) * (isFinite(mult) && mult > 0 ? mult : 1)));
  const maxPriorityFeePerGas = priorityWei;
  const maxFeePerGas = baseAdj + maxPriorityFeePerGas;

  const valEth = Number(process.env.VALUE_ETH || '0');
  const valueWei = valEth > 0 ? BigInt(Math.floor(valEth * 1e18)) : 0n;

  const { l1TransactionHash, facetTransactionHash } = await sendRawFacetTransaction(
    net.l1Chain.id,
    account.address,
    { to: account.address, value: valueWei, data: '0x', mineBoost: toHex(payload) },
    (l1Tx) => (wallet as any).sendTransaction({ ...l1Tx, account, maxFeePerGas, maxPriorityFeePerGas } as any)
  );

  const r = await l1.waitForTransactionReceipt({ hash: l1TransactionHash as `0x${string}`, timeout: 300_000 });

  let minted: bigint | undefined;
  try {
    await l2.waitForTransactionReceipt({ hash: facetTransactionHash as `0x${string}`, timeout: 180_000 });
    const ftx: any = await l2.getTransaction({ hash: facetTransactionHash as `0x${string}` });
    if (ftx && typeof ftx.mint !== 'undefined') {
      minted = BigInt(ftx.mint as any);
    }
  } catch {}

  return { gasUsed: r.gasUsed ?? 0n, effectiveGasPrice: (r as any).effectiveGasPrice ?? maxFeePerGas, fctMintedWei: minted };
}

// Minimal sell: WFCT -> WETH on Facet via Uniswap V2 Router
async function sellWfctLite(amountIn: bigint, minOutBpsSafety: number): Promise<`0x${string}`> {
  const net = getNetworkConfig();
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error('PRIVATE_KEY is required in .env');
  const account = privateKeyToAccount(pk);
  const client = createPublicClient({ chain: net.facetChain, transport: http(net.facetRpcUrl) });
  const wallet = createWalletClient({ account, chain: net.facetChain, transport: http(net.facetRpcUrl) });

  const WETH = net.wethAddress as `0x${string}`;
  const WFCT = net.wfctAddress as `0x${string}`;
  const PAIR = ((process.env.PAIR as `0x${string}` | undefined) || (net as any).fctWethPair) as `0x${string}`;

  if (!WETH || !WFCT || !PAIR) throw new Error('Missing DEX addresses (WFCT/WETH/PAIR)');
  // Hard threshold: reject dust
  const MIN_SELL_UNIT_WFCT = process.env.MIN_SELL_UNIT_WFCT ? parseEther(String(process.env.MIN_SELL_UNIT_WFCT)) : 0n;
  if (MIN_SELL_UNIT_WFCT > 0n && amountIn < MIN_SELL_UNIT_WFCT) {
    throw new Error(`AMOUNT_IN_BELOW_MIN: ${formatEther(amountIn)} < MIN_SELL_UNIT_WFCT=${process.env.MIN_SELL_UNIT_WFCT}`);
  }

  // Compute minOut via reserves (fallback approach)
  const PAIR_ABI = parseAbi([
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
  ]);
  const [reserve0, reserve1] = await client.readContract({ address: PAIR, abi: PAIR_ABI, functionName: 'getReserves', blockTag: 'latest' }) as readonly [bigint,bigint,bigint];
  const t0 = await client.readContract({ address: PAIR, abi: PAIR_ABI, functionName: 'token0', blockTag: 'latest' }) as `0x${string}`;
  const t1 = await client.readContract({ address: PAIR, abi: PAIR_ABI, functionName: 'token1', blockTag: 'latest' }) as `0x${string}`;
  let RxFCT: bigint, RyETH: bigint;
  if (!(t0.toLowerCase() === WETH.toLowerCase() && t1.toLowerCase() === WFCT.toLowerCase())) {
    throw new Error(`PAIR_DIRECTION_UNEXPECTED: token0=${t0}, token1=${t1}, expect token0=WETH token1=WFCT`);
  }
  RxFCT = reserve1; RyETH = reserve0;
  console.log('[PAIR]', PAIR, 'token0=', t0, 'token1=', t1);
  console.log('[RESERVES] RxFCT=', formatEther(RxFCT), 'RyETH=', formatEther(RyETH));
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * RyETH;
  const denominator = RxFCT * 1000n + amountInWithFee;
  const outEst = denominator > 0n ? numerator / denominator : 0n;
  const minOut = (outEst * BigInt(10_000 - Math.max(0, Math.min(10_000, Math.floor(minOutBpsSafety))))) / 10_000n;
  console.log('[QUOTE]', 'in=', formatEther(amountIn), 'out≈', formatEther(outEst), 'minOut=', formatEther(minOut));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  // Direct Pair swap (transfer -> swap), avoids Router differences
  const ERC20_ABI = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
  const bal = await client.readContract({ address: WFCT, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as bigint;
  if (bal < amountIn) throw new Error('Insufficient WFCT balance');
  try {
    const allow = await client.readContract({ address: WFCT, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, PAIR] }) as bigint;
    console.log('[ALLOWANCE:PAIR]', formatEther(allow));
  } catch {}
  const pairBalBefore = await client.readContract({ address: WFCT, abi: ERC20_ABI, functionName: 'balanceOf', args: [PAIR] }) as bigint;
  const transferData = `0xa9059cbb${PAIR.slice(2).padStart(64, '0')}${amountIn.toString(16).padStart(64, '0')}`; // transfer(pair, amountIn)
  const tx1 = await (wallet as any).sendTransaction({ to: WFCT, value: 0n, data: transferData } as any);
  try { await client.waitForTransactionReceipt({ hash: tx1 as `0x${string}`, timeout: 600_000 }); } catch {}
  // Wait for pair to reflect tokenIn increment with exponential backoff
  const FALLBACK_TO_ROUTER = String(process.env.FALLBACK_TO_ROUTER ?? 'false').toLowerCase() === 'true';
  const PAIR_BAL_POLL_INIT_MS = Number(process.env.PAIR_BAL_POLL_INIT_MS ?? 200);
  const PAIR_BAL_POLL_BACKOFF = Number(process.env.PAIR_BAL_POLL_BACKOFF ?? 2.0);
  const PAIR_BAL_INC_TIMEOUT_MS = Number(process.env.PAIR_BAL_INC_TIMEOUT_MS ?? 30000);
  let observedIn: bigint | undefined;
  try {
    const { waitPairObservedIn } = await import('./src/lib/pair-wait');
    const res = await waitPairObservedIn({
      publicClient: client as any,
      tokenIn: WFCT,
      pair: PAIR,
      expectedMinIn: amountIn,
      initMs: PAIR_BAL_POLL_INIT_MS,
      backoff: PAIR_BAL_POLL_BACKOFF,
      timeoutMs: PAIR_BAL_INC_TIMEOUT_MS,
    });
    observedIn = res.observedIn;
    console.log('[OBS]', 'direction=WFCT→WETH', 'observedIn=', formatEther(observedIn), 'expectedMinIn=', formatEther(amountIn));
  } catch (e) {
    if (!FALLBACK_TO_ROUTER) throw e;
    console.log('[WARN] pair balance not updated; ROUTER_FALLBACK_USED=true');
    // Router fallback: approve and call supportingFeeOnTransfer
    const router = (process.env.ROUTER_ADDRESS as `0x${string}` | undefined) || (net.uniswapV2Router as `0x${string}` | undefined);
    if (!router) throw new Error('No router address provided for fallback');
    try {
      const allowR = await client.readContract({ address: WFCT, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, router], blockTag: 'latest' }) as bigint;
      if (allowR < amountIn) {
        const APPROVE_ABI = parseAbi(['function approve(address,uint256) returns (bool)']);
        await wallet.writeContract({ address: WFCT, abi: APPROVE_ABI, functionName: 'approve', args: [router, amountIn] });
      }
    } catch {}
    const V2_ROUTER_ABI = parseAbi(['function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
    const dl = BigInt(Math.floor(Date.now() / 1000) + 180);
    const { request } = await client.simulateContract({ address: router!, abi: V2_ROUTER_ABI, functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', args: [amountIn, minOut, [WFCT, WETH], account.address, dl], account });
    return await wallet.writeContract(request);
  }

  const PAIR_SWAP_ABI = parseAbi(['function swap(uint256,uint256,address,bytes)']);
  // Sell token1 (WFCT) -> buy token0 (WETH); compute from observedIn
  const { calcAmountOut } = await import('./src/lib/pair-wait');
  const amount0Out = calcAmountOut((observedIn ?? amountIn), reserve1, reserve0);
  const amount1Out = 0n;
  if (amount0Out <= 0n) throw new Error('ZERO_AMOUNT_OUT_COMPUTED');
  const beforeWfct = await client.readContract({ address: WFCT, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address], blockTag: 'latest' }) as bigint;
  const WETH_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
  const beforeWeth = await client.readContract({ address: WETH, abi: WETH_ABI, functionName: 'balanceOf', args: [account.address], blockTag: 'latest' }) as bigint;

  const { request } = await client.simulateContract({ address: PAIR, abi: PAIR_SWAP_ABI, functionName: 'swap', args: [amount0Out, amount1Out, account.address, '0x'], account });
  const tx2 = await wallet.writeContract(request);
  const rec2 = await client.waitForTransactionReceipt({ hash: tx2, timeout: 600_000 }).catch(() => undefined);
  // Post-trade deltas & logging
  const afterWfct = await client.readContract({ address: WFCT, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address], blockTag: 'latest' }) as bigint;
  const afterWeth = await client.readContract({ address: WETH, abi: WETH_ABI, functionName: 'balanceOf', args: [account.address], blockTag: 'latest' }) as bigint;
  const deltaWfct = afterWfct - beforeWfct;
  const deltaWeth = afterWeth - beforeWeth;
  console.log('[POST]', 'ΔWFCT=', formatEther(deltaWfct), 'ΔWETH=', formatEther(deltaWeth), 'confirmed=', !!rec2);
  return tx2 as `0x${string}`;
}

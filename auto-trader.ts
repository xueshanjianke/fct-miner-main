#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { getNetworkConfig } from './config';
import { getSpotEthPerFctFp18, getAddresses, getDecimals, mask, getReserves } from './autotrader/pricing';
import { applySell as ledgerApplySell, readLedger as ledgerRead } from './src/autotrader/ledger';
import { ensureApproveIfNeeded, readFctBalance, simulateAndSwapFCTForWETH, getAccountAddress } from './autotrader/swap';
import { createPublicClient, http, formatEther, BaseError, parseAbi } from 'viem';

dotenv.config();

function bps(n: number) { return Math.max(0, Math.min(10_000, Math.floor(n))); }

async function main() {
  const net = getNetworkConfig();
  const rpc = process.env.RPC_URL || net.facetRpcUrl;
  const publicClient = createPublicClient({ chain: net.facetChain, transport: http(rpc) });

  const TAKE_PROFIT = Number(process.env.TAKE_PROFIT ?? '0.12');
  const SLIPPAGE_BPS = bps(Number(process.env.SLIPPAGE_BPS ?? '100'));
  const MIN_TRADE_FCT = BigInt(process.env.MIN_TRADE_FCT ?? '1000000000000000000');
  const CHUNK_PCT = Math.max(0, Math.min(1, Number(process.env.CHUNK_PCT ?? '0.2')));
  const DRY_RUN = String(process.env.DRY_RUN).toLowerCase() === 'true';
  const POLL_MS = Math.max(5_000, Number(process.env.POLL_MS ?? '30000'));

  const { router, pair, fct, weth } = getAddresses();
  const dec = getDecimals();

  console.log(`[INFO] auto-trader started. DRY_RUN=${DRY_RUN} poll=${POLL_MS}ms`);
  console.log(`[INFO] router=${mask(router)} pair=${mask(pair)} fct=${mask(fct)} weth=${mask(weth)} decimals FCT=${dec.fct} WETH=${dec.weth}`);

  let backoff = POLL_MS;
  const backoffMax = 10 * 60 * 1000; // 10min

  for (;;) {
    try {
      const ledgerPath = process.env.LEDGER_PATH || './autotrader-ledger.json';
      const ledger = ledgerRead(ledgerPath);
      const inventory = BigInt(ledger.inventoryFCT);
      const wac = BigInt(ledger.wacEthPerFCT); // fp18 ETH/FCT

      const { priceFp18, ctx } = await getSpotEthPerFctFp18();
      console.log('[PRICE]', JSON.stringify({ px: priceFp18.toString(), source: 'pair', reserves: { reserve0: (ctx as any).reserve0?.toString?.() ?? undefined, reserve1: (ctx as any).reserve1?.toString?.() ?? undefined }, token0: mask(ctx.token0), token1: mask(ctx.token1) }));

      // Decide trade
      const trigger = priceFp18 >= (wac * BigInt(Math.floor((1 + TAKE_PROFIT) * 1e6))) / 1_000_000n;
      const chunkByPct = (inventory * BigInt(Math.floor(CHUNK_PCT * 1e6))) / 1_000_000n;
      let amountIn = inventory === 0n ? 0n : (chunkByPct > MIN_TRADE_FCT ? chunkByPct : MIN_TRADE_FCT);
      if (amountIn > inventory) amountIn = inventory;

      // Preview min_out for DECIDE log
      let minOutForLog = 0n;
      try {
        const V2_ROUTER_ABI = parseAbi(['function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)']);
        const arr = (await publicClient.readContract({ address: router, abi: V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, [fct, weth]] })) as bigint[];
        const est = arr?.[arr.length - 1] ?? 0n;
        minOutForLog = est > 0n ? (est * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : 0n;
      } catch {
        // Router quote failed, fallback to pair reserves
        try {
          const r = await getReserves();
          const is0Fct = r.token0.toLowerCase() === fct.toLowerCase();
          const reserveIn = is0Fct ? r.reserve0 : r.reserve1; // WFCT reserve
          const reserveOut = is0Fct ? r.reserve1 : r.reserve0; // WETH reserve
          const amtWithFee = amountIn * 997n;
          const outEst = (amtWithFee * reserveOut) / (reserveIn * 1000n + amtWithFee);
          minOutForLog = outEst > 0n ? (outEst * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : 0n;
          console.log('[PRICE]', JSON.stringify({ source: 'pair_fallback', reserve0: reserveIn.toString(), reserve1: reserveOut.toString() }));
        } catch {}
      }
      console.log('[DECIDE]', JSON.stringify({ wac: wac.toString(), tp: TAKE_PROFIT, hit_tp: trigger && inventory > 0n, inventory: inventory.toString(), amount_in: amountIn.toString(), min_out: minOutForLog.toString() }));

      if (!trigger || inventory === 0n) {
        console.log(`[DECIDE] skip reason=${inventory===0n?'no inventory':'below_take_profit'}`);
        backoff = POLL_MS; // healthy
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      // Ensure allowance (approve max) – simulate + write inside
      const owner = getAccountAddress();
      const bal = await readFctBalance(owner).catch(() => 0n);
      console.log(`[INFO] balanceFCT=${formatEther(bal||0n)} willSell=${formatEther(amountIn)} owner=${mask(owner)}`);
      console.log('[APPROVE] checking/ensuring allowance...');
      await ensureApproveIfNeeded(amountIn, DRY_RUN);

      // Simulate + swap
      console.log('[SIMULATE] start simulateContract for swapExactTokensForTokens');
      const hash = await simulateAndSwapFCTForWETH({ amountInFct: amountIn, slippageBps: SLIPPAGE_BPS, dryRun: DRY_RUN });
      if (!DRY_RUN && hash) {
        console.log('[SWAP] sent hash=', hash);
        console.log('[SWAP] waiting for confirmation (up to 5m)…');
        await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 });
        console.log('[LEDGER] applying sell to inventory');
        ledgerApplySell(ledgerPath, amountIn);
      } else if (DRY_RUN) {
        console.log('[SIMULATE] DRY_RUN done (no write).');
      }

      backoff = POLL_MS; // reset on success
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      if (e instanceof BaseError) {
        console.error('[ERROR] shortMessage:', e.shortMessage);
        console.error(e.walk());
      } else {
        console.error('[ERROR]', e);
      }
      backoff = Math.min(backoff * 2, backoffMax);
      console.log(`[WARN] backing off ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

main().catch((e) => {
  console.error('[ERR] fatal', e);
  process.exit(1);
});

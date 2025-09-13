#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { ensureApproveIfNeeded, simulateAndSwapFCTForWETH, getAccountAddress, readFctBalance } from './autotrader/swap';
import { getAddresses, mask } from './autotrader/pricing';
import { formatEther } from 'viem';
// 文件头加
console.log('>> smoke-swap 开始');
console.log('DRY_RUN=', process.env.DRY_RUN, 'ROUTER=', process.env.ROUTER);

dotenv.config();

async function main() {
  const { router, pair, fct, weth } = getAddresses();
  const DRY_RUN = String(process.env.DRY_RUN).toLowerCase() === 'true';
  const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '3000'); // 30% for smoke
  const amt = BigInt(process.env.SMOKE_TRADE_FCT ?? '1000000000000000'); // 0.001 FCT default

  console.log('[INFO] 烟囱测试（smoke test）');
  console.log(`[INFO] DRY_RUN=${DRY_RUN} 路由 router=${mask(router)} 交易对 pair=${mask(pair)} 路径 path=[${mask(fct)},${mask(weth)}] 输入 amountIn=${formatEther(amt)} FCT`);

  // Approve if needed (max approve)
  await ensureApproveIfNeeded(amt, DRY_RUN);

  // Simulate + optionally send
  const tx = await simulateAndSwapFCTForWETH({ amountInFct: amt, slippageBps: SLIPPAGE_BPS, dryRun: DRY_RUN });
  if (!DRY_RUN && tx) {
    console.log('[INFO] 已发送烟囱兑换（smoke swap sent）:', tx);
  } else {
    console.log('[INFO] 烟囱模拟成功（smoke simulate ok, DRY_RUN）');
  }
}

if (import.meta.main) {
  main().catch((e) => { console.error('[ERROR] 烟囱失败（smoke failed）', e); process.exit(1); });
}

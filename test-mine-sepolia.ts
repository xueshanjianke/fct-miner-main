import * as dotenv from 'dotenv';
import { mineOnce } from './facet-miner';
import { applyMint as ledgerApplyMint } from './src/autotrader/ledger';

dotenv.config();

async function main() {
  if ((process.env.NETWORK || '').toLowerCase() !== 'sepolia') {
    console.warn('[WARN] 非测试网（NETWORK != sepolia）。建议使用: pnpm test:mine:sepolia  | Not on sepolia; use: pnpm test:mine:sepolia');
  }
  const kb = Number(process.env.TEST_MINE_KB || '25');
  const spendEth = Number(process.env.TEST_MINE_SPEND_ETH || '0.00005');
  const maxEthWei = BigInt(Math.floor(spendEth * 1e18));

  const r = await mineOnce({ perTxKB: kb, maxEthWei });
  const ethSpentWei = (r.receipt.gasUsed ?? 0n) * (r.receipt.effectiveGasPrice ?? 0n);

  // Update ledger
  const ledgerPath = process.env.LEDGER_PATH || './autotrader-ledger.json';
  ledgerApplyMint(ledgerPath, r.fctMintedWei ?? 0n, ethSpentWei);

  // NDJSON output
  const line = {
    mint_event: {
      timestamp: Date.now(),
      l1_tx_hash: r.l1TxHash ?? null,
      data_gas: (r.dataGas ?? 0n).toString(),
      basefee_wei: (r.baseFeePerGas ?? 0n).toString(),
      eth_spent_wei: ethSpentWei.toString(),
      fct_minted: (r.fctMintedWei ?? 0n).toString(),
      rate_snapshot: (r.rateAtBlock ?? 0n).toString(),
    },
  };
  console.log(JSON.stringify(line));
}

main().catch((e) => { console.error('[ERROR] 测试网挖矿失败（test:mine:sepolia failed）', e); process.exit(1); });

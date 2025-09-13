#!/usr/bin/env tsx
import * as fs from "fs";
import * as path from "path";

const SUPPORTED_NETWORKS = ["mainnet", "sepolia"];

// 将 .env 中的 NETWORK 更新为指定网络（不存在则追加一行）
function updateEnvFile(network: string) {
  const envPath = path.join(process.cwd(), ".env");

  if (!fs.existsSync(envPath)) {
    console.error("[ERROR] 未找到 .env 文件（.env file not found）");
    process.exit(1);
  }

  let envContent = fs.readFileSync(envPath, "utf-8");

  // Update the NETWORK line or add it if it doesn't exist
  if (envContent.includes("NETWORK=")) {
    envContent = envContent.replace(/NETWORK=.*/, `NETWORK=${network}`);
  } else {
    envContent += `\nNETWORK=${network}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log(`✅ Network switched to: ${network}`);
}

// 显示当前 .env 中的 NETWORK（若无则显示默认 mainnet）
function showCurrentNetwork() {
  const envPath = path.join(process.cwd(), ".env");

  if (!fs.existsSync(envPath)) {
    console.log("Current network: mainnet (default)");
    return;
  }

  const envContent = fs.readFileSync(envPath, "utf-8");
  const networkMatch = envContent.match(/NETWORK=(.*)/);
  const currentNetwork = networkMatch ? networkMatch[1].trim() : "mainnet";

  console.log(`Current network: ${currentNetwork}`);
}

// CLI 用法入口：network:show / network <network>
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log("  npm run network <network>   - Switch to network");
    console.log("  npm run network:show        - Show current network");
    console.log("");
    console.log("Supported networks:", SUPPORTED_NETWORKS.join(", "));
    showCurrentNetwork();
    process.exit(1);
  }

  const command = args[0];

  if (command === "show") {
    showCurrentNetwork();
    return;
  }

  if (!SUPPORTED_NETWORKS.includes(command)) {
    console.error(`[ERROR] 不支持的网络（Unsupported network）："${command}"`);
    console.error("[INFO] 支持的网络（Supported）:", SUPPORTED_NETWORKS.join(", "));
    process.exit(1);
  }

  updateEnvFile(command);

  // Show network-specific information
  if (command === "sepolia") {
    console.log("");
    console.log("🧪 Sepolia Testnet Configuration:");
    console.log("  - Get Sepolia ETH from: https://sepoliafaucet.com/");
    console.log("  - FCT trading/swapping not available on testnet");
    console.log("  - Lower gas costs for testing");
    console.log("  - Production mining with 100KB transactions");
  } else if (command === "mainnet") {
    console.log("");
    console.log("🚀 Mainnet Configuration:");
    console.log("  - Real ETH required for gas fees");
    console.log("  - FCT trading and price data available");
    console.log("  - Higher gas costs");
    console.log("  - Use: npm run mine (for production)");
  }
}

main();

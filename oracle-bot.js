import 'dotenv/config';
import axios from 'axios';
import { ethers } from 'ethers';
import OracleAbi from './abi/SimpleOracleForPredictionV3.json' assert { type: 'json' };

const {
  RPC_URL,
  ORACLE_ADDRESS,
  PRIVATE_KEY,
  ASSET = 'bitcoin',
  INTERVAL = 10000, // 10s to align with round timing
} = process.env;

if (!RPC_URL || !ORACLE_ADDRESS || !PRIVATE_KEY) {
  throw new Error('Missing RPC_URL, ORACLE_ADDRESS, or PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const oracle = new ethers.Contract(ORACLE_ADDRESS, OracleAbi, wallet);

// Fetch price from CoinGecko
async function fetchPrice() {
  try {
    const r = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ASSET}&vs_currencies=usd`
    );
    const price = r.data?.[ASSET]?.usd;
    if (!price) throw new Error('Price not found');
    return BigInt(Math.round(price * 1e8)); // Scale to 1e8
  } catch (err) {
    console.error(`[oracle-bot] ❌ Fetch price error: ${err.message}`);
    throw err;
  }
}

async function updateOracle() {
  try {
    const price = await fetchPrice();
    console.log(`[oracle-bot] Price: $${Number(price) / 1e8}`);

    const tx = await oracle.updatePrice(price, {
      gasLimit: 200000, // Reduced gas limit for efficiency
      gasPrice: ethers.parseUnits('1000', 'gwei'),
    });

    console.log(`[oracle-bot] Tx sent: ${tx.hash}`);
    await tx.wait(2); // Wait for 2 confirmations
    console.log(`[oracle-bot] ✅ Price updated`);
  } catch (e) {
    console.error(`[oracle-bot] ❌ Error: ${e.message}`);
  }
}

console.log(`[oracle-bot] Starting for ${ASSET}...`);
updateOracle();
setInterval(updateOracle, Number(INTERVAL));

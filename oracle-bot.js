// File: oracle-bot.js
import 'dotenv/config'
import axios from 'axios'
import { ethers } from 'ethers'
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: 'json' }
import OracleAbi from './abi/SimpleOracleForPredictionV3.json' assert { type: 'json' }

const {
  RPC_URL,
  ORACLE_ADDRESS,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  ASSET = 'BTCUSD',
  CHECK_INTERVAL = 5000,   // 5s updates
  GAS_LIMIT = 200000,
  GAS_PRICE_GWEI = 1000,
} = process.env

if (!RPC_URL || !ORACLE_ADDRESS || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error('Missing RPC_URL, ORACLE_ADDRESS, PREDICTION_ADDRESS, or PRIVATE_KEY')
}

const provider = new ethers.JsonRpcProvider(RPC_URL)
const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
const oracle = new ethers.Contract(ORACLE_ADDRESS, OracleAbi, wallet)
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, provider)

// --- Helpers ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC')
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// --- Fetch BTC price with fallback ---
async function fetchPrice() {
  // Primary: Binance.US BTCUSDT
  try {
    const r = await axios.get('https://api.binance.us/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 5000 })
    const price = Number(r.data.price)
    if (price) return BigInt(Math.round(price * 1e8))
  } catch (err) {
    console.warn(`[oracle-bot] ⚠️ Binance.US failed: ${err.message}, trying fallback`)
  }

  // Fallback: CoinGecko (no geo-block)
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout: 5000 })
    const price = Number(r.data?.bitcoin?.usd)
    if (price) {
      console.log(`[oracle-bot] ℹ️ Using CoinGecko fallback price`)
      return BigInt(Math.round(price * 1e8))
    }
  } catch (err) {
    console.error(`[oracle-bot] ❌ CoinGecko fallback failed: ${err.message}`)
  }

  return null
}

// --- Push oracle update ---
async function pushPrice(price, nonceOverride) {
  const opts = {
    gasLimit: GAS_LIMIT,
    gasPrice: ethers.parseUnits(GAS_PRICE_GWEI.toString(), 'gwei'),
  }
  if (nonceOverride !== undefined) opts.nonce = nonceOverride

  const tx = await oracle.updatePrice(price, opts)
  console.log(`[oracle-bot] 🚀 Oracle update tx: ${tx.hash}, price=$${Number(price) / 1e8}`)
  await tx.wait(2)
  console.log(`[oracle-bot] ✅ Price confirmed on-chain`)
}

// --- Main loop ---
async function loop() {
  try {
    const epoch = Number(await prediction.currentEpoch())
    const round = await prediction.rounds(epoch)
    const now = Math.floor(Date.now() / 1000)

    console.log(`[oracle-bot] Monitor: epoch=${epoch}, now=${ts(now)}, lock=${ts(Number(round.lockTimestamp))}, close=${ts(Number(round.closeTimestamp))}, oracleCalled=${round.oracleCalled}`)

    const price = await fetchPrice()
    if (!price) return

    // Nonce safety
    const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending')
    const confirmedNonce = await provider.getTransactionCount(wallet.address, 'latest')
    let nonce = pendingNonce
    if (pendingNonce > confirmedNonce + 5) {
      console.warn(`[oracle-bot] ⚠️ Nonce gap detected, using confirmed=${confirmedNonce}`)
      nonce = confirmedNonce
    }

    await pushPrice(price, nonce)
  } catch (err) {
    console.error(`[oracle-bot] ❌ Loop error: ${err.message}`)
  }
}

// --- Startup ---
;(async () => {
  console.log(`[oracle-bot] Starting for ${ASSET} with wallet ${wallet.address}, interval=${CHECK_INTERVAL}ms...`)
  while (true) {
    await loop()
    await sleep(Number(CHECK_INTERVAL))
  }
})()

import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  CHECK_INTERVAL = 5000, // run every 5s (instead of 30s)
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30, // must match contract setting
  SAFE_DELAY = 2, // extra seconds after lock before executing
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or PRIVATE_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;

// --- Utility: format unix timestamp to UTC ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

// --- Utility: send tx safely with retry ---
async function sendTx(fn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tx = await fn({
        gasLimit: Number(GAS_LIMIT),
        maxFeePerGas: ethers.parseUnits("2000", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"),
      });
      console.log(`[operator-bot] Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      return receipt;
    } catch (err) {
      console.error(`[operator-bot] ❌ Error sending tx (try ${attempt}): ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// --- Genesis bootstrap (start + lock once) ---
async function bootstrapGenesis() {
  const genesisStartOnce = await prediction.genesisStartOnce();
  const genesisLockOnce = await prediction.genesisLockOnce();

  if (!genesisStartOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisStartRound...`);
    const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound executed (${receipt.hash})`);
    return true;
  }

  if (genesisStartOnce && !genesisLockOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisLockRound...`);
    const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound executed (${receipt.hash})`);
    return true;
  }

  return false;
}

// --- Main execution loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    // ✅ Execute right after lock + SAFE_DELAY
    if (
      lockTime > 0 &&
      now >= lockTime + Number(SAFE_DELAY) &&
      now <= lockTime + Number(BUFFER_SECONDS)
    ) {
      console.log(
        `[operator-bot] Executing round ${epoch.toString()}... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`
      );
      txPending = true;
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] ✅ Round executed (${receipt.hash})`);
      txPending = false;
    } else if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
      console.log(
        `[operator-bot] ⏩ Missed execution window for round ${epoch.toString()} (lock=${ts(lockTime)}). Skipping...`
      );
    } else {
      console.log(
        `[operator-bot] Waiting... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`
      );
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));

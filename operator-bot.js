import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  OPERATOR_KEY, // ✅ separate key just for operator
  CHECK_INTERVAL = 5000, // 5s
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,
  SAFE_DELAY = 2,
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or OPERATOR_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;

// --- Utility: format unix timestamp to UTC ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

// --- Utility: send tx safely ---
async function sendTx(fn) {
  const tx = await fn({
    gasLimit: Number(GAS_LIMIT),
    maxFeePerGas: ethers.parseUnits("1000", "gwei"),       // ✅ fixed at 1000
    maxPriorityFeePerGas: ethers.parseUnits("1000", "gwei") // ✅ fixed at 1000
  });
  console.log(`[operator-bot] Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt;
}

// --- Main execution loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    // 1. Bootstrap Genesis
    const genesisStartOnce = await prediction.genesisStartOnce();
    const genesisLockOnce = await prediction.genesisLockOnce();

    if (!genesisStartOnce) {
      console.log(`[operator-bot] ⚡ Calling genesisStartRound...`);
      txPending = true;
      const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
      console.log(`[operator-bot] ✅ genesisStartRound (${receipt.hash})`);
      txPending = false;
      return;
    }

    if (genesisStartOnce && !genesisLockOnce) {
      console.log(`[operator-bot] ⚡ Calling genesisLockRound...`);
      txPending = true;
      const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
      console.log(`[operator-bot] ✅ genesisLockRound (${receipt.hash})`);
      txPending = false;
      return;
    }

    // 2. After Genesis → normal execution
    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    if (
      lockTime > 0 &&
      now >= lockTime + Number(SAFE_DELAY) &&
      now <= lockTime + Number(BUFFER_SECONDS)
    ) {
      console.log(`[operator-bot] Executing round ${epoch.toString()}... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`);
      txPending = true;
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] ✅ executeRound (${receipt.hash})`);
      txPending = false;
    } else if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
      console.log(`[operator-bot] ⏩ Missed execution window for round ${epoch.toString()} (lock=${ts(lockTime)}). Skipping...`);
    } else {
      console.log(`[operator-bot] Waiting... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));

import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  CHECK_INTERVAL = 30000,
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30, // must match your contract's bufferSeconds
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or PRIVATE_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;

// --- Utility: Send tx with retry-safe gas settings ---
async function sendTx(fn) {
  try {
    const tx = await fn({
      gasLimit: Number(GAS_LIMIT),
      // Use maxFeePerGas + maxPriorityFeePerGas instead of fixed gasPrice
      maxFeePerGas: ethers.parseUnits("2000", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"),
    });
    console.log(`[operator-bot] Tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    return receipt;
  } catch (err) {
    console.error(`[operator-bot] ❌ Error sending tx: ${err.message}`);
    throw err;
  }
}

// --- Handle Genesis Start/Lock ---
async function bootstrapGenesis() {
  const genesisStartOnce = await prediction.genesisStartOnce();
  const genesisLockOnce = await prediction.genesisLockOnce();

  if (!genesisStartOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisStartRound...`);
    const tx = await sendTx(() => prediction.genesisStartRound);
    console.log(`[operator-bot] ✅ genesisStartRound executed (${tx.hash})`);
    return true;
  }

  if (genesisStartOnce && !genesisLockOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisLockRound...`);
    const tx = await sendTx(() => prediction.genesisLockRound);
    console.log(`[operator-bot] ✅ genesisLockRound executed (${tx.hash})`);
    return true;
  }

  return false;
}

// --- Main Loop ---
async function checkAndExecute() {
  if (txPending) return; // prevent overlapping txs

  try {
    // Run genesis if needed
    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    if (
      lockTime > 0 &&
      now >= lockTime &&
      now <= lockTime + Number(BUFFER_SECONDS)
    ) {
      console.log(`[operator-bot] Executing round ${epoch.toString()}...`);
      txPending = true;
      const tx = await sendTx(() => prediction.executeRound);
      console.log(`[operator-bot] ✅ Round executed (${tx.hash})`);
      txPending = false;
    } else {
      console.log(
        `[operator-bot] Waiting... now=${now} lock=${lockTime} close=${closeTime}`
      );
    }
  } catch (e) {
    console.error(`[operator-bot] ❌ Error: ${e.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));

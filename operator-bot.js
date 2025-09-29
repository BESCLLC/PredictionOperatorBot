import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  OPERATOR_KEY, // changed from PRIVATE_KEY so oracle can still use PRIVATE_KEY
  CHECK_INTERVAL = 5000, // every 5s
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
let genesisComplete = false;

// --- util: format unix timestamp ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

// --- util: send tx safely with 1000 gwei ---
async function sendTx(fn) {
  const opts = {
    gasLimit: Number(GAS_LIMIT),
    maxFeePerGas: ethers.parseUnits("1000", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1000", "gwei"),
  };
  const tx = await fn(opts);
  console.log(`[operator-bot] Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt;
}

// --- genesis bootstrap (only once) ---
async function bootstrapGenesis() {
  const genesisStartOnce = await prediction.genesisStartOnce();
  const genesisLockOnce = await prediction.genesisLockOnce();

  if (!genesisStartOnce) {
    console.log(`[operator-bot] ⚡ genesisStartRound...`);
    const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${receipt.hash})`);
    return;
  }

  if (genesisStartOnce && !genesisLockOnce) {
    console.log(`[operator-bot] ⚡ genesisLockRound...`);
    const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${receipt.hash})`);
    return;
  }

  // both true -> genesis done
  genesisComplete = true;
  console.log(`[operator-bot] ✅ Genesis complete. Switching to normal rounds.`);
}

// --- main loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    if (!genesisComplete) {
      await bootstrapGenesis();
      return;
    }

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
      console.log(
        `[operator-bot] Executing round ${epoch.toString()}... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`
      );
      txPending = true;
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] ✅ Round executed (${receipt.hash})`);
      txPending = false;
    } else if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
      console.log(
        `[operator-bot] ⏩ Missed round ${epoch.toString()} (lock=${ts(lockTime)}).`
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

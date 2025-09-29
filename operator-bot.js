import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  OPERATOR_KEY, // use a different key than oracle
  PREDICTION_ADDRESS,
  CHECK_INTERVAL = 5000, // check every 5s
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
let lastExecutedEpoch = 0;

// --- Format timestamp nicely ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

// --- Safe transaction sender ---
async function sendTx(fn) {
  const tx = await fn({
    gasLimit: Number(GAS_LIMIT),
    gasPrice: ethers.parseUnits("1000", "gwei"), // fixed 1000 gwei
  });
  console.log(`[operator-bot] Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt;
}

// --- Bootstrap genesis only once ---
let genesisComplete = false;
async function bootstrapGenesis() {
  if (genesisComplete) return false;

  const startOnce = await prediction.genesisStartOnce();
  const lockOnce = await prediction.genesisLockOnce();

  if (!startOnce) {
    console.log(`[operator-bot] ⚡ genesisStartRound`);
    const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${receipt.hash})`);
    return true;
  }

  if (startOnce && !lockOnce) {
    console.log(`[operator-bot] ⚡ genesisLockRound`);
    const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${receipt.hash})`);
    return true;
  }

  if (startOnce && lockOnce) {
    genesisComplete = true; // never touch genesis again
  }

  return false;
}

// --- Try to execute given epoch ---
async function tryExecute(epoch) {
  if (epoch <= lastExecutedEpoch) return;

  const round = await prediction.rounds(epoch);
  const now = Math.floor(Date.now() / 1000);

  const lockTime = Number(round.lockTimestamp);
  const closeTime = Number(round.closeTimestamp);
  const oracleCalled = round.oracleCalled;

  if (
    lockTime > 0 &&
    oracleCalled &&
    now >= lockTime + Number(SAFE_DELAY) &&
    now <= lockTime + Number(BUFFER_SECONDS)
  ) {
    console.log(`[operator-bot] Executing epoch ${epoch} now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`);
    txPending = true;
    try {
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] ✅ Executed epoch ${epoch} (${receipt.hash})`);
      lastExecutedEpoch = epoch;
    } catch (err) {
      console.error(`[operator-bot] ❌ Tx failed for epoch ${epoch}: ${err.message}`);
    }
    txPending = false;
    return true;
  }

  if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
    console.log(`[operator-bot] ⏩ Missed epoch ${epoch} (lock=${ts(lockTime)} close=${ts(closeTime)})`);
    lastExecutedEpoch = epoch;
  }

  return false;
}

// --- Main loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const currentEpoch = Number(await prediction.currentEpoch());

    // ✅ Always check last 3 epochs so bot never drifts
    for (let e = currentEpoch - 2; e <= currentEpoch; e++) {
      if (e > 0) {
        await tryExecute(e);
      }
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting with wallet ${wallet.address}...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));

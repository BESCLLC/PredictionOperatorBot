import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: 'json' };

const {
  RPC_URL,
  OPERATOR_KEY,
  PREDICTION_ADDRESS,
  CHECK_INTERVAL = 1000, // 1s for tight polling
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,   // Must match contract
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY) {
  throw new Error('Missing RPC_URL, PREDICTION_ADDRESS, or OPERATOR_KEY');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;
let lastHandledEpoch = 0;

// --- Helpers ---
function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTx(fn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const gasPrice = await provider.getGasPrice();
      const nonce = await provider.getTransactionCount(wallet.address, 'pending');
      const tx = await fn({
        gasLimit: Number(GAS_LIMIT),
        gasPrice,
        nonce,
      });
      console.log(
        `[operator-bot] 🚀 Tx sent: ${tx.hash}, nonce: ${nonce}, gasPrice: ${ethers.formatUnits(gasPrice, 'gwei')} Gwei`
      );
      const receipt = await tx.wait(2); // Wait for 2 confirmations
      return receipt;
    } catch (err) {
      console.error(`[operator-bot] ❌ Tx failed (try ${attempt}): ${err.message}`);
      if (attempt === 3) {
        console.error(`[operator-bot] ❌ Max retries reached for tx`);
        throw err;
      }
      await sleep(1000);
    }
  }
}

// --- Recovery ---
async function recover() {
  console.log(`[operator-bot] 🛠️ Recovery started for epoch ${await prediction.currentEpoch()}`);
  try {
    const isPaused = await prediction.paused({ blockTag: 'latest' });
    if (!isPaused) {
      console.log('[operator-bot] 🛑 Pausing...');
      await sendTx((opts) => prediction.pause(opts));
    }
    console.log('[operator-bot] ▶️ Unpausing...');
    await sendTx((opts) => prediction.unpause(opts));
    await bootstrapGenesis();
  } catch (err) {
    console.error(`[operator-bot] ❌ Recovery failed: ${err.message}`);
    await sleep(5000);
    await recover(); // Retry after delay
  }
}

// --- Genesis bootstrap ---
async function bootstrapGenesis() {
  const startOnce = await prediction.genesisStartOnce({ blockTag: 'latest' });
  const lockOnce = await prediction.genesisLockOnce({ blockTag: 'latest' });
  console.log(`[operator-bot] Genesis - StartOnce: ${startOnce}, LockOnce: ${lockOnce}`);

  if (!startOnce) {
    console.log('[operator-bot] ⚡ genesisStartRound');
    const r = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${r.hash})`);
    await sleep(1000);
    return true;
  }
  if (startOnce && !lockOnce) {
    console.log('[operator-bot] ⚡ genesisLockRound');
    const r = await sendTx((opts) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${r.hash})`);
    await sleep(1000);
    return true;
  }
  return false;
}

// --- Try execute an epoch ---
async function tryExecute(epoch) {
  if (epoch <= lastHandledEpoch) return false;

  const round = await prediction.rounds(epoch, { blockTag: 'latest' });
  const now = Math.floor(Date.now() / 1000);
  const lockTime = Number(round.lockTimestamp);
  const oracleCalled = round.oracleCalled;

  console.log(
    `[operator-bot] Checking epoch ${epoch}: Now=${ts(now)}, Lock=${ts(lockTime)}, OracleCalled=${oracleCalled}, In window=${now >= lockTime && now <= lockTime + Number(BUFFER_SECONDS)}`
  );

  // Valid execution window
  if (lockTime > 0 && oracleCalled && now >= lockTime && now <= lockTime + Number(BUFFER_SECONDS)) {
    console.log(`[operator-bot] ▶ Executing epoch ${epoch}`);
    txPending = true;
    try {
      const r = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] 🎯 Success: epoch ${epoch} (${r.hash})`);
      lastHandledEpoch = epoch;
      txPending = false;
      return true;
    } catch (err) {
      console.error(`[operator-bot] ❌ Failed epoch ${epoch}: ${err.message}`);
      txPending = false;
      return false; // Retry on next loop
    }
  }

  // Only mark as handled if window is definitively missed
  if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
    console.log(`[operator-bot] ⏩ Missed epoch ${epoch}`);
    lastHandledEpoch = epoch;
    return false;
  }

  return false;
}

// --- Main loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    // Validate configuration
    const contractBuffer = await prediction.bufferSeconds();
    if (Number(contractBuffer) !== Number(BUFFER_SECONDS)) {
      console.error(`[operator-bot] BUFFER_SECONDS mismatch: env=${BUFFER_SECONDS}, contract=${contractBuffer}`);
    }

    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const currentEpoch = Number(await prediction.currentEpoch({ blockTag: 'latest' }));

    // Prioritize current and next epoch, scan recent ones as fallback
    for (const e of [currentEpoch, currentEpoch + 1, ...Array.from({ length: 5 }, (_, i) => currentEpoch - i - 1)]) {
      if (e > 0 && e > lastHandledEpoch) {
        const executed = await tryExecute(e);
        if (executed) break; // Exit loop after successful execution
      }
    }

    // Check for stalled epochs and recover if needed
    if (currentEpoch <= lastHandledEpoch && currentEpoch > 0) {
      console.log(`[operator-bot] ⚠️ Epoch not advancing (current: ${currentEpoch}, last: ${lastHandledEpoch})`);
      const paused = await prediction.paused({ blockTag: 'latest' });
      if (!paused) await recover();
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

// --- Monitoring ---
setInterval(async () => {
  try {
    const epoch = await prediction.currentEpoch({ blockTag: 'latest' });
    const oracleRoundId = await prediction.oracleLatestRoundId();
    console.log(`[operator-bot] Monitor - Epoch: ${epoch}, Oracle Round ID: ${oracleRoundId}`);
  } catch (err) {
    console.error(`[operator-bot] ❌ Monitor error: ${err.message}`);
  }
}, 30000);

// Monitor RPC health
provider.on('error', (err) => console.error(`[operator-bot] ❌ RPC error: ${err.message}`));

// Validate operator
(async () => {
  try {
    const operator = await prediction.operatorAddress();
    if (operator !== wallet.address) {
      console.error(`[operator-bot] ❌ Wallet ${wallet.address} is not operator (${operator})`);
    } else {
      console.log(`[operator-bot] ✅ Wallet ${wallet.address} is operator`);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Operator check failed: ${err.message}`);
  }
})();

console.log(`[operator-bot] Starting with wallet ${wallet.address}...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));

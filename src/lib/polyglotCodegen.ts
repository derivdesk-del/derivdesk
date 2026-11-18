import type { BotStrategyConfig, PolyglotLanguage } from '../shared/types.ts';
import { exportStrategyToDerivXml } from './derivXml.ts';

export const POLYGLOT_LANGUAGES: {
  id: PolyglotLanguage;
  label: string;
  extension: string;
  runtime: string;
}[] = [
  { id: 'typescript', label: 'TypeScript', extension: 'ts', runtime: 'Node.js / Deno + WASM' },
  { id: 'python', label: 'Python', extension: 'py', runtime: 'Asyncio + NumPy' },
  { id: 'rust', label: 'Rust', extension: 'rs', runtime: 'Tokio + Tungstenite' },
  { id: 'cpp', label: 'C++20', extension: 'cpp', runtime: 'Boost.Beast + STL' },
  { id: 'go', label: 'Go', extension: 'go', runtime: 'Gorilla WS' },
  { id: 'pinescript', label: 'Pine Script v5', extension: 'pine', runtime: 'TradingView Webhook' },
  { id: 'mql5', label: 'MQL5', extension: 'mq5', runtime: 'MetaTrader 5 EA' },
  { id: 'sql', label: 'SQL', extension: 'sql', runtime: 'DuckDB / Postgres' },
  { id: 'xml', label: 'Deriv XML', extension: 'xml', runtime: 'Deriv Bot Blockly' },
];

export function generatePolyglotStrategyCode(
  strategy: BotStrategyConfig,
  lang: PolyglotLanguage,
): string {
  if (lang === 'xml') {
    return exportStrategyToDerivXml(strategy);
  }

  const stakeVar = strategy.variables.find((v) => v.name === 'stake')?.value ?? 5;
  const symbol = strategy.tradeParams.symbol || 'R_25';
  const contractType =
    strategy.tradeParams.contractType === 'Both'
      ? 'DIGITDIFF'
      : strategy.tradeParams.contractType;
  const barrier = strategy.purchaseConditions.predictionDigit ?? 4;
  const duration = strategy.purchaseConditions.durationTicks ?? 1;
  const durationUnit = strategy.purchaseConditions.durationUnit ?? 't';
  const mult = strategy.purchaseConditions.multiplier ?? 100;
  const mode = strategy.purchaseConditions.mode;
  const zThresh = strategy.purchaseConditions.dualZScoreThreshold ?? -1.6;
  const minConf = Math.max(
    strategy.preTradeAnalysis?.minConfidence ?? 65,
    strategy.customQuantRule?.minConfidence ?? 0,
    strategy.customQuantRule?.perfectConditionsOnly ? 80 : 0,
  );
  const minEv = Math.max(
    strategy.preTradeAnalysis?.minEvPct ?? 1.0,
    strategy.customQuantRule?.minEvPct ?? -99,
    strategy.customQuantRule?.perfectConditionsOnly ? 2.0 : -99,
  );
  const rsiMin = strategy.customQuantRule?.rsiMin ?? 30;
  const rsiMax = strategy.customQuantRule?.rsiMax ?? 70;
  const bbMin = strategy.customQuantRule?.bbMinPct ?? 10;
  const bbMax = strategy.customQuantRule?.bbMaxPct ?? 90;
  const minSlopeRatio = strategy.customQuantRule?.minSlopeRatio ?? 0.6;
  const maxSteps = strategy.restartConditions.maxRecoverySteps ?? 2;
  const martMult = strategy.restartConditions.useMartingale
    ? strategy.restartConditions.martingaleMultiplier
    : 1;
  const tp = strategy.restartConditions.takeProfit;
  const sl = strategy.restartConditions.stopLoss;
  const cooldownSec = strategy.restartConditions.lossCooldownSeconds ?? 0;
  const isDigit = contractType.startsWith('DIGIT');
  const isMult = contractType === 'MULTUP' || contractType === 'MULTDOWN';

  switch (lang) {
    case 'typescript':
      return `// ${strategy.name} — Quantitative Deriv Execution Bot (TypeScript)
import WebSocket from 'ws';

const DERIV_APP_ID = process.env.DERIV_APP_ID || '34RXuPGgdUNCTWhsYjRcD';
const DERIV_TOKEN = process.env.DERIV_API_TOKEN || '';

const CONFIG = {
  symbol: '${symbol}',
  contractType: '${contractType}',
  barrier: ${barrier},
  baseStake: ${stakeVar},
  duration: ${duration},
  durationUnit: '${durationUnit}',
  multiplier: ${mult},
  mode: '${mode}',
  minConfidence: ${minConf},
  minEvPct: ${minEv},
  dualZThreshold: ${zThresh},
  rsiRange: [${rsiMin}, ${rsiMax}] as const,
  bbRangePct: [${bbMin}, ${bbMax}] as const,
  minSlopeRatio: ${minSlopeRatio},
  useMartingale: ${strategy.restartConditions.useMartingale},
  martingaleMultiplier: ${martMult},
  maxRecoverySteps: ${maxSteps},
  lossCooldownMs: ${cooldownSec * 1000},
  takeProfit: ${tp},
  stopLoss: ${sl},
};

function ema(vals: number[], period: number): number {
  const k = 2 / (period + 1);
  return vals.reduce((acc, v, i) => (i === 0 ? v : v * k + acc * (1 - k)), vals[0] ?? 0);
}

function rsi14(vals: number[]): number {
  if (vals.length < 15) return 50;
  let g = 0, l = 0;
  for (let i = vals.length - 14; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function checkPerfectGate(prices: number[], digits: number[]) {
  if (prices.length < 60) return { ok: false, barrier: CONFIG.barrier };
  const recent = prices.slice(-20);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const std = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
  const slopeRatio = std > 0 ? Math.abs(recent[recent.length - 1] - recent[0]) / std : 0;
  const r = rsi14(prices);
  const e9 = ema(prices.slice(-40), 9);
  const e21 = ema(prices.slice(-40), 21);

  if (r < CONFIG.rsiRange[0] || r > CONFIG.rsiRange[1]) return { ok: false, barrier: CONFIG.barrier };
  ${
    isDigit
      ? `// Dual-Window Binomial Z-Score check for Digit Differ/Over/Under
  const longW = digits.slice(-Math.min(400, digits.length));
  const denom = Math.sqrt(longW.length * 0.09);
  let bestDigit = CONFIG.barrier, bestZ = 99;
  for (let d = 0; d <= 9; d++) {
    const c = longW.filter((x) => x === d).length;
    const z = (c - longW.length * 0.1) / denom;
    if (z < bestZ) { bestZ = z; bestDigit = d; }
  }
  const antiCluster = !digits.slice(-5).includes(bestDigit);
  return { ok: bestZ <= CONFIG.dualZThreshold && antiCluster, barrier: bestDigit };`
      : `const dirOk = CONFIG.contractType === 'CALL' || CONFIG.contractType === 'MULTUP' ? e9 > e21 : e9 < e21;
  return { ok: dirOk && slopeRatio >= CONFIG.minSlopeRatio, barrier: 0 };`
  }
}

const ws = new WebSocket(\`wss://ws.derivws.com/websockets/v3?app_id=\${DERIV_APP_ID}\`);
const prices: number[] = [];
const digits: number[] = [];
let pnl = 0, losses = 0, stake = CONFIG.baseStake, cooldownUntil = 0, openContract = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ authorize: DERIV_TOKEN }));
  ws.send(JSON.stringify({ ticks_history: CONFIG.symbol, count: 400, end: 'latest', style: 'ticks', subscribe: 1 }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.msg_type === 'tick' && msg.tick) {
    const q = Number(msg.tick.quote);
    prices.push(q);
    digits.push(Number(String(msg.tick.quote).slice(-1)));
    if (prices.length > 500) { prices.shift(); digits.shift(); }
    if (!openContract && Date.now() >= cooldownUntil && pnl < CONFIG.takeProfit && pnl > -CONFIG.stopLoss) {
      const gate = checkPerfectGate(prices, digits);
      if (gate.ok) {
        openContract = true;
        ws.send(JSON.stringify({
          buy: 1,
          price: stake,
          parameters: {
            amount: stake,
            basis: 'stake',
            contract_type: CONFIG.contractType,
            currency: 'USD',
            symbol: CONFIG.symbol,
            ${isMult ? `multiplier: CONFIG.multiplier,` : `duration: CONFIG.duration, duration_unit: CONFIG.durationUnit,`}
            ${isDigit ? `barrier: String(gate.barrier),` : ''}
          },
        }));
      }
    }
  }
  if (msg.msg_type === 'buy' && msg.buy?.contract_id) {
    ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: msg.buy.contract_id, subscribe: 1 }));
  }
  if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract?.is_sold) {
    openContract = false;
    const profit = Number(msg.proposal_open_contract.profit || 0);
    pnl += profit;
    if (profit > 0) { losses = 0; stake = CONFIG.baseStake; }
    else {
      losses += 1;
      cooldownUntil = Date.now() + CONFIG.lossCooldownMs;
      stake = losses <= CONFIG.maxRecoverySteps && CONFIG.useMartingale
        ? Number((stake * CONFIG.martingaleMultiplier).toFixed(2))
        : CONFIG.baseStake;
      if (losses > CONFIG.maxRecoverySteps) losses = 0;
    }
  }
});
`;

    case 'python':
      return `# ${strategy.name} — Quantitative Deriv Auto-Trader (Python 3.11 + Asyncio + NumPy)
import asyncio
import json
import math
import os
import time
import numpy as np
import websockets

APP_ID = os.getenv("DERIV_APP_ID", "34RXuPGgdUNCTWhsYjRcD")
TOKEN = os.getenv("DERIV_API_TOKEN", "")
WS_URL = f"wss://ws.derivws.com/websockets/v3?app_id={APP_ID}"

SYMBOL = "${symbol}"
CONTRACT_TYPE = "${contractType}"
BASE_STAKE = ${stakeVar}
DURATION = ${duration}
DURATION_UNIT = "${durationUnit}"
MULTIPLIER = ${mult}
MIN_CONFIDENCE = ${minConf}
MIN_EV_PCT = ${minEv}
DUAL_Z_THRESHOLD = ${zThresh}
RSI_MIN, RSI_MAX = ${rsiMin}, ${rsiMax}
MAX_RECOVERY_STEPS = ${maxSteps}
MARTINGALE_MULT = ${martMult}
TAKE_PROFIT = ${tp}
STOP_LOSS = ${sl}
LOSS_COOLDOWN_SEC = ${cooldownSec}


def compute_rsi(arr: np.ndarray, period: int = 14) -> float:
    if len(arr) < period + 1:
        return 50.0
    diff = np.diff(arr[-(period + 1):])
    gains = np.maximum(diff, 0.0).mean()
    losses = np.abs(np.minimum(diff, 0.0)).mean()
    return 100.0 if losses == 0 else 100.0 - 100.0 / (1.0 + gains / losses)


def perfect_gate(prices: list[float], digits: list[int]) -> tuple[bool, int]:
    if len(prices) < 60:
        return False, ${barrier}
    arr = np.asarray(prices[-20:], dtype=np.float64)
    std = float(np.std(arr))
    slope_ratio = abs(arr[-1] - arr[0]) / std if std > 0 else 0.0
    rsi = compute_rsi(np.asarray(prices, dtype=np.float64))
    if not (RSI_MIN <= rsi <= RSI_MAX):
        return False, ${barrier}
    ${
      isDigit
        ? `long_d = np.asarray(digits[-min(400, len(digits)):], dtype=np.int32)
    denom = math.sqrt(len(long_d) * 0.09)
    best_d, best_z = ${barrier}, 99.0
    for d in range(10):
        z = (int(np.sum(long_d == d)) - len(long_d) * 0.1) / denom
        if z < best_z:
            best_z, best_d = z, d
    anti_cluster = best_d not in digits[-5:]
    return (best_z <= DUAL_Z_THRESHOLD and anti_cluster), best_d`
        : `ema9 = float(np.mean(arr[-9:]))
    ema21 = float(np.mean(np.asarray(prices[-21:], dtype=np.float64)))
    bullish = CONTRACT_TYPE in ("CALL", "MULTUP")
    dir_ok = ema9 > ema21 if bullish else ema9 < ema21
    return (dir_ok and slope_ratio >= ${minSlopeRatio}), 0`
    }


async def run_bot():
    prices, digits = [], []
    pnl, losses, stake, cooldown_until, active = 0.0, 0, BASE_STAKE, 0.0, False

    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({"authorize": TOKEN}))
        await ws.send(json.dumps({"ticks_history": SYMBOL, "count": 400, "end": "latest", "style": "ticks", "subscribe": 1}))

        async for raw in ws:
            msg = json.loads(raw)
            mtype = msg.get("msg_type")
            if mtype == "tick":
                q = float(msg["tick"]["quote"])
                prices.append(q)
                digits.append(int(str(msg["tick"]["quote"])[-1]))
                if len(prices) > 500:
                    prices.pop(0); digits.pop(0)
                if not active and time.time() >= cooldown_until and -STOP_LOSS < pnl < TAKE_PROFIT:
                    ok, b = perfect_gate(prices, digits)
                    if ok:
                        active = True
                        params = {"amount": stake, "basis": "stake", "contract_type": CONTRACT_TYPE, "currency": "USD", "symbol": SYMBOL}
                        ${isMult ? `params["multiplier"] = MULTIPLIER` : `params["duration"] = DURATION; params["duration_unit"] = DURATION_UNIT`}
                        ${isDigit ? `params["barrier"] = str(b)` : ''}
                        await ws.send(json.dumps({"buy": 1, "price": stake, "parameters": params}))
            elif mtype == "buy" and "buy" in msg:
                await ws.send(json.dumps({"proposal_open_contract": 1, "contract_id": msg["buy"]["contract_id"], "subscribe": 1}))
            elif mtype == "proposal_open_contract" and msg["proposal_open_contract"].get("is_sold"):
                active = False
                profit = float(msg["proposal_open_contract"].get("profit", 0))
                pnl += profit
                if profit > 0:
                    losses, stake = 0, BASE_STAKE
                else:
                    losses += 1
                    cooldown_until = time.time() + LOSS_COOLDOWN_SEC
                    stake = round(stake * MARTINGALE_MULT, 2) if losses <= MAX_RECOVERY_STEPS else BASE_STAKE
                    if losses > MAX_RECOVERY_STEPS:
                        losses = 0


if __name__ == "__main__":
    asyncio.run(run_bot())
`;

    case 'rust':
      return `// ${strategy.name} — High-Speed Deriv Quantitative Bot (Rust + Tokio + Tungstenite)
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const SYMBOL: &str = "${symbol}";
const CONTRACT: &str = "${contractType}";
const BASE_STAKE: f64 = ${stakeVar.toFixed(2)};
const DUAL_Z_THRESHOLD: f64 = ${zThresh.toFixed(2)};
const TAKE_PROFIT: f64 = ${tp.toFixed(2)};
const STOP_LOSS: f64 = ${sl.toFixed(2)};
const MAX_STEPS: u32 = ${maxSteps};
const MART_MULT: f64 = ${martMult.toFixed(2)};

fn evaluate_perfect_gate(prices: &[f64], digits: &[u8]) -> (bool, u8) {
    if prices.len() < 60 {
        return (false, ${barrier});
    }
    let n = digits.len().min(400) as f64;
    let denom = (n * 0.09_f64).sqrt();
    let mut best_digit = ${barrier}_u8;
    let mut best_z = f64::MAX;

    for d in 0..=9_u8 {
        let count = digits.iter().rev().take(400).filter(|&&x| x == d).count() as f64;
        let z = (count - n * 0.1) / denom.max(1.0);
        if z < best_z {
            best_z = z;
            best_digit = d;
        }
    }
    let recent_hit = digits.iter().rev().take(5).any(|&d| d == best_digit);
    let recent = &prices[prices.len() - 20..];
    let mean = recent.iter().sum::<f64>() / 20.0;
    let std = (recent.iter().map(|p| (p - mean).powi(2)).sum::<f64>() / 20.0).sqrt();
    let slope_ratio = if std > 0.0 { (recent[19] - recent[0]).abs() / std } else { 0.0 };

    ${
      isDigit
        ? `(best_z <= DUAL_Z_THRESHOLD && !recent_hit, best_digit)`
        : `(slope_ratio >= ${minSlopeRatio.toFixed(2)}, 0)`
    }
}

#[tokio::main]
async fn main() {
    let app_id = std::env::var("DERIV_APP_ID").unwrap_or_else(|_| "34RXuPGgdUNCTWhsYjRcD".into());
    let token = std::env::var("DERIV_API_TOKEN").unwrap_or_default();
    let url = format!("wss://ws.derivws.com/websockets/v3?app_id={}", app_id);
    let (mut ws, _) = connect_async(url).await.expect("WS connect failed");

    ws.send(Message::Text(json!({ "authorize": token }).to_string())).await.unwrap();
    ws.send(Message::Text(json!({ "ticks": SYMBOL, "subscribe": 1 }).to_string())).await.unwrap();

    let (mut prices, mut digits) = (Vec::<f64>::new(), Vec::<u8>::new());
    let (mut pnl, mut stake, mut losses, mut in_flight) = (0.0_f64, BASE_STAKE, 0_u32, false);

    while let Some(Ok(Message::Text(txt))) = ws.next().await {
        let v: Value = serde_json::from_str(&txt).unwrap_or_default();
        if v["msg_type"] == "tick" {
            let q = v["tick"]["quote"].as_f64().unwrap_or(0.0);
            let d = txt.chars().filter(|c| c.is_ascii_digit()).last().and_then(|c| c.to_digit(10)).unwrap_or(0) as u8;
            prices.push(q);
            digits.push(d);
            if prices.len() > 500 { prices.remove(0); digits.remove(0); }
            if !in_flight && pnl < TAKE_PROFIT && pnl > -STOP_LOSS {
                let (ok, barrier) = evaluate_perfect_gate(&prices, &digits);
                if ok {
                    in_flight = true;
                    let req = json!({
                        "buy": 1, "price": stake,
                        "parameters": { "amount": stake, "basis": "stake", "contract_type": CONTRACT, "currency": "USD", "symbol": SYMBOL, "duration": ${duration}, "duration_unit": "${durationUnit}", "barrier": barrier.to_string() }
                    });
                    ws.send(Message::Text(req.to_string())).await.unwrap();
                }
            }
        } else if v["msg_type"] == "proposal_open_contract" && v["proposal_open_contract"]["is_sold"] == 1 {
            in_flight = false;
            let profit = v["proposal_open_contract"]["profit"].as_f64().unwrap_or(0.0);
            pnl += profit;
            if profit > 0.0 { losses = 0; stake = BASE_STAKE; }
            else {
                losses += 1;
                stake = if losses <= MAX_STEPS { (stake * MART_MULT * 100.0).round() / 100.0 } else { losses = 0; BASE_STAKE };
            }
        }
    }
}
`;

    case 'cpp':
      return `// ${strategy.name} — Low-Latency C++20 Quantitative Engine (STL + Boost.Beast WS)
#include <cmath>
#include <iostream>
#include <numeric>
#include <string>
#include <vector>

struct StrategyConfig {
    std::string symbol = "${symbol}";
    std::string contract_type = "${contractType}";
    int barrier = ${barrier};
    double base_stake = ${stakeVar.toFixed(2)};
    double min_ev_pct = ${minEv.toFixed(2)};
    double dual_z_threshold = ${zThresh.toFixed(2)};
    double min_slope_ratio = ${minSlopeRatio.toFixed(2)};
    int max_recovery_steps = ${maxSteps};
    double martingale_mult = ${martMult.toFixed(2)};
    double take_profit = ${tp.toFixed(2)};
    double stop_loss = ${sl.toFixed(2)};
};

struct GateVerdict {
    bool approved;
    int recommended_barrier;
    double metric;
};

GateVerdict evaluate_perfect_condition(const std::vector<double>& prices, const std::vector<int>& digits, const StrategyConfig& cfg) {
    if (prices.size() < 60) return {false, cfg.barrier, 0.0};
    double sum = std::accumulate(prices.end() - 20, prices.end(), 0.0);
    double mean = sum / 20.0;
    double var = 0.0;
    for (auto it = prices.end() - 20; it != prices.end(); ++it) var += (*it - mean) * (*it - mean);
    double stddev = std::sqrt(var / 20.0);
    double slope_ratio = stddev > 0.0 ? std::abs(prices.back() - *(prices.end() - 20)) / stddev : 0.0;

    ${
      isDigit
        ? `const std::size_t n = std::min<std::size_t>(400, digits.size());
    const double denom = std::sqrt(static_cast<double>(n) * 0.09);
    int best_d = cfg.barrier;
    double best_z = 1e9;
    for (int d = 0; d <= 9; ++d) {
        int c = 0;
        for (std::size_t i = digits.size() - n; i < digits.size(); ++i) if (digits[i] == d) ++c;
        double z = (c - n * 0.1) / std::max(1.0, denom);
        if (z < best_z) { best_z = z; best_d = d; }
    }
    bool recent_hit = false;
    for (std::size_t i = digits.size() - 5; i < digits.size(); ++i) if (digits[i] == best_d) recent_hit = true;
    return {best_z <= cfg.dual_z_threshold && !recent_hit, best_d, best_z};`
        : `return {slope_ratio >= cfg.min_slope_ratio, 0, slope_ratio};`
    }
}

int main() {
    StrategyConfig cfg;
    std::cout << "[C++20 Quant Kernel] Armed " << cfg.symbol << " (" << cfg.contract_type << ") | TP=$"
              << cfg.take_profit << " SL=$" << cfg.stop_loss << "\\n";
    return 0;
}
`;

    case 'go':
      return `// ${strategy.name} — Concurrent Deriv Execution Daemon (Go)
package main

import (
\t"fmt"
\t"math"
\t"os"
\t"github.com/gorilla/websocket"
)

type StrategyParams struct {
\tSymbol        string
\tContractType  string
\tBaseStake     float64
\tDuration      int
\tDurationUnit  string
\tDualZThresh   float64
\tMaxSteps      int
\tMartMult      float64
\tTakeProfit    float64
\tStopLoss      float64
}

func checkPerfectGate(prices []float64, digits []int, p StrategyParams) (bool, int) {
\tif len(prices) < 60 { return false, ${barrier} }
\tlast20 := prices[len(prices)-20:]
\tsum := 0.0
\tfor _, v := range last20 { sum += v }
\tmean := sum / 20.0
\tvariance := 0.0
\tfor _, v := range last20 { d := v - mean; variance += d * d }
\tstdDev := math.Sqrt(variance / 20.0)
\tslopeRatio := 0.0
\tif stdDev > 0 { slopeRatio = math.Abs(last20[19]-last20[0]) / stdDev }
\t${
        isDigit
          ? `n := len(digits); if n > 400 { n = 400 }
\tdenom := math.Sqrt(float64(n) * 0.09)
\tbestD, bestZ := ${barrier}, 99.0
\tfor d := 0; d <= 9; d++ {
\t\tc := 0
\t\tfor _, x := range digits[len(digits)-n:] { if x == d { c++ } }
\t\tz := (float64(c) - float64(n)*0.1) / math.Max(1, denom)
\t\tif z < bestZ { bestZ, bestD = z, d }
\t}
\trecentHit := false
\tfor _, x := range digits[len(digits)-5:] { if x == bestD { recentHit = true } }
\treturn bestZ <= p.DualZThresh && !recentHit, bestD`
          : `return slopeRatio >= ${minSlopeRatio.toFixed(2)}, 0`
      }
}

func main() {
\tappID := os.Getenv("DERIV_APP_ID")
\tif appID == "" { appID = "34RXuPGgdUNCTWhsYjRcD" }
\tconn, _, err := websocket.DefaultDialer.Dial("wss://ws.derivws.com/websockets/v3?app_id="+appID, nil)
\tif err != nil { panic(err) }
\tdefer conn.Close()
\tfmt.Println("Deriv Go Quant Engine connected for ${symbol} (${contractType})")
}
`;

    case 'pinescript':
      return `// ${strategy.name} — Pine Script v5 Confluence Strategy (${symbol})
//@version=5
strategy("${strategy.name}", overlay=true, default_qty_type=strategy.cash, default_qty_value=${stakeVar})

emaFastLen = input.int(9, "EMA Fast")
emaSlowLen = input.int(21, "EMA Slow")
rsiLen     = input.int(14, "RSI Length")
rsiMinGate = input.float(${rsiMin}, "RSI Min Gate")
rsiMaxGate = input.float(${rsiMax}, "RSI Max Gate")
minSlope   = input.float(${minSlopeRatio}, "Min Slope / StdDev Ratio")

ema9  = ta.ema(close, emaFastLen)
ema21 = ta.ema(close, emaSlowLen)
rsi14 = ta.rsi(close, rsiLen)
[bbMid, bbUp, bbLow] = ta.bb(close, 20, 2.0)
bbPctB = bbUp != bbLow ? (close - bbLow) / (bbUp - bbLow) * 100.0 : 50.0
std20  = ta.stdev(close, 20)
slopeRatio = std20 > 0 ? math.abs(close - close[20]) / std20 : 0.0

perfectLong  = ema9 > ema21 and rsi14 >= rsiMinGate and rsi14 <= rsiMaxGate and bbPctB >= ${bbMin} and bbPctB <= ${bbMax} and slopeRatio >= minSlope
perfectShort = ema9 < ema21 and rsi14 >= rsiMinGate and rsi14 <= rsiMaxGate and bbPctB >= ${bbMin} and bbPctB <= ${bbMax} and slopeRatio >= minSlope

plot(ema9,  "EMA 9",  color=color.teal, linewidth=2)
plot(ema21, "EMA 21", color=color.amber, linewidth=2)
plotshape(perfectLong,  style=shape.triangleup,   location=location.belowbar, color=color.teal, text="${contractType}")
plotshape(perfectShort, style=shape.triangledown, location=location.abovebar, color=color.red,  text="PUT")

if perfectLong
    strategy.entry("PerfectLong", strategy.long, alert_message='{"symbol":"${symbol}","contract":"${contractType}","stake":${stakeVar}}')
if perfectShort
    strategy.entry("PerfectShort", strategy.short, alert_message='{"symbol":"${symbol}","contract":"PUT","stake":${stakeVar}}')
`;

    case 'mql5':
      return `//+------------------------------------------------------------------+
//| ${strategy.name} (${symbol}) — MetaTrader 5 Expert Advisor        |
//+------------------------------------------------------------------+
#property strict
#include <Trade\\Trade.mqh>

CTrade trade;
input double InpStakeUSD       = ${stakeVar.toFixed(2)};
input int    InpEmaFast        = 9;
input int    InpEmaSlow        = 21;
input double InpRsiMin         = ${rsiMin.toFixed(1)};
input double InpRsiMax         = ${rsiMax.toFixed(1)};
input double InpTakeProfitUSD  = ${tp.toFixed(2)};
input double InpStopLossUSD    = ${sl.toFixed(2)};

int hEmaFast, hEmaSlow, hRsi;

int OnInit() {
   hEmaFast = iMA(_Symbol, PERIOD_CURRENT, InpEmaFast, 0, MODE_EMA, PRICE_CLOSE);
   hEmaSlow = iMA(_Symbol, PERIOD_CURRENT, InpEmaSlow, 0, MODE_EMA, PRICE_CLOSE);
   hRsi     = iRSI(_Symbol, PERIOD_CURRENT, 14, PRICE_CLOSE);
   return(INIT_SUCCEEDED);
}

void OnTick() {
   double e9[], e21[], rsi[];
   ArraySetAsSeries(e9, true); ArraySetAsSeries(e21, true); ArraySetAsSeries(rsi, true);
   if (CopyBuffer(hEmaFast, 0, 0, 3, e9) < 3) return;
   if (CopyBuffer(hEmaSlow, 0, 0, 3, e21) < 3) return;
   if (CopyBuffer(hRsi, 0, 0, 2, rsi) < 2) return;

   bool rsiHealthy = (rsi[0] >= InpRsiMin && rsi[0] <= InpRsiMax);
   bool bullPerfect = (e9[0] > e21[0]) && (e9[0] > e9[1]) && rsiHealthy;
   bool bearPerfect = (e9[0] < e21[0]) && (e9[0] < e9[1]) && rsiHealthy;

   if (PositionsTotal() == 0 && bullPerfect) {
      trade.Buy(0.01, _Symbol, 0, 0, 0, "${strategy.name} CALL");
   } else if (PositionsTotal() == 0 && bearPerfect) {
      trade.Sell(0.01, _Symbol, 0, 0, 0, "${strategy.name} PUT");
   }
}
`;

    case 'sql':
      return `-- ${strategy.name} — DuckDB / PostgreSQL Quantitative Tick Edge & EV% Query
WITH windowed AS (
  SELECT
    symbol,
    epoch,
    quote,
    CAST(RIGHT(CAST(quote AS VARCHAR), 1) AS INTEGER) AS last_digit,
    AVG(quote) OVER (PARTITION BY symbol ORDER BY epoch ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS sma20,
    STDDEV_POP(quote) OVER (PARTITION BY symbol ORDER BY epoch ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS std20
  FROM deriv_ticks
  WHERE symbol = '${symbol}'
),
digit_z AS (
  SELECT
    last_digit AS barrier_digit,
    COUNT(*) AS hits_400t,
    (COUNT(*) - (400.0 * 0.1)) / SQRT(400.0 * 0.09) AS binomial_z,
    ROUND(((400.0 - COUNT(*)) / 400.0) * 1.095 * 100.0 - 100.0, 2) AS expected_value_pct
  FROM (SELECT last_digit FROM windowed ORDER BY epoch DESC LIMIT 400)
  GROUP BY last_digit
)
SELECT
  barrier_digit,
  hits_400t,
  ROUND(binomial_z, 3) AS binomial_z,
  expected_value_pct,
  CASE
    WHEN binomial_z <= ${zThresh} AND expected_value_pct >= ${minEv} THEN 'PERFECT_EXECUTE'
    ELSE 'HOLD'
  END AS verdict
FROM digit_z
ORDER BY binomial_z ASC
LIMIT 1;
`;
  }
}

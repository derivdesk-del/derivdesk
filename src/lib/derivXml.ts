import {
  DEFAULT_BOT_STRATEGY,
  DEFAULT_PRETRADE_ANALYSIS,
  DERIV_MARKETS,
  type BotStrategyConfig,
  type BotVariable,
  type CandleInterval,
  type ContractTypeOption,
  type DurationUnit,
  type MarketSymbol,
  type PurchaseConditionMode,
  type TradeCategory,
  type TradeSubType,
} from '../shared/types.ts';

function normalizeContractType(
  rawPurchase: string,
  rawTradeType: string,
): {
  contractType: ContractTypeOption;
  tradeCategory: TradeCategory;
  tradeType: TradeSubType;
} {
  const p = rawPurchase.trim().toUpperCase();
  const tt = rawTradeType.trim().toLowerCase();

  if (p === 'MULTUP' || p === 'MULTDOWN' || tt.includes('multiplier')) {
    return {
      contractType: p === 'MULTDOWN' ? 'MULTDOWN' : 'MULTUP',
      tradeCategory: 'Multipliers',
      tradeType: 'Multipliers',
    };
  }
  if (p === 'CALL' || p === 'CALLE' || tt === 'risefall' || tt === 'callput') {
    if (p === 'PUT' || p === 'PUTE') {
      return { contractType: 'PUT', tradeCategory: 'Up/Down', tradeType: 'Rise/Fall' };
    }
    return { contractType: 'CALL', tradeCategory: 'Up/Down', tradeType: 'Rise/Fall' };
  }
  if (p === 'PUT' || p === 'PUTE') {
    return { contractType: 'PUT', tradeCategory: 'Up/Down', tradeType: 'Rise/Fall' };
  }
  if (p === 'DIGITOVER' || tt === 'overunder') {
    return {
      contractType: p === 'DIGITUNDER' ? 'DIGITUNDER' : 'DIGITOVER',
      tradeCategory: 'Digits',
      tradeType: 'Over/Under',
    };
  }
  if (p === 'DIGITUNDER') {
    return { contractType: 'DIGITUNDER', tradeCategory: 'Digits', tradeType: 'Over/Under' };
  }
  if (p === 'DIGITEVEN' || p === 'DIGITODD' || tt === 'evenodd') {
    return {
      contractType: p === 'DIGITODD' ? 'DIGITODD' : 'DIGITEVEN',
      tradeCategory: 'Digits',
      tradeType: 'Even/Odd',
    };
  }
  if (p === 'DIGITMATCH') {
    return { contractType: 'DIGITMATCH', tradeCategory: 'Digits', tradeType: 'Matches/Differs' };
  }
  if (p === 'DIGITDIFF') {
    return { contractType: 'DIGITDIFF', tradeCategory: 'Digits', tradeType: 'Matches/Differs' };
  }
  if (p === 'BOTH') {
    return { contractType: 'Both', tradeCategory: 'Digits', tradeType: 'Matches/Differs' };
  }
  return { contractType: 'DIGITDIFF', tradeCategory: 'Digits', tradeType: 'Matches/Differs' };
}

function normalizeDurationUnit(raw: string): DurationUnit {
  const u = raw.trim().toLowerCase();
  if (u === 's' || u === 'm' || u === 'h' || u === 'd' || u === 't') {
    return u;
  }
  return 't';
}

function normalizeCandleInterval(raw: string): CandleInterval {
  const secs = Number(raw);
  if (secs === 60) return '1 minute';
  if (secs === 300) return '5 minutes';
  if (secs === 900) return '15 minutes';
  if (raw.includes('15')) return '15 minutes';
  if (raw.includes('5')) return '5 minutes';
  if (raw.includes('tick')) return '1 tick';
  return '1 minute';
}

function extractNumberFromBlock(el: Element | null): number | null {
  if (!el) return null;
  const fields = el.getElementsByTagName('field');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const name = f.getAttribute('name') || '';
    if (name === 'NUM' || name === 'TEXT' || name === '') {
      const n = Number(f.textContent?.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function getDirectValueElement(parent: Element, valueName: string): Element | null {
  const values = parent.getElementsByTagName('value');
  for (let i = 0; i < values.length; i++) {
    if (values[i].getAttribute('name') === valueName) {
      return values[i];
    }
  }
  return null;
}

export interface XmlParseOutcome {
  strategy: BotStrategyConfig;
  summary: string;
  nativeContractType: ContractTypeOption;
  nativeBarrier: number;
}

export function parseBotXmlToStrategy(
  xmlText: string,
  fileName: string,
  markets: MarketSymbol[],
  baseStrategy: BotStrategyConfig,
  enableBestAnalysis = false,
): XmlParseOutcome {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const parseErr = doc.getElementsByTagName('parsererror')[0];
  if (parseErr) {
    throw new Error('Invalid XML file format. Please upload a valid Deriv Bot (.xml) file.');
  }

  // Check if this XML carries an embedded DerivDesk config metadata tag
  const metaNode = doc.getElementsByTagName('derivdesk_config')[0];
  if (metaNode?.textContent) {
    try {
      const parsed = JSON.parse(metaNode.textContent) as BotStrategyConfig;
      if (parsed && parsed.tradeParams && parsed.variables) {
        const finalConfig: BotStrategyConfig = enableBestAnalysis
          ? {
              ...parsed,
              purchaseConditions: {
                ...parsed.purchaseConditions,
                mode: 'best_quant_edge',
              },
              preTradeAnalysis: {
                ...DEFAULT_PRETRADE_ANALYSIS,
                ...parsed.preTradeAnalysis,
                enabled: true,
                autoSelectBestContract: true,
              },
            }
          : parsed;
        return {
          strategy: finalConfig,
          summary: `Loaded "${finalConfig.name}" (${finalConfig.tradeParams.symbol} · ${finalConfig.tradeParams.contractType})`,
          nativeContractType: parsed.tradeParams.contractType,
          nativeBarrier: parsed.purchaseConditions.predictionDigit ?? 4,
        };
      }
    } catch {
      // Fall through to standard Deriv DBot XML parsing
    }
  }

  // Collect all named <field> attributes across the Blockly XML
  const fieldsByName = new Map<string, string>();
  const allFields = doc.getElementsByTagName('field');
  for (let i = 0; i < allFields.length; i++) {
    const f = allFields[i];
    const name = f.getAttribute('name');
    const val = f.textContent?.trim();
    if (name && val && !fieldsByName.has(name)) {
      fieldsByName.set(name, val);
    }
  }

  // Map variable IDs -> readable names
  const varIdToName = new Map<string, string>();
  const varNodes = doc.getElementsByTagName('variable');
  for (let i = 0; i < varNodes.length; i++) {
    const id = varNodes[i].getAttribute('id');
    const name = varNodes[i].textContent?.trim();
    if (id && name) {
      varIdToName.set(id, name);
    }
  }

  // Collect initial variables and trade options from Blockly XML blocks
  const extractedVars: BotVariable[] = [];
  const varValuesByName = new Map<string, number>();
  const blocks = doc.getElementsByTagName('block');

  let durationTicks: number | null = null;
  let predictionDigit: number | null = null;
  let amountFromTradeBlock: number | null = null;
  let multiplierFromTradeBlock: number | null = null;
  let explicitPurchaseType = '';

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockType = block.getAttribute('type') || '';

    if (blockType === 'purchase' || blockType === 'purchase_list') {
      const childFields = block.getElementsByTagName('field');
      for (let c = 0; c < childFields.length; c++) {
        if (childFields[c].getAttribute('name') === 'PURCHASE_LIST') {
          const val = childFields[c].textContent?.trim() || '';
          if (val && val.toUpperCase() !== 'BOTH' && !explicitPurchaseType) {
            explicitPurchaseType = val;
          }
        }
      }
    }

    if (
      blockType === 'trade_definition_tradeoptions' ||
      blockType === 'trade_definition_multiplier' ||
      blockType === 'market'
    ) {
      const durVal = extractNumberFromBlock(getDirectValueElement(block, 'DURATION'));
      if (durVal !== null && durVal > 0) durationTicks = durVal;

      const predVal = extractNumberFromBlock(getDirectValueElement(block, 'PREDICTION'));
      if (predVal !== null && predVal >= 0 && predVal <= 9) predictionDigit = predVal;

      const amtVal = extractNumberFromBlock(getDirectValueElement(block, 'AMOUNT'));
      if (amtVal !== null && amtVal >= 0.35) amountFromTradeBlock = amtVal;

      const multVal = extractNumberFromBlock(getDirectValueElement(block, 'MULTIPLIER'));
      if (multVal !== null && multVal >= 1) multiplierFromTradeBlock = multVal;
    }

    if (blockType === 'variables_set') {
      let varName = '';
      const childFields = block.children;
      for (let c = 0; c < childFields.length; c++) {
        if (childFields[c].tagName === 'field' && childFields[c].getAttribute('name') === 'VAR') {
          const varId = childFields[c].getAttribute('id');
          varName =
            childFields[c].textContent?.trim() ||
            (varId ? varIdToName.get(varId) || '' : '');
          break;
        }
      }
      const numVal = extractNumberFromBlock(getDirectValueElement(block, 'VALUE'));
      if (varName && numVal !== null && !varValuesByName.has(varName.toLowerCase())) {
        varValuesByName.set(varName.toLowerCase(), numVal);
        extractedVars.push({
          id: `xml-v-${extractedVars.length + 1}`,
          name: varName,
          value: numVal,
        });
      }
    }
  }

  const rawSymbol = fieldsByName.get('SYMBOL_LIST') || baseStrategy.tradeParams.symbol;
  const marketMeta =
    markets.find((m) => m.symbol === rawSymbol) ??
    DERIV_MARKETS.find((m) => m.symbol === rawSymbol) ??
    markets.find((m) => m.symbol.toLowerCase() === rawSymbol.toLowerCase()) ??
    DERIV_MARKETS[1];

  const rawTradeType =
    fieldsByName.get('TRADETYPE_LIST') || fieldsByName.get('TRADETYPECAT_LIST') || '';
  const typeListFallback =
    fieldsByName.get('TYPE_LIST') && fieldsByName.get('TYPE_LIST')?.toUpperCase() !== 'BOTH'
      ? fieldsByName.get('TYPE_LIST') || ''
      : '';
  const rawPurchase =
    explicitPurchaseType ||
    fieldsByName.get('PURCHASE_LIST') ||
    typeListFallback ||
    fieldsByName.get('TYPE_LIST') ||
    '';
  let contractMeta = normalizeContractType(rawPurchase, rawTradeType);

  // Ensure contract capability matches market
  if (contractMeta.tradeCategory === 'Digits' && marketMeta.supportsDigits === false) {
    contractMeta =
      marketMeta.supportsRiseFall !== false
        ? { contractType: 'CALL', tradeCategory: 'Up/Down', tradeType: 'Rise/Fall' }
        : { contractType: 'MULTUP', tradeCategory: 'Multipliers', tradeType: 'Multipliers' };
  } else if (
    contractMeta.tradeCategory === 'Up/Down' &&
    marketMeta.supportsRiseFall === false
  ) {
    contractMeta = {
      contractType: 'MULTUP',
      tradeCategory: 'Multipliers',
      tradeType: 'Multipliers',
    };
  }

  const durationUnit = fieldsByName.has('DURATIONTYPE_LIST')
    ? normalizeDurationUnit(fieldsByName.get('DURATIONTYPE_LIST') || 't')
    : marketMeta.defaultDurationUnit || 't';

  // Extract stake / TP / SL / Martingale / Dual-Z / Staged Recovery from XML variables
  let stake = amountFromTradeBlock ?? 10;
  let takeProfit = baseStrategy.restartConditions.takeProfit;
  let stopLoss = baseStrategy.restartConditions.stopLoss;
  let martingaleMultiplier = baseStrategy.restartConditions.martingaleMultiplier;
  let stage2Multiplier: number | undefined;
  let stage3Multiplier: number | undefined;
  let maxStake = baseStrategy.restartConditions.maxStake;
  let useMartingale = baseStrategy.restartConditions.useMartingale;
  let minZThreshold: number | undefined;
  let longWindow: number | undefined;
  let shortWindow: number | undefined;
  let recentWindow: number | undefined;
  let hotLimit: number | undefined;
  let minHistoryTicks: number | undefined;
  let tradeGapTicks: number | undefined;
  let maxWaitTicks: number | undefined;
  let lossCooldownTicks = DEFAULT_PRETRADE_ANALYSIS.lossCooldownTicks;
  let maxConsecutiveLosses = DEFAULT_PRETRADE_ANALYSIS.maxConsecutiveLosses;

  for (const [k, v] of varValuesByName.entries()) {
    if (k === 'base_stake' || (k === 'stake' && v >= 0.35)) {
      stake = v;
    } else if (k.includes('stake') && !k.includes('max') && !k.includes('win') && v >= 0.35) {
      stake = v;
    } else if (
      (k.includes('initial') || k === 'amount' || k === 'bet' || k.includes('base_amount')) &&
      v >= 0.35
    ) {
      stake = v;
    } else if (
      (k.includes('take_profit') ||
        k.includes('take profit') ||
        k.includes('expected_profit') ||
        k.includes('expected profit') ||
        k === 'tp' ||
        k.includes('target_profit')) &&
      v > 0
    ) {
      takeProfit = v;
    } else if (
      (k.includes('stop_loss') ||
        k.includes('stop loss') ||
        k.includes('max_acceptable_loss') ||
        k.includes('max acceptable loss') ||
        k === 'sl' ||
        k.includes('max_loss')) &&
      !k.includes('streak') &&
      v > 0
    ) {
      stopLoss = v;
    } else if (k === 'stage_2_multiplier' && v > 1) {
      stage2Multiplier = v;
      useMartingale = true;
    } else if (k === 'stage_3_multiplier' && v > 1) {
      stage3Multiplier = v;
      useMartingale = true;
    } else if (
      (k.includes('martingale') || k.includes('multiplier') || k.includes('factor')) &&
      v >= 1 &&
      v <= 15
    ) {
      martingaleMultiplier = v;
      useMartingale = v > 1;
    } else if ((k.includes('max_stake') || k.includes('max stake')) && v > 0) {
      maxStake = v;
    } else if (k === 'min_z_threshold') {
      minZThreshold = v;
    } else if (k === 'long_window' && v >= 20) {
      longWindow = v;
    } else if (k === 'short_window' && v >= 10) {
      shortWindow = v;
    } else if (k === 'recent_window' && v >= 1) {
      recentWindow = v;
    } else if (k === 'hot_limit' && v >= 0) {
      hotLimit = v;
    } else if (k === 'min_history' && v >= 10) {
      minHistoryTicks = v;
    } else if (k === 'trade_gap' && v >= 0) {
      tradeGapTicks = v;
    } else if (k === 'max_wait' && v >= 1) {
      maxWaitTicks = v;
    } else if (k === 'loss_cooldown' && v >= 0) {
      lossCooldownTicks = v;
    } else if (k === 'max_loss_streak' && v >= 1) {
      maxConsecutiveLosses = v;
    } else if (
      (k.includes('prediction') || k.includes('barrier')) &&
      v >= 0 &&
      v <= 9 &&
      predictionDigit === null
    ) {
      predictionDigit = v;
    }
  }

  // Ensure a canonical `stake` variable exists so BotEngine always reads it cleanly
  const hasStakeVar = extractedVars.some((v) => v.name.toLowerCase() === 'stake');
  const finalVariables: BotVariable[] = hasStakeVar
    ? extractedVars.map((v) =>
        v.name.toLowerCase() === 'stake' ? { ...v, name: 'stake', value: stake } : v,
      )
    : [{ id: 'xml-stake', name: 'stake', value: stake }, ...extractedVars];

  const xmlLower = xmlText.toLowerCase();
  const isDualZScoreBot =
    minZThreshold !== undefined &&
    (longWindow !== undefined || xmlLower.includes('z_long') || xmlLower.includes('best_z'));
  const hasLosingDigitLock =
    xmlLower.includes('thelossingdigit') || xmlLower.includes('losingdigit');
  const hasRiskBudgetCap = xmlLower.includes('risk_left');

  const mode: PurchaseConditionMode = enableBestAnalysis
    ? 'best_quant_edge'
    : isDualZScoreBot
      ? 'dual_zscore_digit'
      : 'always';

  const cleanName = fileName.replace(/\.(xml|json)$/i, '').replace(/[_-]+/g, ' ').trim();
  const resolvedPrediction = predictionDigit ?? 4;

  const strategy: BotStrategyConfig = {
    ...DEFAULT_BOT_STRATEGY,
    id: `xml-${Date.now()}`,
    name: cleanName || `XML Bot (${marketMeta.symbol})`,
    description: enableBestAnalysis
      ? `Imported from ${fileName} · ${marketMeta.name} (${contractMeta.contractType}) with Best Quant Analysis Gate.`
      : isDualZScoreBot
        ? `Imported from ${fileName} · Dual-Window Binomial Z-Score (${longWindow ?? 400}t/${shortWindow ?? 50}t <= ${minZThreshold})${hasLosingDigitLock ? ' + Losing-Digit Recovery Lock' : ''}.`
        : `Imported from ${fileName} · ${marketMeta.name} (${contractMeta.contractType}) running XML Direct rules.`,
    tradeParams: {
      ...baseStrategy.tradeParams,
      marketGroup: marketMeta.marketGroup,
      subGroup: marketMeta.subGroup,
      symbol: marketMeta.symbol,
      tradeCategory: contractMeta.tradeCategory,
      tradeType: contractMeta.tradeType,
      contractType: contractMeta.contractType,
      candleInterval: fieldsByName.has('CANDLEINTERVAL_LIST')
        ? normalizeCandleInterval(fieldsByName.get('CANDLEINTERVAL_LIST') || '60')
        : baseStrategy.tradeParams.candleInterval,
      restartBuySellOnError:
        fieldsByName.get('TIME_MACHINE_ENABLED')?.toUpperCase() === 'TRUE',
      restartLastTradeOnError:
        fieldsByName.get('RESTARTONERROR')?.toUpperCase() !== 'FALSE',
    },
    variables: finalVariables.length > 0 ? finalVariables : baseStrategy.variables,
    purchaseConditions: {
      ...baseStrategy.purchaseConditions,
      mode,
      durationTicks: durationTicks ?? marketMeta.defaultDuration ?? 1,
      durationUnit,
      multiplier: multiplierFromTradeBlock ?? baseStrategy.purchaseConditions.multiplier ?? 100,
      predictionDigit: resolvedPrediction,
      dualZScoreThreshold: minZThreshold,
      longWindow,
      shortWindow,
      recentWindow,
      hotLimit,
      minHistoryTicks,
      tradeGapTicks,
      maxWaitTicks,
    },
    preTradeAnalysis: {
      ...DEFAULT_PRETRADE_ANALYSIS,
      enabled: enableBestAnalysis || isDualZScoreBot,
      autoSelectBestContract: enableBestAnalysis,
      lossCooldownTicks,
      maxConsecutiveLosses,
      trailingProfitLockPct: isDualZScoreBot ? 0 : DEFAULT_PRETRADE_ANALYSIS.trailingProfitLockPct,
    },
    restartConditions: {
      ...baseStrategy.restartConditions,
      tradeAgain: !xmlLower.includes('trade_again') ? baseStrategy.restartConditions.tradeAgain : true,
      useMartingale,
      martingaleMultiplier: stage2Multiplier ?? martingaleMultiplier,
      stage2Multiplier,
      stage3Multiplier,
      lockLosingDigitOnLoss: hasLosingDigitLock,
      capStakeToRemainingStopLoss: hasRiskBudgetCap,
      maxStake,
      takeProfit,
      stopLoss,
    },
  };

  return {
    strategy,
    summary: `Imported "${fileName}" → ${marketMeta.symbol} · ${contractMeta.contractType}${contractMeta.tradeCategory === 'Digits' ? ` [${isDualZScoreBot ? `Z<=${minZThreshold}` : resolvedPrediction}]` : ''} · Stake $${stake.toFixed(2)} · TP $${takeProfit} / SL $${stopLoss}${stage2Multiplier ? ` · Staged ${stage2Multiplier}x/${stage3Multiplier ?? stage2Multiplier}x` : ''}`,
    nativeContractType: contractMeta.contractType,
    nativeBarrier: resolvedPrediction,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function exportStrategyToDerivXml(strategy: BotStrategyConfig): string {
  const stake = strategy.variables.find((v) => v.name === 'stake')?.value ?? 10;
  const tradeTypeCode =
    strategy.tradeParams.tradeType === 'Rise/Fall'
      ? 'callput'
      : strategy.tradeParams.tradeType === 'Even/Odd'
        ? 'evenodd'
        : strategy.tradeParams.tradeType === 'Over/Under'
          ? 'overunder'
          : strategy.tradeParams.tradeType === 'Multipliers'
            ? 'multiplier'
            : 'matchesdiffers';

  const marketCode =
    strategy.tradeParams.marketGroup === 'Forex'
      ? 'forex'
      : strategy.tradeParams.marketGroup === 'Commodities'
        ? 'commodities'
        : strategy.tradeParams.marketGroup === 'Cryptocurrencies'
          ? 'cryptocurrency'
          : strategy.tradeParams.marketGroup === 'Stock Indices'
            ? 'indices'
            : 'synthetic_index';

  const candleSeconds =
    strategy.tradeParams.candleInterval === '15 minutes'
      ? 900
      : strategy.tradeParams.candleInterval === '5 minutes'
        ? 300
        : 60;

  return `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true">
  <derivdesk_config>${escapeXml(JSON.stringify(strategy))}</derivdesk_config>
  <variables>
    <variable id="var_stake">stake</variable>
    <variable id="var_tp">take_profit</variable>
    <variable id="var_sl">stop_loss</variable>
    <variable id="var_mart">martingale</variable>
  </variables>
  <block type="trade_definition" id="root_trade_def" x="20" y="20">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" id="td_market">
        <field name="MARKET_LIST">${escapeXml(marketCode)}</field>
        <field name="SUBMARKET_LIST">${escapeXml(strategy.tradeParams.subGroup)}</field>
        <field name="SYMBOL_LIST">${escapeXml(strategy.tradeParams.symbol)}</field>
        <next>
          <block type="trade_definition_tradetype" id="td_tradetype">
            <field name="TRADETYPECAT_LIST">${escapeXml(strategy.tradeParams.tradeCategory.toLowerCase())}</field>
            <field name="TRADETYPE_LIST">${escapeXml(tradeTypeCode)}</field>
            <next>
              <block type="trade_definition_contracttype" id="td_contract">
                <field name="TYPE_LIST">${escapeXml(strategy.tradeParams.contractType)}</field>
                <next>
                  <block type="trade_definition_candleinterval" id="td_candle">
                    <field name="CANDLEINTERVAL_LIST">${candleSeconds}</field>
                    <next>
                      <block type="trade_definition_restartonerror" id="td_restart">
                        <field name="RESTARTONERROR">${strategy.tradeParams.restartLastTradeOnError ? 'TRUE' : 'FALSE'}</field>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="trade_definition_tradeoptions" id="td_opts">
        <field name="DURATIONTYPE_LIST">${escapeXml(strategy.purchaseConditions.durationUnit || 't')}</field>
        <value name="DURATION">
          <shadow type="math_number"><field name="NUM">${strategy.purchaseConditions.durationTicks}</field></shadow>
        </value>
        <value name="AMOUNT">
          <shadow type="math_number"><field name="NUM">${stake}</field></shadow>
        </value>
        <value name="PREDICTION">
          <shadow type="math_number"><field name="NUM">${strategy.purchaseConditions.predictionDigit}</field></shadow>
        </value>
      </block>
    </statement>
  </block>
</xml>`;
}

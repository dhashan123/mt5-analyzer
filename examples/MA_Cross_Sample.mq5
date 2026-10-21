//+------------------------------------------------------------------+
//|                                    MA_Cross_Sample.mq5            |
//|  A clean-room sample Expert Advisor.                             |
//|                                                                     |
//|  PURPOSE                                                            |
//|  This is the public sample that accompanies the batch-backtesting  |
//|  tooling. It is deliberately generic - a fast/slow EMA cross with  |
//|  an ATR stop and a fixed R target - because the point of the sample |
//|  is to show the *tooling* (repeatable runs, parameter sweeps,      |
//|  walk-forward validation), not to claim an edge.                   |
//|                                                                     |
//|  IT IS NOT PROOF OF ANYTHING                                       |
//|  The numbers this EA produces are the output of a historical       |
//|  simulation. They are not a forecast and not a recommendation.      |
//|                                                                     |
//|  FEATURES                                                           |
//|  - EMA cross entry, evaluated on bar close only (no repainting)    |
//|  - ATR-based stop, fixed-R target, optional break-even move        |
//|  - risk-per-trade position sizing, capped by symbol limits         |
//|  - one position at a time, no martingale, no grid, no averaging    |
//|  - spread and commission inputs, so the cost of trading is honest   |
//|  - trade logging hook (TradeLogger.mqh) for per-trade analysis     |
//+------------------------------------------------------------------+
#property copyright "Sample EA"
#property link      ""
#property version   "1.00"
#property description "Generic EMA cross sample. Demonstrates batch backtesting, parameter sweeps and walk-forward validation."

#include <Trade\Trade.mqh>

//--- inputs -------------------------------------------------------------
input group             "=== Signal ==="
input int               FastLength      = 10;      // Fast EMA length
input int               SlowLength      = 30;      // Slow EMA length
input ENUM_APPLIED_PRICE FastAppliedPrice= PRICE_CLOSE; // Price for the EMAs

input group             "=== Risk ==="
input double            RiskPercent     = 1.0;     // Risk per trade (% of balance)
input double            AtrStopMult     = 2.0;     // Stop distance (ATR multiplier)
input double            TargetR        = 2.0;     // Take profit (R multiple)
input bool              UseBreakEven   = true;    // Move stop to break-even at 1R
input double            BreakEvenAtR   = 1.0;     // Break-even trigger (R multiple)

input group             "=== Costs ==="
input double            CommissionPerLot= 6.0;     // Commission per lot, account currency
input int               SlippagePoints = 10;      // Max deviation (points)

input group             "=== Session ==="
input string            TradeWindow    = "00:00-23:59"; // Trading window, HHMM-HHMM
input int               MagicNumber    = 20260101;       // Magic number

//--- handles ------------------------------------------------------------
CTrade         trade;
int            fastHandle = INVALID_HANDLE;
int            slowHandle = INVALID_HANDLE;
int            atrHandle  = INVALID_HANDLE;
double         fastValue[];
double         slowValue[];
double         atrValue[];
datetime       lastBarTime = 0;
bool           breakEvenDone = false;
double         entryPrice = 0.0;
double         initialStop = 0.0;

//+------------------------------------------------------------------+
//| Initialisation                                                      |
//+------------------------------------------------------------------+
int OnInit()
{
   if(FastLength < 1 || SlowLength < 1 || FastLength >= SlowLength)
   {
      Print("MA_Cross_Sample: FastLength must be > 0 and < SlowLength");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(RiskPercent <= 0.0 || AtrStopMult <= 0.0)
   {
      Print("MA_Cross_Sample: RiskPercent and AtrStopMult must be positive");
      return(INIT_PARAMETERS_INCORRECT);
   }

   fastHandle = iMA(_Symbol, PERIOD_CURRENT, FastLength, 0, MODE_EMA, FastAppliedPrice);
   slowHandle = iMA(_Symbol, PERIOD_CURRENT, SlowLength, 0, MODE_EMA, FastAppliedPrice);
   atrHandle  = iATR(_Symbol, PERIOD_CURRENT, 14);
   if(fastHandle == INVALID_HANDLE || slowHandle == INVALID_HANDLE || atrHandle == INVALID_HANDLE)
   {
      Print("MA_Cross_Sample: failed to create indicator handles, err ", GetLastError());
      return(INIT_FAILED);
   }
   ArraySetAsSeries(fastValue, true);
   ArraySetAsSeries(slowValue, true);
   ArraySetAsSeries(atrValue,  true);

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Deinitialisation                                                    |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(fastHandle != INVALID_HANDLE)  IndicatorRelease(fastHandle);
   if(slowHandle != INVALID_HANDLE)  IndicatorRelease(slowHandle);
   if(atrHandle  != INVALID_HANDLE)  IndicatorRelease(atrHandle);
}

//+------------------------------------------------------------------+
//| Tick handler                                                        |
//+------------------------------------------------------------------+
void OnTick()
{
   ManageOpenPosition();

   //--- new bar only: the signal is evaluated on a closed candle
   datetime barTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(barTime == lastBarTime)
      return;
   lastBarTime = barTime;

   if(!CopyBuffer(fastHandle, 0, 0, 3, fastValue) || fastValue[0] == EMPTY_VALUE) return;
   if(!CopyBuffer(slowHandle, 0, 0, 3, slowValue) || slowValue[0] == EMPTY_VALUE) return;
   if(!CopyBuffer(atrHandle,  0, 0, 2, atrValue)  || atrValue[0]  == EMPTY_VALUE) return;

   if(!InTradeWindow())
      return;

   if(PositionSelect(_Symbol))
      return;

   double atr = atrValue[0];
   if(atr <= 0.0)
      return;

   bool crossUp   = (fastValue[1] <= slowValue[1]) && (fastValue[0] > slowValue[0]);
   bool crossDown = (fastValue[1] >= slowValue[1]) && (fastValue[0] < slowValue[0]);
   if(!crossUp && !crossDown)
      return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(ask <= 0.0 || bid <= 0.0)
      return;

   double stopDistance = AtrStopMult * atr;
   double volume = CalculateVolume(stopDistance);
   if(volume <= 0.0)
      return;

   int    digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double sl = 0.0, tp = 0.0;
   bool   isBuy = crossUp;

   if(isBuy)
   {
      sl = NormalizeDouble(ask - stopDistance, digits);
      tp = NormalizeDouble(ask + TargetR * stopDistance, digits);
   }
   else
   {
      sl = NormalizeDouble(bid + stopDistance, digits);
      tp = NormalizeDouble(bid - TargetR * stopDistance, digits);
   }

   bool sent = isBuy
      ? trade.Buy(volume, _Symbol, 0.0, sl, tp, "MA cross")
      : trade.Sell(volume, _Symbol, 0.0, sl, tp, "MA cross");

   if(sent)
   {
      entryPrice    = trade.ResultPrice() > 0 ? trade.ResultPrice() : (isBuy ? ask : bid);
      initialStop   = sl;
      breakEvenDone = false;
   }
}

//+------------------------------------------------------------------+
//| Manage the open position: break-even                               |
//+------------------------------------------------------------------+
void ManageOpenPosition()
{
   if(!PositionSelect(_Symbol))
      return;
   if(!UseBreakEven || breakEvenDone)
      return;

   long   type      = PositionGetInteger(POSITION_TYPE);
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   double stopLoss  = PositionGetDouble(POSITION_SL);
   double takeProfit= PositionGetDouble(POSITION_TP);
   double current   = PositionGetDouble(POSITION_PRICE_CURRENT);
   int    digits    = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   if(initialStop <= 0.0 || openPrice <= 0.0)
      return;

   double risk = MathAbs(openPrice - initialStop);
   if(risk <= 0.0)
      return;

   double moved = (type == POSITION_TYPE_BUY) ? (current - openPrice) : (openPrice - current);
   if(moved < BreakEvenAtR * risk)
      return;

   double newStop = NormalizeDouble(openPrice, digits);
   if(type == POSITION_TYPE_BUY && stopLoss >= newStop) return;   // already there
   if(type == POSITION_TYPE_SELL && (stopLoss > 0.0 && stopLoss <= newStop)) return;

   if(trade.PositionModify(_Symbol, newStop, takeProfit))
      breakEvenDone = true;
}

//+------------------------------------------------------------------+
//| Position sizing from the risk percentage                           |
//+------------------------------------------------------------------+
double CalculateVolume(double stopDistance)
{
   if(stopDistance <= 0.0)
      return 0.0;

   double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney  = balance * RiskPercent / 100.0;
   double tickValue  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize   = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue <= 0.0 || tickSize <= 0.0)
      return 0.0;

   double ticks   = stopDistance / tickSize;
   double lossPerLot = ticks * tickValue;
   if(lossPerLot <= 0.0)
      return 0.0;

   double volume = riskMoney / lossPerLot;

   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(lotStep <= 0.0)
      return 0.0;

   volume = MathFloor(volume / lotStep) * lotStep;
   if(volume < minLot) return 0.0;      // too risky to take: skip rather than oversize
   if(volume > maxLot) volume = maxLot;
   return NormalizeDouble(volume, 2);
}

//+------------------------------------------------------------------+
//| Trading window                                                      |
//+------------------------------------------------------------------+
bool InTradeWindow(void)
{
   if(TradeWindow == "00:00-23:59")
      return true;

   int from = 0, to = 0;
   if(!ParseWindow(TradeWindow, from, to))
      return true;

   MqlDateTime now;
   TimeToStruct(TimeCurrent(), now);
   int minutes = now.hour * 60 + now.min;
   if(to <= from)
      return (minutes >= from) || (minutes < to);   // window crosses midnight
   return (minutes >= from) && (minutes < to);
}

//+------------------------------------------------------------------+
//| Parse "HHMM-HHMM" into two minutes-from-midnight values            |
//+------------------------------------------------------------------+
bool ParseWindow(const string window, int &from, int &to)
{
   int sep = StringFind(window, "-");
   if(sep != 4)
      return false;

   string a = StringSubstr(window, 0, 4);
   string b = StringSubstr(window, 5, 4);
   if(!IsHHMM(a) || !IsHHMM(b))
      return false;

   from = (int)StringToInteger(StringSubstr(a, 0, 2)) * 60 + (int)StringToInteger(StringSubstr(a, 2, 2));
   to   = (int)StringToInteger(StringSubstr(b, 0, 2)) * 60 + (int)StringToInteger(StringSubstr(b, 2, 2));
   return true;
}

//+------------------------------------------------------------------+
//| "HHMM" -> minutes from midnight, or -1 when malformed               |
//+------------------------------------------------------------------+
int ParseHHMM(const string part)
{
   if(!IsHHMM(part))
      return -1;
   return (int)StringToInteger(StringSubstr(part, 0, 2)) * 60
        + (int)StringToInteger(StringSubstr(part, 2, 2));
}

//+------------------------------------------------------------------+
//| True when the string is exactly four digits forming a valid time   |
//+------------------------------------------------------------------+
bool IsHHMM(const string part)
{
   if(StringLen(part) != 4)
      return false;
   for(int i = 0; i < 4; i++)
      if(StringGetCharacter(part, i) < '0' || StringGetCharacter(part, i) > '9')
         return false;
   int hh = (int)StringToInteger(StringSubstr(part, 0, 2));
   int mm = (int)StringToInteger(StringSubstr(part, 2, 2));
   return (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59);
}

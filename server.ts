import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { appState } from './server/state.ts';
import { createL402Challenge, verifyL402Auth } from './server/l402.ts';
import { runAutonomousCycle, handleAgentPrompt } from './server/agentController.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Request logging middleware for transparency
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api')) {
    console.log(`[API ${req.method}] ${req.path}`);
  }
  next();
});

// -------------------------------------------------------------
// Protected Paid Services (HTTP 402 L402 Implementation)
// -------------------------------------------------------------

function handleProtectedService(
  req: Request,
  res: Response,
  serviceId: string,
  priceSats: number,
  serviceName: string,
  dataPayload: Record<string, any>
) {
  const authHeader = req.headers.authorization;
  const preimageHeader = (req.headers['x-l402-preimage'] || req.headers['x-preimage']) as string | undefined;

  // Verify proof of payment
  const verification = verifyL402Auth(authHeader, preimageHeader);

  if (!verification.valid) {
    // Generate fresh L402 challenge
    const challenge = createL402Challenge(serviceId, priceSats);

    // Set standard L402 HTTP 402 header
    res.setHeader(
      'WWW-Authenticate',
      `L402 invoice="${challenge.invoice}", macaroon="${challenge.macaroon}"`
    );

    return res.status(402).json({
      status: 402,
      error: 'Payment Required',
      message: `Access to ${serviceName} requires ${priceSats} sats. Pay the attached Lightning BOLT11 invoice and retry with Authorization: L402 <macaroon>:<preimage>.`,
      service: serviceName,
      service_id: serviceId,
      price_sats: priceSats,
      currency: 'SAT',
      invoice: challenge.invoice,
      macaroon: challenge.macaroon,
      payment_hash: challenge.payment_hash,
      expires_at: challenge.expires_at,
      protocol: 'L402'
    });
  }

  // Payment is verified! Return protected payload
  return res.status(200).json({
    status: 'success',
    service: serviceName,
    data: dataPayload,
    authorization: 'L402 Validated'
  });
}

// 1. Premium Data API (100 sats)
app.get('/api/premium-data', (req: Request, res: Response) => {
  const service = appState.services.find(s => s.id === 'premium-data')!;
  return handleProtectedService(
    req,
    res,
    'premium-data',
    service.price_sats,
    service.name,
    service.sample_data || { market_signal: 'stable', demand_index: 87, grid_load: 'moderate' }
  );
});

// 2. Weather API (50 sats)
app.get('/api/weather-data', (req: Request, res: Response) => {
  const service = appState.services.find(s => s.id === 'weather-api')!;
  return handleProtectedService(
    req,
    res,
    'weather-api',
    service.price_sats,
    service.name,
    service.sample_data || { city: 'San Francisco', temperature_c: 18.4, forecast: 'clear' }
  );
});

// 3. Compute API (200 sats)
app.get('/api/compute-data', (req: Request, res: Response) => {
  const service = appState.services.find(s => s.id === 'compute-api')!;
  return handleProtectedService(
    req,
    res,
    'compute-api',
    service.price_sats,
    service.name,
    service.sample_data || { nodes_allocated: 4, gpu_type: 'H100 PCIe', status: 'completed' }
  );
});

// 4. Premium Dataset (500 sats)
app.get('/api/premium-dataset', (req: Request, res: Response) => {
  const service = appState.services.find(s => s.id === 'premium-dataset')!;
  return handleProtectedService(
    req,
    res,
    'premium-dataset',
    service.price_sats,
    service.name,
    service.sample_data || { dataset: 'institutional_orderbook_l3', records: 500000 }
  );
});

// -------------------------------------------------------------
// Core Application APIs
// -------------------------------------------------------------

app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    project: 'Machine Money',
    version: '1.0.0',
    mode: appState.settings.payment_mode,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/agent', (req: Request, res: Response) => {
  const totalTx = appState.transactions.length;
  const successfulTx = appState.transactions.filter(t => t.status === 'SUCCESS').length;
  const blockedTx = appState.transactions.filter(t => t.status === 'BLOCKED').length;
  const totalSatsSpent = appState.transactions
    .filter(t => t.status === 'SUCCESS')
    .reduce((sum, t) => sum + t.amount_sats, 0);

  res.json({
    agent: appState.agent,
    policy: appState.policy,
    statistics: {
      total_transactions: totalTx,
      successful_payments: successfulTx,
      blocked_payments: blockedTx,
      total_sats_spent: totalSatsSpent,
      remaining_daily_limit: Math.max(0, appState.policy.daily_limit_sats - appState.policy.current_daily_spend)
    }
  });
});

app.post('/api/agent/reset', (req: Request, res: Response) => {
  appState.resetDemo();
  res.json({
    status: 'success',
    message: 'Agent wallet balance and policy spending reset to default state.',
    agent: appState.agent,
    policy: appState.policy
  });
});

app.post('/api/agent/topup', (req: Request, res: Response) => {
  const amount = Number(req.body.amount) || 500;
  appState.topUpBalance(amount);
  res.json({
    status: 'success',
    new_balance: appState.agent.balance,
    message: `Added ${amount} sats to agent wallet.`
  });
});

app.get('/api/services', (req: Request, res: Response) => {
  res.json(appState.services);
});

app.get('/api/transactions', (req: Request, res: Response) => {
  const { status, limit } = req.query;
  let txs = appState.transactions;
  if (status && status !== 'ALL') {
    txs = txs.filter(t => t.status === status);
  }
  if (limit) {
    txs = txs.slice(0, Number(limit));
  }
  res.json(txs);
});

app.get('/api/policies', (req: Request, res: Response) => {
  res.json(appState.policy);
});

app.post('/api/policy', (req: Request, res: Response) => {
  const {
    max_transaction_sats,
    daily_limit_sats,
    allowed_services,
    blocked_services,
    require_manual_above_sats
  } = req.body;

  const updated = appState.updatePolicy({
    max_transaction_sats: Number(max_transaction_sats) || appState.policy.max_transaction_sats,
    daily_limit_sats: Number(daily_limit_sats) || appState.policy.daily_limit_sats,
    allowed_services: Array.isArray(allowed_services) ? allowed_services : appState.policy.allowed_services,
    blocked_services: Array.isArray(blocked_services) ? blocked_services : appState.policy.blocked_services,
    require_manual_above_sats: Number(require_manual_above_sats) ?? appState.policy.require_manual_above_sats
  });

  res.json({
    status: 'success',
    message: 'Policy configuration updated.',
    policy: updated
  });
});

app.get('/api/settings', (req: Request, res: Response) => {
  res.json({
    ...appState.settings,
    has_gemini_key: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post('/api/settings', (req: Request, res: Response) => {
  const { payment_mode, lnbits_url, ai_provider } = req.body;
  if (payment_mode === 'DEMO' || payment_mode === 'REGTEST') {
    appState.settings.payment_mode = payment_mode;
  }
  if (lnbits_url) {
    appState.settings.lnbits_url = lnbits_url;
  }
  if (ai_provider) {
    appState.settings.ai_provider = ai_provider;
  }
  res.json({
    status: 'success',
    settings: appState.settings
  });
});

app.get('/api/demo/events', (req: Request, res: Response) => {
  res.json(appState.demoEvents);
});

// Run step-by-step payment demo
app.post('/api/demo/run', async (req: Request, res: Response) => {
  try {
    const { service_id, step_delay_ms } = req.body;
    const result = await runAutonomousCycle({
      serviceId: service_id,
      stepDelayMs: step_delay_ms !== undefined ? Number(step_delay_ms) : 0
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Interactive natural language agent prompt
app.post('/api/agent/prompt', async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }
    const result = await handleAgentPrompt(prompt);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Vite Middleware / Static Serve
// -------------------------------------------------------------

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Machine Money] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

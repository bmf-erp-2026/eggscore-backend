const express = require('express');
const { requireSupabaseAuth } = require('../auth.postgres');

const router = express.Router();

// Single proxy route for every AI-insight feature in the ERP (CRM Insights,
// Promo Insights, Time-Value/Balance Advisor, Inventory Forecast, Rep
// Coaching, WA Message drafting) — all 6 share the client-side callClaude()
// helper, which previously called api.anthropic.com directly from the
// browser. That can never work: a browser origin will always be blocked by
// CORS, and the request carried no API key anyway. This route does the call
// server-side instead, where the real key can live safely in an env var
// and never touch the client.
//
// requireSupabaseAuth() only — ERP-only, same as settings/suppliers. These
// insights are internal business analysis, never portal-facing.
router.post('/insights', requireSupabaseAuth(), async (req, res) => {
  const { prompt } = req.body;
  if(!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'A prompt string is required.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey) {
    console.error('[ai] ANTHROPIC_API_KEY is not set in the environment.');
    return res.status(500).json({ error: 'AI insights are not configured on the server yet.' });
  }

  try {
    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if(!anthropicResp.ok) {
      const errBody = await anthropicResp.text();
      console.error(`[ai] Anthropic API error ${anthropicResp.status}: ${errBody}`);
      return res.status(502).json({ error: 'AI service returned an error.' });
    }

    const data = await anthropicResp.json();
    const text = data.content?.[0]?.text || '';
    res.json({ text });
  } catch(networkErr) {
    console.error('[ai] Network error calling Anthropic API:', networkErr);
    res.status(502).json({ error: 'Could not reach the AI service.' });
  }
});

module.exports = router;

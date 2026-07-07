const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL || process.env.VITE_GAS_WEB_APP_URL;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {};
  }
  return req.body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!GAS_WEB_APP_URL) {
    res.status(500).json({ ok: false, error: 'Missing GAS_WEB_APP_URL environment variable' });
    return;
  }

  try {
    const payload = parseBody(req);
    const response = await fetch(GAS_WEB_APP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch (error) {
      res.status(502).json({ ok: false, error: 'Invalid response from Google Apps Script', details: text });
      return;
    }

    res.status(response.ok ? 200 : 502).json(data);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Proxy request failed' });
  }
}
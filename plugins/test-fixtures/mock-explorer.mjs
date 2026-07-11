#!/usr/bin/env node
import http from 'node:http';

const submits = new Map();
const polls = new Map();
const server = http.createServer(async (req, res) => {
  const body = await new Promise((resolve) => { let text = ''; req.on('data', (part) => text += part); req.on('end', () => resolve(text)); });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/chains') return send([{ chainId: 1 }]);
  if (url.pathname.startsWith('/v2/verify/') && req.method === 'POST') { const parsed = JSON.parse(body); return parsed.stdJsonInput && parsed.compilerVersion && parsed.contractIdentifier ? send({ verificationId: 'sourcify-guid' }) : send({ error: 'bad sourcify body' }, 400); }
  if (url.pathname === '/v2/verify/sourcify-guid') return send({ status: 'verified', matchLevel: 'full' });
  const params = new URLSearchParams(req.method === 'POST' ? body : url.search);
  const action = params.get('action');
  if (action === 'verifysourcecode') { if (params.get('constructorArguements') !== '1234' || !params.get('sourceCode')) return send({ status: '0', result: 'bad verification form' }); const address = params.get('contractaddress'); const count = (submits.get(address) ?? 0) + 1; submits.set(address, count); return send(count > 1 ? { status: '0', result: 'Already verifying' } : { status: '1', result: `guid-${address}` }); }
  if (action === 'checkverifystatus') { const guid = params.get('guid'); const count = (polls.get(guid) ?? 0) + 1; polls.set(guid, count); return send({ status: '1', result: count === 1 ? 'Pending in queue' : 'Pass - Verified' }); }
  if (action === 'getcontractcreation') return send({ status: '1', result: [{ txHash: '0x1234' }] });
  if (url.pathname === '/v2/chainlist') return send({ result: [] });
  return send({ status: '0', result: 'unknown' }, 404);
});
server.listen(0, '127.0.0.1', () => console.log(`READY ${server.address().port}`));

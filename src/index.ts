import express from 'express';
import bodyParser from 'body-parser';
import dns from 'dns';
import net from 'net';
import os from 'os';
import util from 'util';

import pCatchIf from 'p-catch-if';
import pLimit from 'p-limit';
import pSleep from 'p-sleep';

import Client from './client';
import Manager from './manager';

const debug = require('debug')('server-accepts-email:index') as (s: string) => void;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON requests
app.use(bodyParser.json());

const globalManager = new Manager();

const resolveMx = util.promisify(dns.resolveMx);
const getMailServersLimit = pLimit(256);

const handleResolveMxErrors = pCatchIf(
  (err: Error & { code?: string }) => (err.code === 'ENOTFOUND' || err.code === 'ENODATA'),
  () => [] as dns.MxRecord[]
);

async function getMailServers(hostname: string): Promise<string[]> {
  debug(`Resolving MX records for "${hostname}"`);
  const mxRecords = await resolveMx(hostname).catch(handleResolveMxErrors);
  debug(`Got ${mxRecords.length} record${mxRecords.length === 1 ? '' : 's'} for "${hostname}"`);

  return mxRecords
    .sort((lhs, rhs) => lhs.priority - rhs.priority)
    .map(a => a.exchange);
}

interface TestServerOptions {
  senderAddress: string;
  handleGraylisting: boolean;
}

async function testServer(client: Client, email: string, { senderAddress, handleGraylisting }: TestServerOptions): Promise<boolean> {
  const result = await client.test(email, { senderAddress });

  if (result.kind === 'greylist') {
    if (!handleGraylisting) {
      throw new Error('Server applied greylisting');
    }

    debug(`Waiting ${result.timeout} seconds for greylisting to pass`);
    return pSleep(result.timeout * 1000).then(() => {
      return testServer(client, email, { senderAddress, handleGraylisting: false });
    });
  }

  return result.answer;
}

export async function serverAcceptsEmail(email: string, options: { senderDomain?: string; senderAddress?: string } = {}): Promise<boolean> {
  const hostname = email.split('@')[1];
  const servers = await getMailServersLimit(getMailServers, hostname);

  if (servers.length === 0) {
    return false;
  }

  const senderDomain = options.senderDomain || os.hostname();
  const senderAddress = options.senderAddress || `test@${senderDomain}`;

  let lastError: Error | null = null;
  for (const server of servers) {
    try {
      return await globalManager.withClient(server, senderDomain, (client) => {
        return testServer(client, email, { senderAddress, handleGraylisting: true });
      });
    } catch (err) {
      debug(`Error "${err}", trying next server`);
      lastError = err;
    }
  }

  throw lastError;
}

// API endpoint for email verification
app.get('/verify', async (req, res) => {
  const email = req.query.email as string;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const isValid = await serverAcceptsEmail(email);
    res.json({ email, isValid });
  } catch (error) {
    res.status(500).json({ error: 'Error verifying email', details: error.message });
  }
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

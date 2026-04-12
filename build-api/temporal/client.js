import { Connection, Client } from '@temporalio/client';

let cachedClient = null;

export async function getTemporalClient() {
  if (cachedClient) return cachedClient;
  const connection = await Connection.connect({ address: 'localhost:7233' });
  cachedClient = new Client({ connection });
  return cachedClient;
}
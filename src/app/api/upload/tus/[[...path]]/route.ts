import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

const DATA_ROOT = process.env.MY_DATA_DIR || path.join(process.cwd(), 'data');
const UPLOAD_DIR = path.join(DATA_ROOT, 'app', 'my-life-db', 'uploads');

// Ensure upload directory exists
if (!existsSync(UPLOAD_DIR)) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

// Configure tus server
const tusServer = new Server({
  path: '/api/upload/tus',
  datastore: new FileStore({ directory: UPLOAD_DIR }),
});

// Export handleWeb directly - this is the recommended approach for Next.js App Router
const handler = tusServer.handleWeb.bind(tusServer);

export {
  handler as GET,
  handler as POST,
  handler as PATCH,
  handler as HEAD,
  handler as OPTIONS,
  handler as DELETE,
};
